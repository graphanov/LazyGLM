// Ultrawork verified-completion loop. Wraps runAgent in an iteration loop:
// each iteration runs the agent; if it calls finish, an independent verifier
// checks the claim against reality (claimed files exist + an optional verify
// command passes). Only a verified PASS exits the loop. Bounded by
// maxIterations to prevent runaway.
import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolvePath } from "./util.js";
import { runAgent } from "./agent/runtime.js";
import { loadPlugins } from "./plugins/index.js";

const execP = promisify(exec);

const FILE_RE = /[\w./@-]+\.(js|mjs|cjs|ts|tsx|jsx|html|htm|css|scss|json|md|py|go|rs|java|c|cpp|h|hpp|rb|php|cs|swift|kt|glb|gltf|png|jpg|webp|svg|wasm|toml|yaml|yml|sh)/g;

/**
 * Verify a finish claim: claimed files exist + optional verifyCommand passes.
 * @returns {{pass:boolean, reason:string, evidence:string}}
 */
export async function verifyFinish({ summary, cwd, verifyCommand }) {
  const evidence = [];
  const summaryStr = typeof summary === "string" ? summary : "";

  // 1. claimed files exist
  const claimed = [...new Set([...summaryStr.matchAll(FILE_RE)].map((m) => m[0]))];
  const missing = [];
  for (const c of claimed.slice(0, 40)) {
    try {
      if (!existsSync(resolvePath(c, cwd))) missing.push(c);
    } catch {}
  }
  if (missing.length) {
    return { pass: false, reason: `finish summary references missing files: ${missing.slice(0, 10).join(", ")}`, evidence: "file-existence check" };
  }
  evidence.push(`${claimed.length} referenced file(s) all exist.`);

  // 2. optional verify command (e.g. "npm test", "node -e ...")
  if (verifyCommand) {
    try {
      const { stdout, stderr } = await execP(verifyCommand, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
      const out = (stdout + stderr).trim().slice(-600);
      evidence.push(`verify command exited 0:\n${out}`);
      return { pass: true, reason: "verify command passed", evidence: evidence.join("\n") };
    } catch (err) {
      const out = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trim().slice(-600);
      return { pass: false, reason: `verify command failed (exit ${err.code ?? "?"}):\n${out}`, evidence: evidence.join("\n") };
    }
  }

  // 3. no verify command: pass on file-existence only, but flag as unverified-by-command
  return { pass: true, reason: "file-existence check passed (no verify command configured)", evidence: evidence.join("\n") };
}

/**
 * Run the Ultrawork loop. Re-invokes the agent until verification passes or
 * maxIterations is hit.
 */
export async function runUltrawork({
  task,
  cwd,
  model,
  config,
  completionPromise,
  verifyCommand,
  maxIterations = 4,
  maxTurns = 80,
  onEvent = () => {},
}) {
  const promise = completionPromise || "the task is fully implemented and builds cleanly.";
  let currentTask = `${task}\n\n[ULTRAWORK] Completion promise: ${promise}`;
  const history = [];

  for (let i = 1; i <= maxIterations; i++) {
    onEvent({ type: "ultrawork_iteration", iteration: i, max: maxIterations });
    const res = await runAgent({
      task: currentTask,
      cwd,
      model,
      config,
      plugins: loadPlugins(),
      maxTurns,
      systemPromptExtra: `ULTRAWORK iteration ${i}/${maxIterations}. Completion promise: "${promise}". Do not call finish until you have concrete evidence (passing build/test output, existing files).`,
      onEvent,
    });
    history.push(res);

    if (!res.finished) {
      currentTask = `[ULTRAWORK iteration ${i + 1}] The previous run stopped without finishing. Continue the task. Completion promise: ${promise}`;
      continue;
    }

    const verdict = await verifyFinish({ summary: res.finishSummary, cwd, verifyCommand });
    onEvent({ type: "ultrawork_verify", iteration: i, pass: verdict.pass, reason: verdict.reason });
    if (verdict.pass) {
      return { verified: true, iterations: i, verdict, history, finishSummary: res.finishSummary };
    }
    currentTask = `[ULTRAWORK iteration ${i + 1}] Previous iteration claimed finish but verification FAILED:\n${verdict.reason}\n\nAddress the failure and complete the task. Completion promise: ${promise}`;
  }

  return { verified: false, iterations: maxIterations, verdict: history[history.length - 1] ? { pass: false, reason: "max iterations reached without verified completion" } : null, history };
}
