// The GLM agent runtime: a tool-use loop that drives a GLM model through
// read/write/patch/shell tools with the full hook lifecycle firing around
// every action. This is the clean-room replacement for the Codex CLI runner.
import { join, dirname } from "node:path";
import { appendFile } from "node:fs/promises";
import { chat, resolveProviderConfig, shouldPreserveThinking } from "./provider.js";
import { detectRole, findCatalogModelEntry, loadCatalog, resolveContextBudget } from "./router.js";
import { TOOL_SPECS, TOOL_HANDLERS } from "./tools.js";
import { Context, assistantMessageFrom } from "./context.js";
import { HookEngine } from "../hooks/engine.js";
import { gitInfo, truncate, ensureDir, nowIso } from "../util.js";
import { abortReason, composeAbortSignals, isDeadlineError, throwIfAborted, withAbort } from "./deadline.js";
import { isToolErrorResult } from "./tool-errors.js";
import { buildRuntimePrompt } from "../prompt.js";
import type {
  ChatCompletion,
  ChatUsage,
  FinishToolResult,
  HookEngineContract,
  HookEventName,
  HookFireResult,
  RunAgentOptions,
  RunAgentResult,
  ToolExecutionRecord,
  ToolHandlerResult,
} from "../types/index.js";

interface CompactInfo {
  compactionCount: number;
  droppedTokens?: number;
}

interface RuntimeContext {
  messages: Array<Record<string, unknown>>;
  totalTokensIn: number;
  totalTokensOut: number;
  compactionCount: number;
  setSystem(text: string): void;
  push(message: Record<string, unknown>): void;
  maybeCompact(options?: {
    force?: boolean;
    onCompact?: (info: CompactInfo) => string[] | Promise<string[]>;
  }): Promise<boolean>;
  recordUsage(usage?: ChatUsage | null): void;
}

type ContextConstructor = new (options?: {
  model?: string;
  budget?: number;
  preserveThinking?: boolean;
}) => RuntimeContext;

type HookEngineConstructor = new (options?: {
  cwd?: string;
  log?: (message: string) => void;
}) => HookEngineContract;

const RuntimeContextClass = Context as unknown as ContextConstructor;
const RuntimeHookEngine = HookEngine as unknown as HookEngineConstructor;
const toAssistantMessage = assistantMessageFrom as unknown as (response: ChatCompletion) => Record<string, unknown>;

function emptyHookResult(): HookFireResult {
  return { blocks: [], injects: [], feedbacks: [], results: [] };
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const {
    task,
    cwd,
    model,
    config,
    plugins = [],
    hooks,
    maxTurns = 80,
    budget,
    temperature,
    systemPromptExtra = "",
    role,
    reasoningBudget = 0, // 0 = unlimited; soft cap on cumulative reasoning tokens
    onEvent = () => {},
    permissionMode = "auto",
    failOnToolBlock = false,
    deadline,
    signal,
  } = opts;
  const composedRunSignal = composeAbortSignals([deadline?.signal, signal]);
  const runSignal = composedRunSignal.signal;
  const checkAbort = () => {
    deadline?.throwIfExpired?.();
    throwIfAborted(runSignal);
  };

  checkAbort();
  // Route to the right model: auto-detect role from the task unless given.
  const detectedRole = role || detectRole(task);
  const providerConfig = config || await resolveProviderConfig({ model, role: detectedRole });
  const resolvedModel = providerConfig.modelId || model;
  if (!resolvedModel) {
    throw new Error("No GLM model resolved. Set LAZYGLM_MODEL, pass --model, or configure config/model-catalog.json.");
  }
  const catalog = await loadCatalog();
  const catalogModel = providerConfig.model || model || resolvedModel;
  const catalogEntry = findCatalogModelEntry(catalogModel, catalog);
  const contextBudget = budget ?? resolveContextBudget(catalogModel, catalog);

  const hookLog = (message: string): void => onEvent({ type: "log", message });
  const engine: HookEngineContract = hooks || new RuntimeHookEngine({ cwd, log: hookLog });
  for (const p of plugins) engine.register(p);

  const sessionId = engine.sessionId;
  const transcriptPath = join(cwd, ".lazyglm", "sessions", `${sessionId}.jsonl`);
  await ensureDir(dirname(transcriptPath));
  engine.setMeta({ model: resolvedModel, transcriptPath, permissionMode });

  const ctx = new RuntimeContextClass({ model: resolvedModel, budget: contextBudget, preserveThinking: shouldPreserveThinking(providerConfig.provider) });
  const filesWritten = new Set<string>();
  const toolCalls: ToolExecutionRecord[] = [];
  let totalReasoningTokens = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let agentTurns = 0;
  let finished = false;
  let finishSummary: string | null = null;
  let finishReason: string | null = null;
  let errorMessage: string | null = null;
  let lastNoToolNudge = false;

  const log = async (obj: Record<string, unknown>): Promise<void> => {
    onEvent(obj);
    try {
      await appendFile(transcriptPath, JSON.stringify({ t: nowIso(), ...obj }) + "\n", "utf8");
    } catch {}
  };
  const fireRunHook = (event: HookEventName, fields: Record<string, unknown> = {}): Promise<HookFireResult> => (
    Promise.resolve(engine.fire(event, fields, { signal: runSignal }))
  );
  const fireStopHook = (fields: Record<string, unknown>): Promise<HookFireResult> => {
    if (runSignal?.aborted) return Promise.resolve(emptyHookResult());
    return fireRunHook("Stop", fields);
  };

  const buildResult = (): RunAgentResult => ({
    sessionId,
    turns: agentTurns,
    tokensIn: ctx.totalTokensIn,
    tokensOut: ctx.totalTokensOut,
    reasoningTokens: totalReasoningTokens,
    promptTokens: totalPromptTokens,
    completionTokens: totalCompletionTokens,
    compactions: ctx.compactionCount,
    transcriptPath,
    finished,
    finishReason: finished ? "finished" : (finishReason || "max_turns"),
    finishSummary,
    result: finishSummary,
    toolCalls,
    filesWritten: [...filesWritten],
    errorMessage,
  });

  onEvent({ type: "start", sessionId, model: resolvedModel, provider: providerConfig.provider, role: detectedRole, cwd, task });

  try {
    checkAbort();
    // 1. SessionStart
    const startRes = await fireRunHook("SessionStart", {});
    const gi = gitInfo(cwd);
    const system = buildRuntimePrompt({
      cwd,
      git: gi,
      model: resolvedModel,
      injects: startRes.injects,
      extra: systemPromptExtra,
      tier: catalogEntry?.tier,
      contextWindow: catalogEntry?.context_window ?? catalogEntry?.context,
      description: catalogEntry?.description,
    });
    ctx.setSystem(system);
    await log({ type: "system_prompt_chars", chars: system.length });

    checkAbort();
    // 2. UserPromptSubmit
    const upsRes = await fireRunHook("UserPromptSubmit", { prompt: task });
    let userContent = task;
    if (upsRes.injects.length) userContent = `${upsRes.injects.join("\n\n")}\n\n---\n\nTASK\n${task}`;
    ctx.push({ role: "user", content: userContent });
    await log({ type: "user", content: task });

    // 3. main loop
    for (let turn = 1; turn <= maxTurns; turn++) {
      checkAbort();
      agentTurns = turn;
      const onCompact = async ({ compactionCount }: CompactInfo): Promise<string[]> => {
        const res = await fireRunHook("PostCompact", { compactionCount });
        await log({ type: "compact", compactionCount });
        return res?.injects || [];
      };
      const compacted = await ctx.maybeCompact({ onCompact });
      void compacted;

      let resp: ChatCompletion;
      try {
        resp = await chat({
          model: resolvedModel,
          messages: ctx.messages,
          tools: TOOL_SPECS,
          temperature,
          config: providerConfig,
          signal: runSignal,
          onDelta: (d) => {
            if (d.type === "text") {
              onEvent({ type: "assistant_delta", text: d.text, turn });
            } else if (d.type === "reasoning") {
              onEvent({ type: "reasoning_delta", text: d.text, turn });
            } else if (d.type === "tool_call_start") {
              onEvent({ type: "tool_call_start", name: d.name, id: d.id, turn });
            }
          },
          onRetry: (r) => {
            onEvent({ type: "retry", attempt: r.attempt, reason: r.reason, delay: r.delay, turn });
          },
        });
      } catch (err) {
        if (isDeadlineError(err) || runSignal?.aborted) {
          finishReason = "timeout";
          errorMessage = abortReason(runSignal, abortFallback(err)).message;
        } else {
          finishReason = "error";
          errorMessage = errorMessageOf(err);
        }
        await log({ type: "error", message: errorMessage, turn });
        break;
      }
      ctx.recordUsage(resp.usage);
      const u: ChatUsage = resp.usage || {};
      const reasoningTokens = u.completion_tokens_details?.reasoning_tokens || u.reasoning_tokens || 0;
      totalReasoningTokens += reasoningTokens;
      totalPromptTokens += u.prompt_tokens || 0;
      totalCompletionTokens += u.completion_tokens || 0;
      await log({ type: "usage", usage: resp.usage, turn, cumulative: { prompt: totalPromptTokens, completion: totalCompletionTokens, reasoning: totalReasoningTokens } });

      // Soft reasoning budget: warn, then stop if exceeded.
      if (reasoningBudget > 0 && totalReasoningTokens > reasoningBudget) {
        finishReason = "reasoning_budget";
        onEvent({ type: "reasoning_budget_exceeded", budget: reasoningBudget, used: totalReasoningTokens, turn });
        break;
      }

      ctx.push(toAssistantMessage(resp));
      if (resp.content) await log({ type: "assistant_text", content: truncate(resp.content, 1500), turn });
      for (const tc of resp.tool_calls || []) {
        await log({ type: "tool_call", name: tc.name, input: truncate(JSON.stringify(tc.arguments), 800), turn });
      }

      // No tool call: model produced a textual response.
      if (!resp.tool_calls || resp.tool_calls.length === 0) {
        if (lastNoToolNudge) {
          // Second consecutive text-only response -> deterministic non-success stop.
          finishReason = "text_only_no_finish";
          await log({ type: "stop", reason: "text_only_no_finish", turn });
          break;
        }
        lastNoToolNudge = true;
        ctx.push({
          role: "user",
          content:
            "You responded without using a tool. If the task is complete, call the finish tool with a summary and verification steps. Otherwise, continue working with tools. Do not just describe what you would do — do it.",
        });
        continue;
      }
      lastNoToolNudge = false;

      // Execute each tool call in order, firing Pre/PostToolUse hooks.
      let stopToolLoop = false;
      for (const tc of resp.tool_calls) {
        checkAbort();
        const toolName = tc.name || "unknown";
        const record: ToolExecutionRecord = { name: toolName, turn, status: "ok" };
        toolCalls.push(record);
        const handler = TOOL_HANDLERS[toolName];
        if (!handler) {
          record.status = "error";
          ctx.push({ role: "tool", tool_call_id: tc.id, content: `Error: unknown tool '${tc.name}'. Available: read_file, write_file, patch_file, list_dir, grep, run_shell, finish.` });
          continue;
        }

        let pre: HookFireResult;
        try {
          pre = await fireRunHook("PreToolUse", {
            tool_name: tc.name,
            tool_input: tc.arguments,
            tool_use_id: tc.id,
          });
        } catch (err) {
          if (isDeadlineError(err) || runSignal?.aborted) record.status = "timeout";
          throw err;
        }

        let resultStr;
        if (pre.blocks.length) {
          record.status = "denied";
          resultStr = `Blocked by hook:\n${pre.blocks.join("\n")}\nDo not retry the same action without addressing the blocker.`;
          await log({ type: "blocked", tool: tc.name, reasons: pre.blocks, turn });
          ctx.push({ role: "tool", tool_call_id: tc.id, content: resultStr });
          if (failOnToolBlock) {
            finishReason = "tool_denied";
            stopToolLoop = true;
            break;
          }
          continue;
        }

        let result: ToolHandlerResult;
        let handlerThrew = false;
        try {
          result = await withAbort(handler(tc.arguments, { cwd, runtime: { engine, ctx, log, deadline, signal: runSignal } }), runSignal);
        } catch (err) {
          if (isDeadlineError(err) || runSignal?.aborted) {
            record.status = "timeout";
            throw abortReason(runSignal, abortFallback(err));
          }
          handlerThrew = true;
          result = `Error executing ${tc.name}: ${errorMessageOf(err)}`;
        }
        if ((tc.name === "write_file" || tc.name === "patch_file") && typeof tc.arguments?.path === "string") {
          filesWritten.add(tc.arguments.path);
        }

        let finishCandidate = false;
        let candidateSummary: string | null = null;
        if (isFinishToolResult(result)) {
          finishCandidate = true;
          candidateSummary = result.summary;
          resultStr = `finish acknowledged: ${candidateSummary}`;
        } else {
          resultStr = typeof result === "string" ? result : JSON.stringify(result);
        }

        let post: HookFireResult;
        try {
          post = await fireRunHook("PostToolUse", {
            tool_name: tc.name,
            tool_input: tc.arguments,
            tool_response: resultStr,
            tool_use_id: tc.id,
          });
        } catch (err) {
          if (isDeadlineError(err) || runSignal?.aborted) record.status = "timeout";
          throw err;
        }
        if (post.blocks.length) {
          record.status = "denied";
          resultStr += `\n\n[hook feedback — address this] ${post.blocks.join(" | ")}`;
          await log({ type: "blocked", tool: tc.name, reasons: post.blocks, turn });
        }
        if (post.feedbacks.length) {
          resultStr += `\n\n[hook note] ${post.feedbacks.join(" | ")}`;
        }
        if (!post.blocks.length && finishCandidate) {
          record.status = "finish";
          finished = true;
          finishSummary = candidateSummary;
        } else if (!post.blocks.length && (handlerThrew || isToolErrorResult(resultStr))) {
          record.status = "error";
        }
        await log({ type: "tool_result", name: tc.name, result: truncate(resultStr, 1200), turn });

        ctx.push({ role: "tool", tool_call_id: tc.id, content: resultStr });
        if (post.blocks.length && failOnToolBlock) {
          finishReason = "tool_denied";
          stopToolLoop = true;
          break;
        }
        if (finished) {
          stopToolLoop = true;
          break;
        }
      }

      if (stopToolLoop) break;
    }
  } catch (err) {
    if (isDeadlineError(err) || runSignal?.aborted) {
      finishReason = "timeout";
      errorMessage = abortReason(runSignal, abortFallback(err)).message;
    } else {
      finishReason = "error";
      errorMessage = errorMessageOf(err);
    }
    await log({ type: "error", message: errorMessage });
  }

  if (finished) {
    await fireStopHook({ response: finishSummary, finished: true, files_written: [...filesWritten] });
    await log({ type: "finish", summary: truncate(finishSummary, 1500), turn: agentTurns });
  } else {
    if (!finishReason) finishReason = agentTurns >= maxTurns ? "max_turns" : "error";
    const response = finishReason === "timeout" ? "(timeout)" : finishReason === "max_turns" ? "(max turns reached)" : `(${finishReason})`;
    await fireStopHook({ response, finished: false, files_written: [...filesWritten] });
    await log({ type: "stop", reason: finishReason, turn: agentTurns || maxTurns });
  }

  composedRunSignal.cancel();
  return buildResult();
}

/**
 */
function isFinishToolResult(result: unknown): result is FinishToolResult {
  return !!(result && typeof result === "object" && "__finish" in result && result.__finish === true);
}

function errorMessageOf(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && err.message) return String(err.message);
  return String(err);
}

function abortFallback(err: unknown): Error | undefined {
  return err instanceof Error ? err : undefined;
}
