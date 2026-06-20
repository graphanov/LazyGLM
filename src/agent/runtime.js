// The GLM agent runtime: a tool-use loop that drives a GLM model through
// read/write/patch/shell tools with the full hook lifecycle firing around
// every action. This is the clean-room replacement for the Codex CLI runner.
import { join, dirname } from "node:path";
import { appendFile } from "node:fs/promises";
import { chat, resolveProviderConfig } from "./provider.js";
import { TOOL_SPECS, TOOL_HANDLERS } from "./tools.js";
import { Context } from "./context.js";
import { HookEngine } from "../hooks/engine.js";
import { gitInfo, truncate, ensureDir, nowIso } from "../util.js";

const BASE_SYSTEM_PROMPT = `You are LazyGLM, an autonomous software engineering agent driven by a GLM model. You operate inside a real project directory on the user's machine via tools.

WORKING RULES
- Think in small, verifiable steps. Read before you write. Prefer patch_file for edits, write_file for new files.
- After making changes, run builds/tests with run_shell to verify. Never claim success without verifying.
- Use grep/list_dir/read_file to orient yourself; do not guess file contents.
- When the task is fully done and verified, call the finish tool once with a concise summary and verification instructions. Do not call finish otherwise.
- Do not narrate at length between tool calls. Act, verify, continue.
- Keep file contents complete and correct — never leave placeholders or TODOs in shipped code.

You have these tools: read_file, write_file, patch_file, list_dir, grep, run_shell, finish.`;

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
 * @param {object} opts
 * @returns {Promise<{sessionId, turns, tokensIn, tokensOut, compactions, transcriptPath, finished}>}
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
    budget = 24_000,
    temperature,
    systemPromptExtra = "",
    onEvent = () => {},
  } = opts;

  const providerConfig = config || resolveProviderConfig({ model });
  const resolvedModel = model || providerConfig.model;
  if (!resolvedModel) {
    throw new Error("No GLM model resolved. Set LAZYGLM_MODEL, pass --model, or configure config/model-catalog.json.");
  }

  const engine = hooks || new HookEngine({ cwd, log: (m) => onEvent({ type: "log", message: m }) });
  for (const p of plugins) engine.register(p);

  const sessionId = engine.sessionId;
  const transcriptPath = join(cwd, ".lazyglm", "sessions", `${sessionId}.jsonl`);
  await ensureDir(dirname(transcriptPath));
  engine.setMeta({ model: resolvedModel, transcriptPath, permissionMode: "auto" });

  const ctx = new Context({ model: resolvedModel, budget });
  const filesWritten = new Set();
  const log = async (obj) => {
    onEvent(obj);
    try {
      await appendFile(transcriptPath, JSON.stringify({ t: nowIso(), ...obj }) + "\n", "utf8");
    } catch {}
  };

  onEvent({ type: "start", sessionId, model: resolvedModel, cwd, task });

  // 1. SessionStart
  const startRes = await engine.fire("SessionStart", {});
  const gi = gitInfo(cwd);
  const system = buildSystemPrompt({ cwd, git: gi, model: resolvedModel, injects: startRes.injects, extra: systemPromptExtra });
  ctx.setSystem(system);
  await log({ type: "system_prompt_chars", chars: system.length });

  // 2. UserPromptSubmit
  const upsRes = await engine.fire("UserPromptSubmit", { prompt: task });
  let userContent = task;
  if (upsRes.injects.length) userContent = `${upsRes.injects.join("\n\n")}\n\n---\n\nTASK\n${task}`;
  ctx.push({ role: "user", content: userContent });
  await log({ type: "user", content: task });

  let finished = false;
  let finishSummary = null;
  let lastNoToolNudge = false;

  // 3. main loop
  for (let turn = 1; turn <= maxTurns; turn++) {
    const compacted = await ctx.maybeCompact({
      onCompact: async ({ compactionCount }) => {
        await engine.fire("PostCompact", { compactionCount });
        await log({ type: "compact", compactionCount });
      },
    });

    let resp;
    try {
      resp = await chat({
        model: resolvedModel,
        messages: ctx.messages,
        tools: TOOL_SPECS,
        temperature,
        config: providerConfig,
      });
    } catch (err) {
      await log({ type: "error", message: err.message, turn });
      throw err;
    }
    ctx.recordUsage(resp.usage);
    await log({ type: "usage", usage: resp.usage, turn });

    const assistantMsg = {
      role: "assistant",
      content: resp.content || "",
    };
    if (resp.tool_calls?.length) {
      assistantMsg.tool_calls = resp.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));
    }
    ctx.push(assistantMsg);
    if (resp.content) await log({ type: "assistant_text", content: truncate(resp.content, 1500), turn });
    for (const tc of resp.tool_calls || []) {
      await log({ type: "tool_call", name: tc.name, input: truncate(JSON.stringify(tc.arguments), 800), turn });
    }

    // No tool call: model produced a textual response.
    if (!resp.tool_calls || resp.tool_calls.length === 0) {
      if (lastNoToolNudge) {
        // Second consecutive text-only response -> treat as natural stop.
        await engine.fire("Stop", { response: resp.content, finished: false, files_written: [...filesWritten] });
        await log({ type: "stop", reason: "text-only-no-finish", turn });
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
    for (const tc of resp.tool_calls) {
      const handler = TOOL_HANDLERS[tc.name];
      if (!handler) {
        ctx.push({ role: "tool", tool_call_id: tc.id, content: `Error: unknown tool '${tc.name}'. Available: read_file, write_file, patch_file, list_dir, grep, run_shell, finish.` });
        continue;
      }

      const pre = await engine.fire("PreToolUse", {
        tool_name: tc.name,
        tool_input: tc.arguments,
        tool_use_id: tc.id,
      });

      let resultStr;
      if (pre.blocks.length) {
        resultStr = `Blocked by hook:\n${pre.blocks.join("\n")}\nDo not retry the same action without addressing the blocker.`;
        await log({ type: "blocked", tool: tc.name, reasons: pre.blocks, turn });
      } else {
        let result;
        try {
          result = await handler(tc.arguments, { cwd, runtime: { engine, ctx, log } });
        } catch (err) {
          result = `Error executing ${tc.name}: ${err?.message || err}`;
        }
        if ((tc.name === "write_file" || tc.name === "patch_file") && typeof tc.arguments?.path === "string") {
          filesWritten.add(tc.arguments.path);
        }
        if (result && result.__finish) {
          finished = true;
          finishSummary = result.summary;
          resultStr = `finish acknowledged: ${result.summary}`;
        } else {
          resultStr = typeof result === "string" ? result : JSON.stringify(result);
        }
        const post = await engine.fire("PostToolUse", {
          tool_name: tc.name,
          tool_input: tc.arguments,
          tool_response: resultStr,
          tool_use_id: tc.id,
        });
        if (post.blocks.length) {
          resultStr += `\n\n[hook feedback — address this] ${post.blocks.join(" | ")}`;
        }
        if (post.feedbacks.length) {
          resultStr += `\n\n[hook note] ${post.feedbacks.join(" | ")}`;
        }
        await log({ type: "tool_result", name: tc.name, result: truncate(resultStr, 1200), turn });
      }

      ctx.push({ role: "tool", tool_call_id: tc.id, content: resultStr });
      if (finished) break;
    }

    if (finished) {
      await engine.fire("Stop", { response: finishSummary, finished: true, files_written: [...filesWritten] });
      await log({ type: "finish", summary: truncate(finishSummary, 1500), turn });
      break;
    }
  }

  if (!finished) {
    await engine.fire("Stop", { response: "(max turns reached)", finished: false, files_written: [...filesWritten] });
    await log({ type: "stop", reason: "max_turns", turn: maxTurns });
  }

  return {
    sessionId,
    turns: engine.turnId,
    tokensIn: ctx.totalTokensIn,
    tokensOut: ctx.totalTokensOut,
    compactions: ctx.compactionCount,
    transcriptPath,
    finished,
    finishSummary,
    filesWritten: [...filesWritten],
  };
}
