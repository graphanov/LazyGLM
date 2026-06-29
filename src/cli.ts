// CLI dispatcher: lazyglm <command> [args]
import { resolve } from "node:path";
import { install, uninstall } from "./installer.js";
import { doctor } from "./doctor.js";
import { checkUpdate, selfUpdate, describeUpdate } from "./update.js";
import { runAgent } from "./agent/runtime.js";
import { runUltrawork, verifyFinish } from "./ulw.js";
import { loadPlugins } from "./plugins/index.js";
import { loadSkills, listSkillNames, getSkill, detectSkillInvocation } from "./skills/index.js";
import { resolveProviderConfig, listModels } from "./agent/provider.js";
import { readJson } from "./util.js";
import { HookEngine } from "./hooks/engine.js";
import { createRunEventPrinter } from "./cli-output.js";
import { createDeadline, isDeadlineError } from "./agent/deadline.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  HookEventName,
  HookInput,
  PermissionMode,
  RoleName,
  RunAgentResult,
  ToolExecutionRecord,
} from "./types/index.js";
import type { VerifyFinishResult } from "./ulw.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type FlagValue = string | boolean | undefined;
type FlagMap = Record<string, FlagValue>;

interface ParsedFlags {
  flags: FlagMap;
  positional: string[];
}

interface ParseResult<T> {
  value?: T;
  error?: string;
}

interface VerificationSummary {
  pass: boolean;
  reason: string;
}

interface StructuredOutput {
  ok: boolean;
  result: string | null;
  finishReason: string;
  toolCalls: Array<{ name: string; turn: number; status: string }>;
  cost: {
    tokens: number;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
  };
  session: {
    id: string;
    transcriptPath: string;
    turns: number;
    compactions: number;
  } | null;
  verification?: VerificationSummary;
  error?: { message: string };
}

interface RunResultOverrides {
  finishReason?: string;
  verification?: VerificationSummary;
  errorMessage?: string | null;
}

interface UltraworkResultShape {
  verified?: boolean;
  iterations?: number;
  verdict?: Pick<VerifyFinishResult, "pass" | "reason"> | null;
  history?: RunAgentResult[];
  finishReason?: string;
  finishSummary?: string | null;
  errorMessage?: string | null;
}

function stringFlag(flags: FlagMap, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function toErrorMessage(err: unknown): string {
  return err && typeof err === "object" && "message" in err ? String((err as { message?: unknown }).message) : String(err);
}

function usage(): string {
  return `LazyGLM — the GLM-native agent harness.

Usage:
  lazyglm [chat] [options]             Launch the interactive REPL (default; self-sustained)
    --continue                         Resume the most recent session
    --yolo                             Bypass all permission gates (auto everywhere)
    --model <name>                     GLM model (default: glm-5.2 via z.ai)
    --provider <zai|nous|ollama>       Backend (default: zai; ollama=keyless local)
    --role <role>                      Force a routing role (manual override)
    --context-budget <tokens>          Override the catalog-derived soft context budget
  lazyglm run "<task>" [options]       Run the GLM agent on a task (one-shot, non-interactive)
  lazyglm install [--force]            Initialize .lazyglm/ + AGENTS.md in this project
  lazyglm uninstall                    Remove .lazyglm/ runtime state
  lazyglm doctor                       Health report (provider, model, plugins, skills)
  lazyglm update [--check] [--force]   Check for / install a newer LazyGLM release
  lazyglm models                       List available GLM models from the provider
  lazyglm run "<task>" [options]       Run the GLM agent on a task
    --model <name>                     GLM model (default: glm-5.2 via z.ai)
    --provider <zai|nous|ollama>       Backend (default: zai; ollama=keyless local)
    --role <role>                      Force a routing role (default|quick|planner|verifier|ultrabrain)
    --cwd <path>                       Working directory (default: .)
    --output-format <text|json>        text (default) or one JSON object on stdout
    --no-color                         Disable ANSI styling in text output
    --yolo                             Bypass all permission gates (auto everywhere)
    --max-turns <n>                    Max agent turns (default 80)
    --timeout <seconds>                Whole-run deadline (default 600; 0 disables)
    --context-budget <tokens>          Override the catalog-derived soft context budget
    --max-reasoning-tokens <n>         Soft cap on cumulative reasoning tokens (0=unlimited)
    --ultrawork                        Verified-completion loop mode ($ulw-loop)
    --max-iterations <n>               Max Ultrawork iterations (default 3)
    --completion-promise "<text>"      What 'done' means (ultrawork)
    --verify "<command>"               Shell command that must exit 0 after finish
  lazyglm skills                       List installed skills
  lazyglm skill <name>                 Print a skill's content
  lazyglm hook <event>                 Fire a hook event from stdin JSON (bridge)
  lazyglm --version
  lazyglm help

Environment:
  LAZYGLM_API_KEY    bearer token (REQUIRED for zai/nous; get it at z.ai)
  LAZYGLM_PROVIDER   zai (default) | nous | ollama (local, keyless)
  LAZYGLM_BASE_URL   override the endpoint for any OpenAI-compatible host
  LAZYGLM_MODEL      override the catalog default model
`;
}

function parseFlags(argv: string[]): ParsedFlags {
  const flags: FlagMap = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else { flags[key] = next; i++; }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(usage());
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    const pkg = await readJson<{ version?: string }>(join(ROOT, "package.json"), {});
    console.log(`lazyglm ${pkg?.version || "0.0.0"}`);
    return 0;
  }

  // Interactive REPL: `lazyglm`, `lazyglm chat`, or leading REPL flags
  // (e.g. `lazyglm --yolo`, `lazyglm --continue --model glm-4.7`).
  // `lazyglm run "..."` stays the one-shot non-interactive path.
  if (!cmd || cmd === "chat" || (cmd.startsWith("--") && !["--version", "--help", "-v", "-h"].includes(cmd))) {
    const { flags } = parseFlags(cmd === "chat" ? rest : argv);
    const contextBudget = parsePositiveIntegerFlag(flags["context-budget"], undefined, "--context-budget");
    if (contextBudget.error) {
      console.error(contextBudget.error);
      return 1;
    }
    const { launchREPL } = await import("./repl.js");
    return launchREPL({
      cwd: flags.cwd ? resolve(flags.cwd as string) : process.cwd(),
      flags: {
        continue: !!flags.continue,
        yolo: !!flags.yolo,
        model: stringFlag(flags, "model"),
        provider: stringFlag(flags, "provider"),
        role: stringFlag(flags, "role"),
        contextBudget: contextBudget.value,
      },
    });
  }

  switch (cmd) {
    case "install": {
      const { flags } = parseFlags(rest);
      const res = await install({ cwd: flags.cwd ? resolve(flags.cwd as string) : process.cwd(), force: !!flags.force });
      console.log(`LazyGLM installed in ${res.cwd}`);
      for (const c of res.created) console.log(`  + ${c}`);
      if (!res.git.isRepo) console.log("  (not a git repo — `git init` recommended)");
      console.log("\nNext: `lazyglm doctor` to verify the GLM provider, then `lazyglm run \"<task>\"`.");
      return 0;
    }
    case "uninstall": {
      const { flags } = parseFlags(rest);
      const res = await uninstall({ cwd: flags.cwd ? resolve(flags.cwd as string) : process.cwd() });
      console.log(`Removed from ${res.cwd}:`);
      for (const r of res.removed) console.log(`  - ${r}`);
      if (res.preserved?.length) {
        console.log("Preserved (user-owned/customized):");
        for (const p of res.preserved) console.log(`  ! ${p}`);
      }
      return 0;
    }
    case "doctor": {
      const { flags } = parseFlags(rest);
      const res = await doctor({ cwd: flags.cwd ? resolve(flags.cwd as string) : process.cwd() });
      console.log(`LazyGLM doctor — ${res.cwd}`);
      console.log(`Provider: ${res.provider.baseURL} | default model: ${res.provider.modelId}\n`);
      for (const c of res.checks) {
        const icon = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗";
        console.log(`  [${icon}] ${c.name}: ${c.detail}`);
      }
      console.log(`\n${res.summary}`);
      return res.checks.some((c) => c.status === "fail") ? 1 : 0;
    }
    case "update": {
      const { flags } = parseFlags(rest);
      if (flags.check) {
        const res = await checkUpdate();
        console.log(describeUpdate(res));
        return res.exitCode;
      }
      const res = await selfUpdate({ force: !!flags.force });
      return res.exitCode;
    }
    case "models": {
      try {
        const cfg = await resolveProviderConfig({ role: "default" });
        const models = await listModels(cfg);
        console.log(`Models at ${cfg.baseURL} (${cfg.provider}, ${models.length}):`);
        for (const m of models) console.log(`  ${m}`);
      } catch (e) {
        console.error(`Cannot list models: ${toErrorMessage(e)}`);
        return 1;
      }
      return 0;
    }
    case "skills": {
      await loadSkills();
      const names = listSkillNames();
      console.log(`Skills (${names.length}):`);
      for (const n of names) console.log(`  $${n}`);
      return 0;
    }
    case "skill": {
      const name = rest[0];
      if (!name) { console.error("usage: lazyglm skill <name>"); return 1; }
      await loadSkills();
      const s = getSkill(name);
      if (!s) { console.error(`unknown skill: ${name}`); return 1; }
      console.log(s.body);
      return 0;
    }
    case "hook": {
      // bridge: read stdin JSON, fire one event with all plugins
      const event = rest[0];
      const data = await readStdin();
      let input: Record<string, unknown>;
      try {
        const parsed = JSON.parse(data);
        input = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      } catch {
        input = {};
      }
      const cwd = typeof input.cwd === "string" ? resolve(input.cwd) : process.cwd();
      const engine = new HookEngine({ cwd });
      for (const p of loadPlugins()) engine.register(p);
      engine.setMeta({ model: typeof input.model === "string" ? input.model : "glm-4.7-flash" });
      // synthesize a single-fire: bypass fire's turn bookkeeping by calling handlers directly
      const api = engine.api();
      const out: Array<Record<string, unknown>> = [];
      const hookEvent = event as HookEventName;
      for (const plugin of engine.plugins) {
        const handler = plugin.hooks?.[hookEvent];
        if (typeof handler !== "function") continue;
        try {
          const result = await handler({ ...input, hook_event_name: hookEvent, session_id: engine.sessionId, cwd } as HookInput, api);
          if (result) out.push({ plugin: plugin.name, ...result });
        } catch (e) {
          out.push({ plugin: plugin.name, error: toErrorMessage(e) });
        }
      }
      const block = out.find((o) => o.decision === "block");
      if (block) {
        process.stdout.write(JSON.stringify({ decision: "block", reason: block.reason }) + "\n");
      } else if (out.length) {
        process.stdout.write(JSON.stringify({ results: out }) + "\n");
      }
      return 0;
    }
    case "run": {
      const { flags, positional } = parseFlags(rest);
      const outputFormat = String(flags["output-format"] || "text").toLowerCase();
      const jsonMode = outputFormat === "json";
      if (!new Set(["text", "json"]).has(outputFormat)) {
        console.error(outputFormat === "stream-json" ? "--output-format stream-json is not supported in this release; use --output-format json." : "--output-format must be one of: text, json");
        return 1;
      }

      const task = positional.join(" ").trim() || stringFlag(flags, "task");
      if (!task) return runUsageError("usage: lazyglm run \"<task>\"", jsonMode);

      const maxTurns = parsePositiveIntegerFlag(flags["max-turns"], 80, "--max-turns");
      if (maxTurns.error) return runUsageError(maxTurns.error, jsonMode);
      const reasoningBudget = parseNonnegativeIntegerFlag(flags["max-reasoning-tokens"], 0, "--max-reasoning-tokens");
      if (reasoningBudget.error) return runUsageError(reasoningBudget.error, jsonMode);
      const timeoutSeconds = parseNonnegativeNumberFlag(flags.timeout, 600, "--timeout");
      if (timeoutSeconds.error) return runUsageError(timeoutSeconds.error, jsonMode);
      const contextBudget = parsePositiveIntegerFlag(flags["context-budget"], undefined, "--context-budget");
      if (contextBudget.error) return runUsageError(contextBudget.error, jsonMode);

      const cwd = flags.cwd ? resolve(flags.cwd as string) : process.cwd();
      const model = stringFlag(flags, "model");
      const role = stringFlag(flags, "role") as RoleName | undefined;
      const ultrawork = !!flags.ultrawork || /\$ulw-loop\b/i.test(task);
      const permissionMode: PermissionMode = flags.yolo ? "yolo" : "auto";
      const printEvent = jsonMode
        ? () => {}
        : createRunEventPrinter({ stdout: process.stdout, stderr: process.stderr, isTTY: process.stdout.isTTY === true && !flags["no-color"] });
      const timeoutValue = timeoutSeconds.value ?? 600;
      const deadline = createDeadline(timeoutValue * 1000, { message: `LazyGLM run timed out after ${formatSeconds(timeoutValue)}.` });

      try {
        if (ultrawork) {
          const completionPromise = stringFlag(flags, "completion-promise") || "the task is fully implemented, builds cleanly, and passes verification.";
          const verifyCommand = stringFlag(flags, "verify");
          const maxIterations = parsePositiveIntegerFlag(flags["max-iterations"], 3, "--max-iterations");
          if (maxIterations.error) return runUsageError(maxIterations.error, jsonMode);
          const res = await runUltrawork({
            task,
            cwd,
            model,
            role,
            completionPromise,
            verifyCommand,
            maxIterations: maxIterations.value,
            maxTurns: maxTurns.value,
            budget: contextBudget.value,
            reasoningBudget: reasoningBudget.value,
            permissionMode,
            failOnToolBlock: jsonMode,
            deadline,
            onEvent: printEvent,
          });
          const structured = structuredUltraworkResult(res);
          if (jsonMode) {
            writeJson(structured);
          } else {
            console.log(`\n--- Ultrawork result ---`);
            console.log(`verified: ${res.verified ? "YES ✅" : "NO ❌"} | iterations: ${res.iterations} | finishReason: ${structured.finishReason}`);
            if (res.verdict) console.log(`verdict: ${res.verdict.reason}`);
          }
          return structured.ok ? 0 : 2;
        }

        const res = await runAgent({
          task,
          cwd,
          model,
          role,
          plugins: loadPlugins(),
          maxTurns: maxTurns.value,
          budget: contextBudget.value,
          reasoningBudget: reasoningBudget.value,
          permissionMode,
          failOnToolBlock: jsonMode,
          deadline,
          onEvent: printEvent,
        });

        let verification;
        let finishReason = res.finishReason;
        let errorMessage = res.errorMessage;
        if (res.finished && flags.verify) {
          try {
            const verdict = await verifyFinish({ summary: res.finishSummary, cwd, verifyCommand: stringFlag(flags, "verify"), filesWritten: res.filesWritten, deadline });
            verification = { pass: verdict.pass, reason: verdict.reason };
            if (!verdict.pass) finishReason = "verify_failed";
          } catch (err) {
            if (isDeadlineError(err) || deadline.signal?.aborted) {
              finishReason = "timeout";
              errorMessage = toErrorMessage(err) || "timeout";
              verification = { pass: false, reason: errorMessage };
            } else {
              throw err;
            }
          }
        }
        const structured = structuredRunResult(res, { finishReason, verification, errorMessage });
        if (jsonMode) {
          writeJson(structured);
        } else {
          console.log(`\n--- Run result ---`);
          console.log(`finished: ${structured.ok ? "YES ✅" : "NO (stopped)"} | finishReason: ${structured.finishReason} | turns: ${res.turns} | tokens in/out: ${res.promptTokens || res.tokensIn}/${res.completionTokens || res.tokensOut}${res.reasoningTokens ? ` | 🧠 reasoning: ${res.reasoningTokens}` : ""} | compactions: ${res.compactions}`);
          if (verification) console.log(`verify: ${verification.pass ? "PASS ✅" : "FAIL ❌"} — ${verification.reason}`);
          console.log(`transcript: ${res.transcriptPath}`);
        }
        return structured.ok ? 0 : 2;
      } catch (err) {
        const timeout = isDeadlineError(err) || deadline.signal?.aborted;
        const message = toErrorMessage(err);
        const structured = structuredError(message, { finishReason: timeout ? "timeout" : "error" });
        if (jsonMode) writeJson(structured);
        else console.error(`lazyglm run failed: ${message}`);
        return timeout ? 2 : 1;
      } finally {
        deadline.cancel();
      }
    }
    default:
      console.error(`unknown command: ${cmd}\n\n${usage()}`);
      return 1;
  }
}

function parsePositiveIntegerFlag(value: FlagValue, defaultValue: number | undefined, name: string): ParseResult<number> {
  if (value === undefined) return { value: defaultValue };
  if (value === true) return { error: `${name} requires a value` };
  const normalized = typeof value === "string" ? value.replace(/_/g, "") : value;
  const n = Number(normalized);
  if (!Number.isInteger(n) || n < 1) return { error: `${name} must be a positive integer` };
  return { value: n };
}

function parseNonnegativeIntegerFlag(value: FlagValue, defaultValue: number, name: string): ParseResult<number> {
  if (value === undefined) return { value: defaultValue };
  if (value === true) return { error: `${name} requires a value` };
  const normalized = typeof value === "string" ? value.replace(/_/g, "") : value;
  const n = Number(normalized);
  if (!Number.isInteger(n) || n < 0) return { error: `${name} must be a non-negative integer` };
  return { value: n };
}

function parseNonnegativeNumberFlag(value: FlagValue, defaultValue: number, name: string): ParseResult<number> {
  if (value === undefined) return { value: defaultValue };
  if (value === true) return { error: `${name} requires a value` };
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return { error: `${name} must be a finite non-negative number of seconds` };
  return { value: n };
}

function runUsageError(message: string, jsonMode: boolean): number {
  if (jsonMode) writeJson(structuredError(message, { finishReason: "error" }));
  else console.error(message);
  return 1;
}

function structuredError(message: unknown, { finishReason = "error" }: { finishReason?: string } = {}): StructuredOutput {
  return {
    ok: false,
    result: null,
    finishReason,
    toolCalls: [],
    cost: { tokens: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0 },
    session: null,
    error: { message: String(message || "error") },
  };
}

function structuredRunResult(res: RunAgentResult, { finishReason = res.finishReason, verification, errorMessage }: RunResultOverrides = {}): StructuredOutput {
  const promptTokens = Number(res.promptTokens ?? res.tokensIn ?? 0) || 0;
  const completionTokens = Number(res.completionTokens ?? res.tokensOut ?? 0) || 0;
  const reasoningTokens = Number(res.reasoningTokens ?? 0) || 0;
  const ok = res.finished === true && finishReason === "finished" && (!verification || verification.pass === true);
  const out: StructuredOutput = {
    ok,
    result: res.finishSummary || res.result || null,
    finishReason: ok ? "finished" : finishReason || "error",
    toolCalls: sanitizeToolCalls(res.toolCalls),
    cost: {
      tokens: promptTokens + completionTokens,
      promptTokens,
      completionTokens,
      reasoningTokens,
    },
    session: res.sessionId ? {
      id: res.sessionId,
      transcriptPath: res.transcriptPath,
      turns: Number(res.turns || 0),
      compactions: Number(res.compactions || 0),
    } : null,
  };
  if (verification) out.verification = { pass: !!verification.pass, reason: String(verification.reason || "") };
  if (errorMessage) out.error = { message: String(errorMessage) };
  return out;
}

function structuredUltraworkResult(res: UltraworkResultShape): StructuredOutput {
  const history = Array.isArray(res.history) ? res.history : [];
  const last = history[history.length - 1];
  const totals = history.reduce((acc, item) => {
    acc.promptTokens += Number(item.promptTokens ?? item.tokensIn ?? 0) || 0;
    acc.completionTokens += Number(item.completionTokens ?? item.tokensOut ?? 0) || 0;
    acc.reasoningTokens += Number(item.reasoningTokens ?? 0) || 0;
    acc.toolCalls.push(...sanitizeToolCalls(item.toolCalls));
    return acc;
  }, { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, toolCalls: [] as StructuredOutput["toolCalls"] });
  const finishReason = res.finishReason || (res.verified ? "finished" : "max_iterations");
  const out: StructuredOutput = {
    ok: res.verified === true,
    result: res.finishSummary || last?.finishSummary || last?.result || null,
    finishReason,
    toolCalls: totals.toolCalls,
    cost: {
      tokens: totals.promptTokens + totals.completionTokens,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      reasoningTokens: totals.reasoningTokens,
    },
    session: last?.sessionId ? {
      id: last.sessionId,
      transcriptPath: last.transcriptPath,
      turns: Number(last.turns || 0),
      compactions: Number(last.compactions || 0),
    } : null,
  };
  if (res.verdict) out.verification = { pass: !!res.verdict.pass, reason: String(res.verdict.reason || "") };
  if (res.errorMessage) out.error = { message: String(res.errorMessage) };
  return out;
}

function sanitizeToolCalls(toolCalls: unknown): StructuredOutput["toolCalls"] {
  return (Array.isArray(toolCalls) ? toolCalls : []).map((tc: Partial<ToolExecutionRecord>) => ({
    name: String(tc.name || "unknown"),
    turn: Number(tc.turn || 0),
    status: ["ok", "denied", "error", "finish", "timeout"].includes(String(tc.status)) ? String(tc.status) : "ok",
  }));
}

function writeJson(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function formatSeconds(seconds: number): string {
  const n = Number(seconds);
  return Number.isInteger(n) ? `${n}s` : `${n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}s`;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    // if no stdin (tty), resolve empty immediately
    if (process.stdin.isTTY) resolve("");
  });
}
