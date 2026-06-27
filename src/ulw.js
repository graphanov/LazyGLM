// Ultrawork verified-completion loop. Wraps runAgent in an iteration loop:
// each iteration runs the agent; if it calls finish, an independent verifier
// checks the claim against reality (claimed files exist + an optional verify
// command passes). Only a verified PASS exits the loop. Bounded by
// maxIterations to prevent runaway.
import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolvePath } from "./util.js";
import { abortReason, boundedTimeoutMs, composeAbortSignals, isDeadlineError } from "./agent/deadline.js";
import { runAgent } from "./agent/runtime.js";
import { loadPlugins } from "./plugins/index.js";

const execP = promisify(exec);

/**
 * Verify a finish claim: files the agent actually wrote still exist + an
 * optional verifyCommand passes.
 * @returns {{pass:boolean, reason:string, evidence:string}}
 */
export async function verifyFinish({ summary, cwd, verifyCommand, filesWritten, deadline, signal }) {
  const evidence = [];
  deadline?.throwIfExpired?.();
  const runAbort = composeAbortSignals([deadline?.signal, signal]);
  const runSignal = runAbort.signal;

  // 1. files the agent wrote via tools must still exist (robust: tracked, not
  //    regex-extracted from prose, which would false-match CDN specifiers).
  const written = Array.isArray(filesWritten) ? filesWritten : [];
  const missingWritten = [];
  for (const rel of written) {
    try {
      if (!existsSync(resolvePath(rel, cwd))) missingWritten.push(rel);
    } catch {}
  }
  if (missingWritten.length) {
    runAbort.cancel();
    return { pass: false, reason: `files written during the run are now missing: ${missingWritten.join(", ")}`, evidence: "written-file check" };
  }
  if (written.length) evidence.push(`${written.length} written file(s) all exist.`);

  // 2. optional verify command (e.g. "npm test", "node -e ...", static greps)
  if (verifyCommand) {
    try {
      const { stdout, stderr } = await execP(verifyCommand, {
        cwd,
        timeout: boundedTimeoutMs(120_000, deadline),
        signal: runSignal,
        maxBuffer: 4 * 1024 * 1024,
      });
      const out = (stdout + stderr).trim().slice(-600);
      evidence.push(`verify command exited 0:\n${out}`);
      return { pass: true, reason: "verify command passed", evidence: evidence.join("\n") };
    } catch (err) {
      if (isDeadlineError(err) || runSignal?.aborted) throw abortReason(runSignal, err);
      const out = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trim().slice(-600);
      return { pass: false, reason: `verify command failed (exit ${err.code ?? "?"}):\n${out}`, evidence: evidence.join("\n") };
    } finally {
      runAbort.cancel();
    }
  }

  runAbort.cancel();

  // 3. no verify command and no written files: nothing to check, pass optimistically
  return { pass: true, reason: written.length ? "written-file check passed (no verify command configured)" : "no files tracked and no verify command configured", evidence: evidence.join("\n") };
}

/**
 * Run the Ultrawork loop. Re-invokes the agent until verification passes or
 * maxIterations is hit.
 */
export async function runUltrawork({
  task,
  cwd,
  model,
  role,
  config,
  completionPromise,
  verifyCommand,
  maxIterations = 4,
  maxTurns = 80,
  budget,
  reasoningBudget = 0,
  onEvent = () => {},
  permissionMode = "auto",
  failOnToolBlock = false,
  plugins,
  deadline,
  signal,
}) {
  const promise = completionPromise || "the task is fully implemented and builds cleanly.";
  let currentTask = `${task}\n\n[ULTRAWORK] Completion promise: ${promise}`;
  const history = [];

  for (let i = 1; i <= maxIterations; i++) {
    try {
      deadline?.throwIfExpired?.();
    } catch (err) {
      return { verified: false, iterations: i - 1, verdict: { pass: false, reason: err?.message || String(err) }, history, finishReason: "timeout", errorMessage: err?.message || String(err) };
    }
    onEvent({ type: "ultrawork_iteration", iteration: i, max: maxIterations });
    const res = await runAgent({
      task: currentTask,
      cwd,
      model,
      role: role || "ultrabrain",
      config,
      plugins: plugins || loadPlugins(),
      maxTurns,
      budget,
      reasoningBudget,
      systemPromptExtra: `ULTRAWORK iteration ${i}/${maxIterations}. Completion promise: "${promise}". Do not call finish until you have concrete evidence (passing build/test output, existing files).`,
      permissionMode,
      failOnToolBlock,
      deadline,
      signal,
      onEvent,
    });
    history.push(res);

    if (res.finishReason === "timeout") {
      return { verified: false, iterations: i, verdict: { pass: false, reason: res.errorMessage || "timeout" }, history, finishReason: "timeout", errorMessage: res.errorMessage || "timeout" };
    }

    if (res.finishReason === "tool_denied") {
      return { verified: false, iterations: i, verdict: { pass: false, reason: "tool denied by policy hook" }, history, finishReason: "tool_denied" };
    }

    if (res.finishReason === "error") {
      return { verified: false, iterations: i, verdict: { pass: false, reason: res.errorMessage || "runtime error" }, history, finishReason: "error", errorMessage: res.errorMessage || "runtime error" };
    }

    if (res.finishReason === "reasoning_budget") {
      const used = Number(res.reasoningTokens || 0);
      const reason = reasoningBudget > 0
        ? `reasoning budget exceeded (${used}/${reasoningBudget} tokens)`
        : "reasoning budget exceeded";
      return { verified: false, iterations: i, verdict: { pass: false, reason }, history, finishReason: "reasoning_budget" };
    }

    if (!res.finished) {
      currentTask = `[ULTRAWORK iteration ${i + 1}] The previous run stopped without finishing (${res.finishReason}). Continue the task. Completion promise: ${promise}`;
      continue;
    }

    let verdict;
    try {
      verdict = await verifyFinish({ summary: res.finishSummary, cwd, verifyCommand, filesWritten: res.filesWritten, deadline, signal });
    } catch (err) {
      if (isDeadlineError(err) || deadline?.signal?.aborted || signal?.aborted) {
        const message = abortReason(deadline?.signal || signal, err).message;
        return { verified: false, iterations: i, verdict: { pass: false, reason: message }, history, finishReason: "timeout", errorMessage: message };
      }
      throw err;
    }
    onEvent({ type: "ultrawork_verify", iteration: i, pass: verdict.pass, reason: verdict.reason });
    if (verdict.pass) {
      return { verified: true, iterations: i, verdict, history, finishSummary: res.finishSummary, finishReason: "finished" };
    }
    currentTask = `[ULTRAWORK iteration ${i + 1}] Previous iteration claimed finish but verification FAILED:\n${verdict.reason}\n\nAddress the failure and complete the task. Completion promise: ${promise}`;
  }

  return { verified: false, iterations: maxIterations, verdict: history[history.length - 1] ? { pass: false, reason: "max iterations reached without verified completion" } : null, history, finishReason: "max_iterations" };
}
