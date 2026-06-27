// @ts-check

// The GLM agent runtime: a tool-use loop that drives a GLM model through
// read/write/patch/shell tools with the full hook lifecycle firing around
// every action. This is the clean-room replacement for the Codex CLI runner.
import { join, dirname } from "node:path";
import { appendFile } from "node:fs/promises";
import { chat, resolveProviderConfig, shouldPreserveThinking } from "./provider.js";
import { detectRole, loadCatalog, resolveContextBudget } from "./router.js";
import { TOOL_SPECS, TOOL_HANDLERS } from "./tools.js";
import { Context, assistantMessageFrom } from "./context.js";
import { HookEngine } from "../hooks/engine.js";
import { gitInfo, truncate, ensureDir, nowIso } from "../util.js";
import { abortReason, composeAbortSignals, isDeadlineError, throwIfAborted, withAbort } from "./deadline.js";

/**
 * @typedef {import("../types/index.js").ChatUsage} ChatUsage
 * @typedef {import("../types/index.js").FinishToolResult} FinishToolResult
 * @typedef {import("../types/index.js").HookEngineContract} HookEngineContract
 * @typedef {import("../types/index.js").HookEventName} HookEventName
 * @typedef {import("../types/index.js").RunAgentOptions} RunAgentOptions
 * @typedef {import("../types/index.js").RunAgentResult} RunAgentResult
 * @typedef {import("../types/index.js").ToolExecutionRecord} ToolExecutionRecord
 * @typedef {import("../types/index.js").ToolHandler} ToolHandler
 *
 * @typedef {{ isRepo: boolean, branch?: string, root?: string }} RuntimeGitInfo
 * @typedef {{ cwd: string, git: RuntimeGitInfo, model: string, injects?: string[], extra?: string }} SystemPromptOptions
 */

const BASE_SYSTEM_PROMPT = `You are LazyGLM, an autonomous software engineering agent driven by a GLM model. You operate inside a real project directory on the user's machine via tools.

WORKING RULES
- Think in small, verifiable steps. Read before you write. Prefer patch_file for edits, write_file for new files.
- After making changes, run builds/tests with run_shell to verify. Never claim success without verifying.
- Use grep/list_dir/read_file to orient yourself; do not guess file contents.
- When the task is fully done and verified, call the finish tool once with a concise summary and verification instructions. Do not call finish otherwise.
- Do not narrate at length between tool calls. Act, verify, continue.
- Keep file contents complete and correct — never leave placeholders or TODOs in shipped code.

You have these tools: read_file, write_file, patch_file, list_dir, grep, run_shell, finish.`;

/**
 * @param {SystemPromptOptions} options
 * @returns {string}
 */
function buildSystemPrompt({ cwd, git, model, injects, extra }) {
  const parts = [BASE_SYSTEM_PROMPT];
  parts.push(
    `\nENVIRONMENT\n- cwd: ${cwd}\n- git: ${git.isRepo ? `${git.branch} @ ${git.root}` : "(not a repo)"}\n- model: ${model}\n- date: ${nowIso()}\n- os: ${process.platform}`,
  );
  if (injects && injects.length) {
    parts.push(`\nPROJECT CONTEXT (injected by hooks)\n${injects.join("\n\n")}`);
  }
  if (extra) parts.push(`\n${extra}`);
  return parts.join("\n");
}

/**
 * Run the GLM agent on a task.
 * @param {RunAgentOptions} opts
 * @returns {Promise<RunAgentResult>}
 */
export async function runAgent(opts) {
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
  const contextBudget = budget ?? resolveContextBudget(providerConfig.model || model || resolvedModel, await loadCatalog());

  /** @param {string} message */
  const hookLog = (message) => onEvent({ type: "log", message });
  const engine = /** @type {HookEngineContract} */ (hooks || new HookEngine(/** @type {any} */ ({ cwd, log: hookLog })));
  for (const p of plugins) engine.register(p);

  const sessionId = engine.sessionId;
  const transcriptPath = join(cwd, ".lazyglm", "sessions", `${sessionId}.jsonl`);
  await ensureDir(dirname(transcriptPath));
  engine.setMeta({ model: resolvedModel, transcriptPath, permissionMode });

  const ctx = new Context({ model: resolvedModel, budget: contextBudget, preserveThinking: shouldPreserveThinking(providerConfig.provider) });
  /** @type {Set<string>} */
  const filesWritten = new Set();
  /** @type {ToolExecutionRecord[]} */
  const toolCalls = [];
  let totalReasoningTokens = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let agentTurns = 0;
  let finished = false;
  /** @type {string | null} */
  let finishSummary = null;
  /** @type {string | null} */
  let finishReason = null;
  /** @type {string | null} */
  let errorMessage = null;
  let lastNoToolNudge = false;

  /**
   * @param {Record<string, unknown>} obj
   * @returns {Promise<void>}
   */
  const log = async (obj) => {
    onEvent(obj);
    try {
      await appendFile(transcriptPath, JSON.stringify({ t: nowIso(), ...obj }) + "\n", "utf8");
    } catch {}
  };
  /**
   * @param {HookEventName} event
   * @param {Record<string, unknown>} [fields]
   */
  const fireRunHook = (event, fields = {}) => engine.fire(event, fields, { signal: runSignal });
  /**
   * @param {Record<string, unknown>} fields
   */
  const fireStopHook = (fields) => {
    if (runSignal?.aborted) return { blocks: [], injects: [], feedbacks: [], results: [] };
    return fireRunHook("Stop", fields);
  };

  /** @returns {RunAgentResult} */
  const buildResult = () => ({
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
    const system = buildSystemPrompt({ cwd, git: gi, model: resolvedModel, injects: startRes.injects, extra: systemPromptExtra });
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
      /** @param {{ compactionCount: number }} compactInfo */
      const onCompact = async ({ compactionCount }) => {
        const res = await fireRunHook("PostCompact", { compactionCount });
        await log({ type: "compact", compactionCount });
        return res?.injects || [];
      };
      const compacted = await ctx.maybeCompact(/** @type {any} */ ({
        onCompact,
      }));
      void compacted;

      let resp;
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
      const u = /** @type {ChatUsage} */ (resp.usage || {});
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

      ctx.push(assistantMessageFrom(resp));
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
        const record = /** @type {ToolExecutionRecord} */ ({ name: toolName, turn, status: "ok" });
        toolCalls.push(record);
        const handler = /** @type {ToolHandler | undefined} */ (TOOL_HANDLERS[toolName]);
        if (!handler) {
          record.status = "error";
          ctx.push({ role: "tool", tool_call_id: tc.id, content: `Error: unknown tool '${tc.name}'. Available: read_file, write_file, patch_file, list_dir, grep, run_shell, finish.` });
          continue;
        }

        let pre;
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

        let result;
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

        const finishCandidate = isFinishToolResult(result);
        const candidateSummary = finishCandidate ? result.summary : null;
        if (finishCandidate) {
          resultStr = `finish acknowledged: ${candidateSummary}`;
        } else {
          resultStr = typeof result === "string" ? result : JSON.stringify(result);
        }

        let post;
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
 * @param {unknown} result
 * @returns {result is FinishToolResult}
 */
function isFinishToolResult(result) {
  return !!(result && typeof result === "object" && "__finish" in result && result.__finish);
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorMessageOf(err) {
  if (err && typeof err === "object" && "message" in err && err.message) return String(err.message);
  return String(err);
}

/**
 * @param {unknown} err
 * @returns {Error | undefined}
 */
function abortFallback(err) {
  return /** @type {Error | undefined} */ (err);
}

/**
 * @param {string | null | undefined} resultStr
 * @returns {boolean}
 */
function isToolErrorResult(resultStr) {
  return /^Error(?::| executing\b)/i.test(resultStr || "") || /^Command exited\b/i.test(resultStr || "");
}
