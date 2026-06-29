// Interactive self-sustained REPL: `lazyglm` with no args launches a live
// agentic shell (like `claude` / `hermes`). Reuses provider.chat (streaming),
// Context, tools, hooks, and plugins — does NOT call runAgent (the one-shot
// path). Human-in-the-loop: a text-only response ends the turn and returns
// control to the user; the agent only auto-loops on tool calls within a turn.
import * as readline from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chat, resolveProviderConfig, shouldPreserveThinking } from "./agent/provider.js";
import { findCatalogModelEntry, loadCatalog, resolveContextBudget } from "./agent/router.js";
import {
  beginAdaptiveUserTurn,
  createAdaptiveRoutingState,
  effectiveBundleFromProviderConfig,
  evaluatePromptRouting,
  evaluateToolResultRouting,
  evaluateUserTurnCompleteRouting,
  highRole,
  observePromptIntake,
  observeToolResult,
  recordRoutingApplied,
  resetAdaptiveRoutingState,
} from "./agent/adaptive-router.js";
import { TOOL_SPECS, TOOL_HANDLERS } from "./agent/tools.js";
import { Context, assistantMessageFrom } from "./agent/context.js";
import { HookEngine } from "./hooks/engine.js";
import { loadPlugins } from "./plugins/index.js";
import { loadSkills, getSkill, detectSkillInvocation } from "./skills/index.js";
import { runOnboarding, needsOnboarding } from "./onboard.js";
import { createSession, appendEvent, listSessions, loadSessionEvents, lastSession } from "./sessions.js";
import { install } from "./installer.js";
import { runUltrawork } from "./ulw.js";
import { gitInfo, truncate } from "./util.js";
import { renderBanner } from "./banner.js";
import { renderStatus } from "./status.js";
import { buildReplPrompt, modelTierGuidance } from "./prompt.js";
import type { ContextMessage } from "./agent/context.js";
import type { SessionInfo } from "./sessions.js";
import type {
  ChatCompletion,
  ChatUsage,
  EffectiveBundle,
  FinishToolResult,
  ModelCatalog,
  Provider,
  ProviderConfig,
  RoleName,
  RoutingDecision,
  SessionRecord,
  StreamDelta,
  ToolCall,
  ToolHandlerResult,
} from "./types/index.js";

const GRAY = "\x1b[90m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";
const TOOL_INDENT = "   ";
const TOOL_DIVIDER_RULE = "─".repeat(18);
// Fixed-width rule that frames a whole assistant+tool turn. Deliberately NOT
// derived from process.stdout.columns so render output (and tests) stay
// deterministic — mirrors the TOOL_DIVIDER_RULE approach. Wide enough to frame
// the indented `── tools ──` divider, which nests inside a turn untouched.
const TURN_RULE_WIDTH = 60;
const TURN_RULE = "─".repeat(TURN_RULE_WIDTH);

interface RenderOptions {
  isTTY?: boolean;
}

interface TokenCounts {
  prompt: number;
  completion: number;
  reasoning: number;
}

interface LaunchFlags {
  continue?: boolean;
  yolo?: boolean;
  model?: string;
  provider?: Provider;
  role?: RoleName;
  contextBudget?: number;
}

interface LaunchOptions {
  cwd?: string;
  flags?: LaunchFlags;
}

interface ContextBudgetCommandOptions {
  model?: string | null;
  catalog?: ModelCatalog;
  manualBudget?: number | null;
}

type ContextBudgetCommandResult =
  | { error: string; budget?: undefined; manualBudget?: undefined; mode?: undefined; action?: undefined }
  | { budget: number; manualBudget: number | null; mode: "manual" | "catalog"; action: "show" | "set"; error?: undefined };

interface TurnSummary {
  hadError: boolean;
  wroteFiles: boolean;
  explicitComplexity: boolean;
}

type PromptSignal = ReturnType<typeof observePromptIntake>;

function ansi(code: string, { isTTY = true }: RenderOptions = {}): string {
  return isTTY ? code : "";
}

function routingBundleLabel(bundle: EffectiveBundle): string {
  return `${bundle.model}/${bundle.reasoningEffort}`;
}

export function formatRoutingNotice(decision: RoutingDecision, opts: RenderOptions = {}): string {
  const text = `routing: ${routingBundleLabel(decision.from)} -> ${routingBundleLabel(decision.to)} (${decision.reason})`;
  return `${ansi(CYAN, opts)}${text}${ansi(RESET, opts)}`;
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatReasoning(text = "", opts: RenderOptions = {}): string {
  return `${ansi(GRAY, opts)}✶ ${text}`;
}

export function formatText(text = ""): string {
  return `💬 ${text}`;
}

export function formatToolCall(name: string | null | undefined, args: unknown = "", opts: RenderOptions = {}): string {
  const argText = truncate(displayValue(args), 100);
  return `${TOOL_INDENT}${ansi(CYAN, opts)}🔧 ${name}${ansi(RESET, opts)}${ansi(DIM, opts)}(${argText})${ansi(RESET, opts)}`;
}

export function formatToolResult(result: unknown = "", opts: RenderOptions = {}): string {
  const preview = truncate(displayValue(result), 400).replace(/\n/g, `\n${TOOL_INDENT}${ansi(GREEN, opts)}`);
  return `${TOOL_INDENT}${ansi(GREEN, opts)}↳ ${preview}${ansi(RESET, opts)}`;
}

export function turnDivider(opts: RenderOptions = {}): string {
  return `${TOOL_INDENT}${ansi(DIM, opts)}${TOOL_DIVIDER_RULE} tools ${TOOL_DIVIDER_RULE}${ansi(RESET, opts)}`;
}

export function formatExitMarker(opts: RenderOptions = {}): string {
  return `${ansi(DIM, opts)}bye.${ansi(RESET, opts)}`;
}

function usageFromUnknown(value: unknown): TokenCounts {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    prompt: Number(record.prompt || 0) || 0,
    completion: Number(record.completion || 0) || 0,
    reasoning: Number(record.reasoning || 0) || 0,
  };
}

function reasoningTokens(usage: ChatUsage | null | undefined): number {
  return Number(usage?.completion_tokens_details?.reasoning_tokens || usage?.reasoning_tokens || 0) || 0;
}

function toErrorMessage(err: unknown): string {
  return err && typeof err === "object" && "message" in err ? String((err as { message?: unknown }).message) : String(err);
}

function isFinishResult(value: unknown): value is FinishToolResult {
  return !!value && typeof value === "object" && (value as { __finish?: unknown }).__finish === true;
}

export function formatCost(cumulative: Partial<TokenCounts> = {}, lastTurn: Partial<TokenCounts> | null = null, opts: RenderOptions = {}): string {
  const c = cumulative && typeof cumulative === "object" ? cumulative : {};
  const lt = lastTurn && typeof lastTurn === "object" ? lastTurn : {};
  const lastPrompt = lt.prompt || 0;
  const lastCompletion = lt.completion || 0;
  const lastReasoning = lt.reasoning || 0;
  const totalPrompt = c.prompt || 0;
  const totalCompletion = c.completion || 0;
  const totalReasoning = c.reasoning || 0;

  if (!opts.isTTY) {
    return [
      "LazyGLM cost",
      `last_prompt=${lastPrompt}`,
      `last_completion=${lastCompletion}`,
      `last_reasoning=${lastReasoning}`,
      `prompt=${totalPrompt}`,
      `completion=${totalCompletion}`,
      `reasoning=${totalReasoning}`,
    ].join(" | ");
  }

  return `   last in/out: ${lastPrompt}/${lastCompletion} | ` +
    `${ansi(GRAY, opts)}reasoning: ${lastReasoning}${ansi(RESET, opts)} | ` +
    `total in/out: ${totalPrompt}/${totalCompletion} | ` +
    `${ansi(GRAY, opts)}reasoning: ${totalReasoning}${ansi(RESET, opts)}`;
}

// Turn-boundary frame helpers (purely additive). Each assistant+tool turn is
// wrapped so consecutive turns stop blending. TTY: a dim fixed-width rule
// above and below the turn (symmetric). Non-TTY: a plain `> text` echo with
// zero ANSI and no rule, so piped output stays clean + parseable. The existing
// `── tools ──` divider nests inside this frame and is left untouched.
export function turnRule({ isTTY = true }: RenderOptions = {}): string {
  return isTTY ? `${DIM}${TURN_RULE}${RESET}` : "";
}

export function stripControlSequences(text = ""): string {
  return String(text).replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

export function turnStart(userText: unknown, { isTTY = true }: RenderOptions = {}): string {
  if (!isTTY) {
    // Single-line truncation: the shared truncate() inserts a newline before
    // its marker, which would break the "standalone `> text` line" contract
    // for piped output. Use a flat inline marker instead.
    const clean = stripControlSequences(String(userText ?? ""));
    const display = clean.length > 100 ? clean.slice(0, 100) + "…" : clean;
    return `> ${display}\n`;
  }
  return `\n${turnRule({ isTTY })}\n`;
}

export function turnEnd({ isTTY = true }: RenderOptions = {}): string {
  if (!isTTY) return "";
  return `${turnRule({ isTTY })}\n\n`;
}

export function parseContextBudgetInput(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).replace(/_/g, "");
  const n = Number(normalized);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function resolveContextBudgetCommand(
  argStr: unknown,
  { model, catalog, manualBudget = null }: ContextBudgetCommandOptions = {},
): ContextBudgetCommandResult {
  const arg = String(argStr || "").trim();
  const derivedBudget = () => resolveContextBudget(model, catalog);
  if (!arg) {
    const budget = manualBudget ?? derivedBudget();
    return { budget, manualBudget, mode: manualBudget !== null ? "manual" : "catalog", action: "show" };
  }
  if (/^(auto|catalog|default)$/i.test(arg)) {
    const budget = derivedBudget();
    return { budget, manualBudget: null, mode: "catalog", action: "set" };
  }
  const parsed = parseContextBudgetInput(arg);
  if (!parsed) return { error: "usage: /context-budget <positive-tokens|auto>" };
  return { budget: parsed, manualBudget: parsed, mode: "manual", action: "set" };
}

export function hasManualRoutingOverride(flags: Partial<LaunchFlags> = {}): boolean {
  return !!(flags.model || flags.role);
}

/**
 * A single readline interface over stdin that buffers lines and serves them
 * sequentially via next(). This is shared by onboarding and the REPL so that
 * piped / burst stdin is never lost between sequential consumers (a known
 * readline race when lines arrive faster than question listeners attach).
 * On a TTY, lines pop one per Enter (human-paced). On a pipe, all lines buffer
 * up front and are handed out in order.
 */
class LineQueue {
  lines: string[];
  waiters: Array<(line: string | null) => void>;
  closed: boolean;
  rl: readline.Interface;

  constructor({ input, output }: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }) {
    this.lines = [];
    this.waiters = [];
    this.closed = false;
    this.rl = readline.createInterface({ input, output });
    this.rl.on("line", (line: string) => {
      if (this.waiters.length) this.waiters.shift()?.(line);
      else this.lines.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      while (this.waiters.length) this.waiters.shift()?.(null);
    });
  }
  next(): Promise<string | null> {
    if (this.lines.length) return Promise.resolve(this.lines.shift() ?? null);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

// --- streaming renderer (shared across REPL turns and /ultrawork) ---
let streamOpen = false;
let streamMode: "text" | "reasoning" | null = null;
let toolDividerShown = false;
let toolDividerKey: string | null = null;

function renderOpts(): RenderOptions {
  return { isTTY: process.stdout.isTTY === true };
}

function resetTurnDivider(key: string | null = null): void {
  toolDividerKey = key;
  toolDividerShown = false;
}

function writeTurnDivider(key: string | null = toolDividerKey): void {
  if (key !== toolDividerKey) resetTurnDivider(key);
  if (toolDividerShown) return;
  toolDividerShown = true;
  if (process.stdout.isTTY === true) process.stdout.write(`${turnDivider(renderOpts())}\n`);
}

function closeStream(): void {
  if (streamOpen) {
    process.stdout.write(ansi(RESET, renderOpts()) + "\n");
    streamOpen = false;
    streamMode = null;
  }
}

function renderDelta(d: StreamDelta): void {
  const opts = renderOpts();
  if (d.type === "reasoning") {
    if (!streamOpen) {
      process.stdout.write(formatReasoning(d.text, opts));
      streamOpen = true;
      streamMode = "reasoning";
    } else if (streamMode !== "reasoning") {
      process.stdout.write(`${ansi(RESET, opts)}\n${formatReasoning(d.text, opts)}`);
      streamMode = "reasoning";
    } else {
      process.stdout.write(d.text);
    }
  } else if (d.type === "text") {
    if (streamOpen && streamMode === "reasoning") process.stdout.write(`${ansi(RESET, opts)}\n`);
    if (!streamOpen || streamMode !== "text") process.stdout.write(formatText());
    streamOpen = true;
    streamMode = "text";
    process.stdout.write(d.text);
  } else if (d.type === "tool_call_start") {
    closeStream();
    writeTurnDivider();
  }
}

function extractQuoted(s: string): string | null {
  const m = s.match(/"([^"]*)"/);
  return m ? m[1] : null;
}
function extractFlag(s: string, flag: string): string | null {
  const re = new RegExp(`--${flag}\\s+"([^"]*)"`);
  const m = s.match(re);
  return m ? m[1] : null;
}

export function replPromptTarget({ stdinIsTTY, stdoutIsTTY }: { stdinIsTTY?: boolean; stdoutIsTTY?: boolean } = {}): "stdout" | "stderr" | null {
  if (stdoutIsTTY) return "stdout";
  if (stdinIsTTY) return "stderr";
  return null;
}

/** Rebuild a Context's messages from a session's event records. */
export function replayIntoContext(events: SessionRecord[], ctx: Context): void {
  for (const ev of events) {
    if (ev.type === "user") {
      ctx.push({ role: "user", content: String(ev.content ?? "") });
    } else if (ev.type === "assistant") {
      const m: ContextMessage = { role: "assistant", content: String(ev.content || "") };
      // Restore GLM preserved thinking so resumed sessions replay prior
      // reasoning_content across turns (the provider gates the wire payload).
      if (ev.reasoning_content) m.reasoning_content = String(ev.reasoning_content);
      const toolCalls = Array.isArray(ev.tool_calls) ? ev.tool_calls as ToolCall[] : [];
      if (toolCalls.length) {
        m.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      ctx.push(m);
    } else if (ev.type === "tool") {
      ctx.push({ role: "tool", tool_call_id: ev.tool_call_id, content: String(ev.content ?? "") });
    }
    // session / usage / compact / log records are not part of the message history
  }
}

/**
 * Reconstruct cumulative usage, last-turn usage, and the original session start
 * time from a session's persisted event records. Used by --continue and /resume
 * so /status reflects prior turns rather than a freshly-zeroed process state.
 *
 * @returns {{ cumulative: object, lastTurn: object|null, sessionStartMs: number }}
 */
export function replayTelemetry(events: SessionRecord[] = []): { cumulative: TokenCounts; lastTurn: TokenCounts | null; sessionStartMs: number } {
  const cumulative = { prompt: 0, completion: 0, reasoning: 0 };
  let lastTurn: TokenCounts | null = null;
  let sessionStartMs = Date.now();
  for (const ev of events) {
    if (ev.type === "session" && ev.t) {
      const ms = Date.parse(ev.t);
      if (!Number.isNaN(ms)) sessionStartMs = ms;
    } else if (ev.type === "usage") {
      // Sum per-turn usage fields to rebuild the cumulative total. This matches
      // the live REPL's own accounting (see the handleLine usage append) and is
      // robust against non-monotonic cumulative snapshots: sessions that were
      // resumed before the telemetry-restore patch persisted cumulative
      // snapshots that restarted from zero, so last-one-wins would under-report
      // the true session total for those legacy histories.
      const u = ev.usage && typeof ev.usage === "object" ? ev.usage as ChatUsage : null;
      if (u && typeof u === "object") {
        const reasoning = reasoningTokens(u);
        cumulative.prompt += Number(u.prompt_tokens || 0) || 0;
        cumulative.completion += Number(u.completion_tokens || 0) || 0;
        cumulative.reasoning += reasoning;
        lastTurn = { prompt: Number(u.prompt_tokens || 0) || 0, completion: Number(u.completion_tokens || 0) || 0, reasoning };
      }
    }
  }
  return { cumulative, lastTurn, sessionStartMs };
}

/** Render runAgent / runUltrawork events into the REPL (compact). */
function renderUltraworkEvent(ev: Record<string, unknown> & { type?: string }): void {
  switch (ev.type) {
    case "start":
      resetTurnDivider("ultrawork:start");
      console.log(`\n🚀 iteration start | model: ${ev.model} | task: ${truncate(String(ev.task ?? ""), 120)}`);
      break;
    case "reasoning_delta":
      renderDelta({ type: "reasoning", text: String(ev.text ?? "") });
      break;
    case "assistant_delta":
      renderDelta({ type: "text", text: String(ev.text ?? "") });
      break;
    case "tool_call_start":
      closeStream();
      break;
    case "tool_call":
      closeStream();
      writeTurnDivider(ev.turn === undefined ? "ultrawork" : `ultrawork:${ev.turn}`);
      console.log(formatToolCall(String(ev.name ?? "unknown"), ev.input, renderOpts()));
      break;
    case "tool_result":
      console.log(formatToolResult(ev.result, renderOpts()));
      break;
    case "assistant_text":
      break; // already streamed via assistant_delta
    case "usage":
      break; // per-turn usage is noisy; /cost shows the cumulative total
    case "finish":
      closeStream();
      console.log(`${GREEN}   ✅ ${truncate(String(ev.summary ?? ""), 400)}${RESET}`);
      break;
    case "ultrawork_iteration":
      closeStream();
      console.log(`\n${CYAN}🔁 iteration ${ev.iteration}/${ev.max}${RESET}`);
      break;
    case "ultrawork_verify":
      console.log(`   verify: ${ev.pass ? GREEN + "PASS ✅" : YELLOW + "FAIL ❌"}${RESET} — ${truncate(String(ev.reason ?? ""), 200)}`);
      break;
    case "retry":
      closeStream();
      console.log(`${YELLOW}   ⏳ retry ${ev.attempt}: ${ev.reason}${RESET}`);
      break;
    case "compact":
      console.log(`${DIM}   (compacted #${ev.compactionCount})${RESET}`);
      break;
    case "blocked":
      console.log(`${YELLOW}   ⛔ ${ev.tool}: ${(Array.isArray(ev.reasons) ? ev.reasons : []).map(String).join("; ")}${RESET}`);
      break;
    case "error":
      closeStream();
      console.error(`${YELLOW}   ❌ ${ev.message}${RESET}`);
      break;
    default:
      break;
  }
}

/**
 * Launch the interactive REPL.
 * @param {object} opts - { cwd, flags: { continue, yolo, model, provider } }
 */
export async function launchREPL({ cwd, flags = {} }: LaunchOptions = {}): Promise<number> {
  const dir = cwd || process.cwd();

  // Shared line queue over stdin — used by onboarding (if it runs) and the REPL.
  const queue = new LineQueue({ input: process.stdin, output: process.stdout });
  queue.rl.on("SIGINT", () => {
    process.stdout.write("\n");
    process.exit(0);
  });

  // 1. Onboard if there's no key source anywhere (no env, no config, not ollama)
  if (await needsOnboarding()) {
    try {
      await runOnboarding({ queue, output: process.stdout });
    } catch (e: unknown) {
      console.error(`\n❌ ${toErrorMessage(e)}`);
      process.exit(1);
    }
  }

  // 2. Resolve provider config (env > config file > catalog default)
  let providerConfig: ProviderConfig;
  try {
    providerConfig = await resolveProviderConfig({ model: flags.model, provider: flags.provider, role: flags.role || "default" });
  } catch (e: unknown) {
    console.error(`\n❌ ${toErrorMessage(e)}`);
    process.exit(1);
  }
  let currentModel = providerConfig.modelId;
  const catalog: ModelCatalog = await loadCatalog();
  let manualContextBudget = typeof flags.contextBudget === "number" && Number.isInteger(flags.contextBudget) && flags.contextBudget > 0 ? flags.contextBudget : null;
  let contextBudget = manualContextBudget ?? resolveContextBudget(providerConfig.model, catalog);
  const adaptiveState = createAdaptiveRoutingState({ manualOverride: hasManualRoutingOverride(flags) });

  // 3. Auto-init the project dir silently (.lazyglm/ + AGENTS.md) if missing
  if (!existsSync(join(dir, ".lazyglm")) || !existsSync(join(dir, "AGENTS.md"))) {
    try {
      await install({ cwd: dir });
    } catch {
      // best-effort; not fatal
    }
  }

  // 4. Hooks + plugins
  const engine = new HookEngine({ cwd: dir, log: () => {} });
  for (const p of loadPlugins()) engine.register(p);

  // 5. Context + system prompt
  const gi = gitInfo(dir);
  const ctx = new Context({ model: currentModel, budget: contextBudget, preserveThinking: shouldPreserveThinking(providerConfig.provider) });
  const startRes = await engine.fire("SessionStart", {});
  const activeModelInfo = (): { tier?: string; description?: string; contextWindow?: number; tierReason: string } => {
    const entry = findCatalogModelEntry(providerConfig.model || currentModel, catalog) || findCatalogModelEntry(currentModel, catalog);
    const tier = entry?.tier;
    const description = entry?.description;
    const contextWindow = entry?.context_window ?? entry?.context;
    const tierReason = modelTierGuidance({ tier, description });
    return { tier, description, contextWindow, tierReason };
  };
  const refreshSystemPrompt = (): void => {
    const info = activeModelInfo();
    ctx.setSystem(buildReplPrompt({
      cwd: dir,
      git: gi,
      model: currentModel,
      injects: startRes.injects,
      tier: info.tier,
      contextWindow: info.contextWindow,
      description: info.description,
    }));
  };
  refreshSystemPrompt();

  let yolo = !!flags.yolo;
  engine.setMeta({ model: currentModel, transcriptPath: null, permissionMode: yolo ? "yolo" : "auto" });

  // 6. Cost tracking
  const cumulative: TokenCounts = { prompt: 0, completion: 0, reasoning: 0 };
  // Last-turn usage + timing snapshot, surfaced by /status. lastTurn is null
  // until the first turn completes; lastTurnMs includes retry backoff (wall-clock
  // around chat()), so it is a human-facing figure, not a latency benchmark.
  let lastTurn: TokenCounts | null = null;
  let lastTurnMs: number | null = null;
  let sessionStartMs = Date.now();
  const restoreTelemetry = (events: SessionRecord[]): void => {
    const restored = replayTelemetry(events);
    cumulative.prompt = restored.cumulative.prompt;
    cumulative.completion = restored.cumulative.completion;
    cumulative.reasoning = restored.cumulative.reasoning;
    lastTurn = restored.lastTurn;
    sessionStartMs = restored.sessionStartMs;
    // Persisted usage events do not carry a turn duration; clear the stale
    // pre-resume lastTurnMs so /status does not pair resumed tokens with an
    // unrelated wall-clock figure. It repopulates after the next turn.
    lastTurnMs = null;
  };

  // 7. Session (--continue resumes the last session file; otherwise fresh)
  let session: SessionInfo | null = null;
  if (flags.continue) {
    const last = await lastSession();
    if (last) {
      const events = await loadSessionEvents(last.id);
      if (events && events.length) {
        replayIntoContext(events, ctx);
        restoreTelemetry(events);
        session = { id: last.id, path: last.path, model: last.model, provider: last.provider };
        console.log(`${GRAY}   (resumed session ${last.id}: ${events.length} events)${RESET}`);
      }
    }
    if (!session) console.log(`${YELLOW}   (no prior session to resume — starting fresh)${RESET}`);
  }
  if (!session) {
    session = await createSession({ model: currentModel, provider: providerConfig.provider });
  }

  // 8. Skills
  await loadSkills();

  // 9. Banner (TTY-aware: ASCII wordmark + info panel in a terminal; a single
  // clean machine-readable line under pipes / CI so logs are never corrupted).
  process.stdout.write(
    renderBanner({
      model: currentModel,
      provider: providerConfig.provider,
      cwd: dir,
      git: gi,
      session,
      yolo,
      ...activeModelInfo(),
      isTTY: process.stdout.isTTY ?? false,
    }),
  );

  const resolveRoutingCandidate = async (role: RoleName): Promise<{ config: ProviderConfig; bundle: EffectiveBundle }> => {
    const config = await resolveProviderConfig({ provider: flags.provider, role });
    return { config, bundle: effectiveBundleFromProviderConfig(config, catalog) };
  };

  const currentRoutingBundle = async (): Promise<EffectiveBundle> => effectiveBundleFromProviderConfig(providerConfig, catalog);

  const applyRoutingDecision = async (decision: RoutingDecision | null, nextConfig: ProviderConfig): Promise<boolean> => {
    if (!decision) return false;
    providerConfig = nextConfig;
    currentModel = nextConfig.modelId;
    contextBudget = manualContextBudget ?? resolveContextBudget(nextConfig.model, catalog);
    ctx.model = currentModel;
    ctx.budget = contextBudget;
    ctx.preserveThinking = shouldPreserveThinking(nextConfig.provider);
    refreshSystemPrompt();
    engine.setMeta({ model: currentModel });
    recordRoutingApplied(adaptiveState, decision);
    process.stdout.write(`${formatRoutingNotice(decision, renderOpts())}\n`);
    await appendEvent(session, {
      type: "routing_change",
      source: decision.source,
      reason: decision.reason,
      direction: decision.direction,
      from: decision.from,
      to: decision.to,
    });
    return true;
  };

  const maybeRouteForPrompt = async (signal: PromptSignal): Promise<boolean> => {
    if (adaptiveState.manualOverride) return false;
    const currentBundle = await currentRoutingBundle();
    const candidate = await resolveRoutingCandidate(signal.role);
    const decision = evaluatePromptRouting({
      state: adaptiveState,
      currentBundle,
      candidateBundle: candidate.bundle,
      signal,
    });
    return applyRoutingDecision(decision, candidate.config);
  };

  const maybeRouteForToolResult = async (): Promise<boolean> => {
    if (adaptiveState.manualOverride) return false;
    const currentBundle = await currentRoutingBundle();
    const candidate = await resolveRoutingCandidate(highRole());
    const decision = evaluateToolResultRouting({
      state: adaptiveState,
      currentBundle,
      candidateBundle: candidate.bundle,
    });
    return applyRoutingDecision(decision, candidate.config);
  };

  const maybeRouteAfterUserTurn = async (turnSummary: Partial<TurnSummary>): Promise<boolean> => {
    if (adaptiveState.manualOverride) return false;
    const currentBundle = await currentRoutingBundle();
    const candidate = await resolveRoutingCandidate("quick");
    const decision = evaluateUserTurnCompleteRouting({
      state: adaptiveState,
      currentBundle,
      quickBundle: candidate.bundle,
      turnSummary,
    });
    return applyRoutingDecision(decision, candidate.config);
  };

  // --- slash commands (closure over mutable REPL state) ---
  const handleSlash = async (input: string): Promise<"exit" | void> => {
    const body = input.slice(1);
    const sp = body.indexOf(" ");
    const cmd = (sp >= 0 ? body.slice(0, sp) : body).toLowerCase();
    const argStr = sp >= 0 ? body.slice(sp + 1).trim() : "";

    switch (cmd) {
      case "help":
        console.log(`${CYAN}Commands:${RESET}
  /help                 show this help
  /exit                 quit
  /clear                clear conversation (keep system prompt)
  /model <name>         switch model (e.g. glm-4.7-flash, glm-4.7, glm-5.2)
  /context-budget <n>   override context budget; use auto to restore catalog-derived
  /status               show session, model, role/effort, timing, and token totals
  /cost                 show last-turn and cumulative token spend (incl. reasoning)
  /compact              compact the context now
  /resume [n]           list past sessions, or resume the nth
  /ultrawork "<task>"   verified-completion autonomous loop
                        (options: --verify "<cmd>" --completion-promise "<text>")
  /yolo                 toggle yolo mode (bypass all permission gates)
Inline $skill invocations are also supported (e.g. $programming ...).`);
        return;
      case "exit":
      case "quit":
        return "exit";
      case "clear":
        ctx.resetToSystemPrompt();
        resetAdaptiveRoutingState(adaptiveState);
        console.log(`${DIM}   (context cleared)${RESET}`);
        return;
      case "model": {
        if (!argStr) {
          console.log(`   current model: ${currentModel}`);
          console.log(`   available: ${Object.keys(catalog.models || {}).join(", ")}`);
          return;
        }
        try {
          const nc = await resolveProviderConfig({ model: argStr, provider: flags.provider, role: "default" });
          providerConfig = nc;
          currentModel = nc.modelId;
          contextBudget = manualContextBudget ?? resolveContextBudget(nc.model, catalog);
          ctx.model = currentModel;
          ctx.budget = contextBudget;
          // A /model switch can change the provider (e.g. zai → ollama), which
          // flips whether reasoning_content is on the wire. Keep the budget
          // estimator in sync so compaction decisions match the new payload.
          ctx.preserveThinking = shouldPreserveThinking(nc.provider);
          refreshSystemPrompt();
          engine.setMeta({ model: currentModel });
          resetAdaptiveRoutingState(adaptiveState, { manualOverride: true });
          const info = activeModelInfo();
          const tierNote = info.tier ? ` | tier: ${info.tier}${info.tierReason ? ` - ${info.tierReason}` : ""}` : "";
          console.log(`${GREEN}   ✓ model: ${currentModel}${tierNote}${RESET}`);
        } catch (e: unknown) {
          console.log(`${YELLOW}   ✗ ${toErrorMessage(e)}${RESET}`);
        }
        return;
      }
      case "context-budget": {
        const res = resolveContextBudgetCommand(argStr, {
          model: providerConfig.model,
          catalog,
          manualBudget: manualContextBudget,
        });
        if (res.error !== undefined) {
          console.log(`${YELLOW}   ${res.error}${RESET}`);
          return;
        }
        manualContextBudget = res.manualBudget;
        contextBudget = res.budget;
        ctx.budget = contextBudget;
        const label = res.mode === "manual" ? "manual" : "catalog";
        console.log(`${GREEN}   ✓ context budget: ${contextBudget.toLocaleString()} tokens (${label})${RESET}`);
        return;
      }
      case "cost":
        console.log(formatCost(cumulative, lastTurn, renderOpts()));
        return;
      case "status": {
        // Derive reasoningEffort at /status time from the live role + catalog
        // (mirrors router.js pickModel: roleEntry.reasoning_effort ||
        // catalog.current.model_reasoning_effort). Done here so a /model switch
        // is reflected without threading effort through providerConfig's return.
        let effort = "high";
        let role = providerConfig.role || "default";
        const roleEntry = catalog.roles?.[role] || catalog.roles?.default || {};
        effort = roleEntry.reasoning_effort || catalog.current?.model_reasoning_effort || "high";
        const info = activeModelInfo();
        console.log(
          renderStatus({
            sessionId: session?.id,
            model: currentModel,
            provider: providerConfig.provider,
            role,
            reasoningEffort: effort,
            tier: info.tier,
            tierReason: info.tierReason,
            cumulative,
            lastTurn,
            sessionElapsedMs: Date.now() - sessionStartMs,
            lastTurnMs,
            isTTY: process.stdout.isTTY === true,
          }),
        );
        return;
      }
      case "compact": {
        const before = ctx.estimateTokens();
        const did = await ctx.maybeCompact({
          force: true,
          onCompact: async ({ compactionCount }) => {
            const res = await engine.fire("PostCompact", { compactionCount });
            await appendEvent(session, { type: "compact", compactionCount });
            return res?.injects || [];
          },
        });
        console.log(did ? `${DIM}   (compacted: ~${before} → ${ctx.estimateTokens()} tokens)${RESET}` : `${DIM}   (nothing to compact yet)${RESET}`);
        return;
      }
      case "resume": {
        const list = await listSessions();
        if (!argStr) {
          if (!list.length) {
            console.log(`${DIM}   (no past sessions)${RESET}`);
            return;
          }
          console.log(`${CYAN}Past sessions${RESET} (most recent first):`);
          list.slice(0, 15).forEach((s, i) => {
            const fp = s.firstPrompt ? truncate(s.firstPrompt, 50) : "(no prompt)";
            console.log(`  ${i + 1}. ${s.id} | ${s.model || "?"} | ${fp}`);
          });
          console.log(`${DIM}   /resume <n> to resume a session${RESET}`);
          return;
        }
        const n = Number(argStr);
        const pick = list[n - 1];
        if (!pick) {
          console.log(`${YELLOW}   no session #${n}${RESET}`);
          return;
        }
        const events = await loadSessionEvents(pick.id);
        if (!events) {
          console.log(`${YELLOW}   could not load ${pick.id}${RESET}`);
          return;
        }
        ctx.resetToSystemPrompt();
        replayIntoContext(events, ctx);
        restoreTelemetry(events);
        session = { id: pick.id, path: pick.path, model: pick.model, provider: pick.provider };
        console.log(`${GREEN}   ✓ resumed ${pick.id} (${events.length} events)${RESET}`);
        return;
      }
      case "ultrawork": {
        const task = extractQuoted(argStr) || argStr;
        if (!task) {
          console.log(`${YELLOW}   usage: /ultrawork "<task>"${RESET}`);
          return;
        }
        const verifyCommand = extractFlag(argStr, "verify");
        const completionPromise =
          extractFlag(argStr, "completion-promise") ||
          "the task is fully implemented, builds cleanly, and passes verification.";
        // Resolve an ultrabrain bundle independent of the adaptive REPL's current
        // route. applyRoutingDecision may have de-escalated providerConfig/currentModel
        // to a quick bundle; reusing those would silently run ultrawork on the wrong
        // model, because runAgent prefers an explicit config over role-based picking.
        //
        // When the user pinned a model via --model/--role or /model, adaptive
        // routing is disabled (manualOverride), so providerConfig/currentModel are
        // authoritative and must be honored — resolving the catalog ultrabrain here
        // would override their selection. Only fall back to catalog ultrabrain when
        // adaptive routing is active and may have de-escalated the live route.
        let ultraConfig, ultraBundle, ultraBudget;
        if (adaptiveState.manualOverride) {
          ultraConfig = providerConfig;
          ultraBundle = effectiveBundleFromProviderConfig(ultraConfig, catalog);
          ultraBudget = contextBudget;
        } else {
          ultraConfig = await resolveProviderConfig({ provider: flags.provider, role: "ultrabrain" });
          ultraBundle = effectiveBundleFromProviderConfig(ultraConfig, catalog);
          ultraBudget = manualContextBudget ?? resolveContextBudget(ultraConfig.model, catalog);
        }
        console.log(`\n${CYAN}🔁 ULTRAWORK${RESET} — task: ${truncate(task, 120)}`);
        if (verifyCommand) console.log(`   verify: ${verifyCommand}`);
        const res = await runUltrawork({
          task,
          cwd: dir,
          model: ultraBundle.modelId,
          role: "ultrabrain",
          config: ultraConfig,
          budget: ultraBudget,
          completionPromise,
          verifyCommand: verifyCommand ?? undefined,
          maxIterations: 3,
          maxTurns: 60,
          onEvent: renderUltraworkEvent,
        });
        closeStream();
        console.log(`\n${res.verified ? GREEN + "✅ verified: YES" : YELLOW + "❌ verified: NO"}${RESET} | iterations: ${res.iterations}`);
        if (res.verdict) console.log(`   ${truncate(res.verdict.reason, 400)}`);
        return;
      }
      case "yolo":
        yolo = !yolo;
        engine.setMeta({ permissionMode: yolo ? "yolo" : "auto" });
        console.log(`   yolo: ${yolo ? YELLOW + "ON" + RESET : "OFF"}`);
        return;
      default:
        console.log(`${YELLOW}   unknown command: /${cmd} — try /help${RESET}`);
    }
  };

  // --- one agent turn: stream GLM, execute tools, return control on text-only ---
  // displayText: the raw user input as typed, used ONLY for the non-TTY `> text`
  // echo so piped output logs the user's command rather than the expanded skill
  // body. Defaults to userContent for non-skill turns. (PR #26 Codex P2.)
  const runAgentTurn = async (userContent: string, displayText = userContent): Promise<TurnSummary> => {
    const turnSummary: TurnSummary = {
      hadError: false,
      wroteFiles: false,
      explicitComplexity: adaptiveState.explicitComplexityInCurrentUserTurn,
    };
    const ups = await engine.fire("UserPromptSubmit", { prompt: userContent });
    let content = userContent;
    if (ups.injects.length) content = `${ups.injects.join("\n\n")}\n\n---\n\n${userContent}`;
    ctx.push({ role: "user", content });
    await appendEvent(session, { type: "user", content: userContent });

    // Frame this turn so consecutive turns don't blend (TTY: dim rule above,
    // matching rule below at every exit; non-TTY: plain `> text` echo). The
    // `── tools ──` divider nests inside this frame untouched.
    process.stdout.write(turnStart(displayText, renderOpts()));

    const MAX_TURNS = 40;
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      resetTurnDivider(`repl:${turn}`);
      await ctx.maybeCompact({
        onCompact: async ({ compactionCount }) => {
          const res = await engine.fire("PostCompact", { compactionCount });
          await appendEvent(session, { type: "compact", compactionCount });
          return res?.injects || [];
        },
      });

      let resp: ChatCompletion;
      const turnStartMs = Date.now();
      try {
        resp = await chat({
          model: currentModel,
          messages: ctx.messages,
          tools: TOOL_SPECS,
          config: providerConfig,
          onDelta: renderDelta,
          onRetry: (r: { attempt: number; reason: string; delay: number }) => {
            closeStream();
            process.stdout.write(`${YELLOW}   ⏳ retry ${r.attempt}: ${r.reason} (${r.delay}ms)${RESET}\n`);
          },
        });
      } catch (err: unknown) {
        closeStream();
        turnSummary.hadError = true;
        process.stdout.write(`\n${YELLOW}❌ ${toErrorMessage(err)}${RESET}\n`);
        process.stdout.write(turnEnd(renderOpts()));
        return turnSummary;
      }
      // Per-turn timing: wall-clock around chat() (includes retry backoff).
      lastTurnMs = Date.now() - turnStartMs;

      ctx.recordUsage(resp.usage);
      const u = resp.usage || {};
      const reasoning = reasoningTokens(u);
      cumulative.prompt += Number(u.prompt_tokens || 0) || 0;
      cumulative.completion += Number(u.completion_tokens || 0) || 0;
      cumulative.reasoning += reasoning;
      lastTurn = { prompt: Number(u.prompt_tokens || 0) || 0, completion: Number(u.completion_tokens || 0) || 0, reasoning };
      await appendEvent(session, { type: "usage", usage: u, cumulative: { ...cumulative } });

      closeStream();

      const assistantMsg = assistantMessageFrom(resp);
      ctx.push(assistantMsg);
      await appendEvent(session, {
        type: "assistant",
        content: resp.content || "",
        tool_calls: resp.tool_calls,
        // Persist GLM preserved thinking so --continue / /resume replay it.
        reasoning_content: resp.reasoning || null,
      });

      // text-only (no tool call) → end the turn, return control to the user
      if (!resp.tool_calls || resp.tool_calls.length === 0) {
        await engine.fire("Stop", { response: resp.content, finished: false });
        process.stdout.write(turnEnd(renderOpts()));
        return turnSummary;
      }

      // execute each tool call (Pre/PostToolUse hooks fire around it)
      writeTurnDivider();
      let finished = false;
      for (const tc of resp.tool_calls) {
        const toolName = String(tc.name);
        const handler = TOOL_HANDLERS[toolName];
        if (!handler) {
          const m = `Error: unknown tool '${toolName}'. Available: read_file, write_file, patch_file, list_dir, grep, run_shell, finish.`;
          ctx.push({ role: "tool", tool_call_id: tc.id, content: m });
          await appendEvent(session, { type: "tool", tool_call_id: tc.id, name: toolName, content: m });
          const signal = observeToolResult(adaptiveState, {
            toolName,
            toolInput: tc.arguments,
            result: m,
          });
          turnSummary.hadError = turnSummary.hadError || signal.hadError;
          turnSummary.wroteFiles = turnSummary.wroteFiles || signal.wroteFile;
          await maybeRouteForToolResult();
          continue;
        }
        const pre = await engine.fire("PreToolUse", {
          tool_name: toolName,
          tool_input: tc.arguments,
          tool_use_id: tc.id,
        });
        let resultStr: string;
        if (pre.blocks.length) {
          resultStr = `Blocked by hook:\n${pre.blocks.join("\n")}`;
          process.stdout.write(`${TOOL_INDENT}${ansi(YELLOW, renderOpts())}⛔ ${toolName} blocked: ${pre.blocks.join("; ")}${ansi(RESET, renderOpts())}\n`);
          // PreToolUse block is a failed tool outcome from the adaptive-routing
          // perspective: no tool actually ran, so count it toward errorStreak
          // so repeated denials can trigger recovery escalation.
          const signal = observeToolResult(adaptiveState, {
            toolName,
            toolInput: tc.arguments,
            result: resultStr,
          });
          turnSummary.hadError = turnSummary.hadError || signal.hadError;
          turnSummary.wroteFiles = turnSummary.wroteFiles || signal.wroteFile;
          await maybeRouteForToolResult();
        } else {
          process.stdout.write(`${formatToolCall(toolName, tc.arguments, renderOpts())}\n`);
          let result: ToolHandlerResult;
          let handlerThrew = false;
          try {
            result = await handler(tc.arguments, {
              cwd: dir,
              runtime: { engine, ctx, log: async (o: Record<string, unknown>) => appendEvent(session, { type: "log", ...o }) },
            });
          } catch (err: unknown) {
            handlerThrew = true;
            result = `Error executing ${toolName}: ${toErrorMessage(err)}`;
          }
          if (isFinishResult(result)) {
            finished = true;
            resultStr = `finish: ${result.summary}`;
            process.stdout.write(`${TOOL_INDENT}${ansi(GREEN, renderOpts())}✅ ${result.summary}${ansi(RESET, renderOpts())}\n`);
          } else {
            resultStr = typeof result === "string" ? result : JSON.stringify(result);
            process.stdout.write(`${formatToolResult(resultStr, renderOpts())}\n`);
          }
          const post = await engine.fire("PostToolUse", {
            tool_name: toolName,
            tool_input: tc.arguments,
            tool_response: resultStr,
            tool_use_id: tc.id,
          });
          if (post.blocks.length) resultStr += `\n\n[hook feedback — address] ${post.blocks.join(" | ")}`;
          if (post.feedbacks.length) resultStr += `\n\n[hook note] ${post.feedbacks.join(" | ")}`;
          const signal = observeToolResult(adaptiveState, {
            toolName,
            toolInput: tc.arguments,
            result: resultStr,
            handlerThrew,
          });
          turnSummary.hadError = turnSummary.hadError || signal.hadError;
          turnSummary.wroteFiles = turnSummary.wroteFiles || signal.wroteFile;
          await maybeRouteForToolResult();
        }
        ctx.push({ role: "tool", tool_call_id: tc.id, content: resultStr });
        await appendEvent(session, { type: "tool", tool_call_id: tc.id, name: toolName, content: truncate(resultStr, 2000) });
        if (finished) break;
      }
      if (finished) {
        await engine.fire("Stop", { response: "(finish)", finished: true });
        process.stdout.write(turnEnd(renderOpts()));
        return turnSummary;
      }
      // otherwise loop: the model continues with the tool results
    }
    closeStream();
    process.stdout.write(`\n   ${YELLOW}(turn limit reached — task may be incomplete)${RESET}\n`);
    process.stdout.write(turnEnd(renderOpts()));
    // An exhausted MAX_TURNS turn is incomplete work, not a routine turn.
    // Mark it as an error so adaptive routing does not count it toward the
    // routine-turn de-escalation streak. (Codex P2 review on PR #49.)
    turnSummary.hadError = true;
    return turnSummary;
  };

  const handleLine = async (raw: string): Promise<"exit" | void> => {
    const input = raw.trim();
    if (!input) return;
    if (input.startsWith("/")) {
      const r = await handleSlash(input);
      if (r === "exit") return "exit";
      return;
    }
    beginAdaptiveUserTurn(adaptiveState);
    // inline $skill invocation → expand the skill body into the user message
    let userContent = input;
    const skillName = detectSkillInvocation(input);
    if (skillName) {
      const skill = getSkill(skillName);
      if (skill) userContent = `${skill.body}\n\n---\n\nUSER REQUEST\n${input}`;
      else console.log(`${YELLOW}   (unknown skill: $${skillName})${RESET}`);
    }
    const promptSignal = observePromptIntake(adaptiveState, input);
    await maybeRouteForPrompt(promptSignal);
    const turnSummary = await runAgentTurn(userContent, input);
    await maybeRouteAfterUserTurn({
      ...(turnSummary || {}),
      explicitComplexity: promptSignal.explicitComplexity || !!turnSummary?.explicitComplexity,
    });
  };

  // 10. REPL loop: prompt → read line → handle → repeat (sequential via the queue)
  let closed = false;
  const prompt = (): void => {
    // Interactive prompt placement (PR #26 Codex P2):
    // - stdout TTY: write to stdout as before.
    // - stdout piped but stdin still a TTY (`lazyglm | tee transcript`):
    //   route the prompt to stderr so the human sees it while stdout stays a
    //   clean stream for piped consumers (no ANSI escape glueing).
    // - both non-TTY (full pipe / CI): no prompt at all.
    if (closed) return;
    const target = replPromptTarget({
      stdinIsTTY: process.stdin.isTTY === true && process.stderr.isTTY === true,
      stdoutIsTTY: process.stdout.isTTY === true,
    });
    if (target === "stdout") process.stdout.write(`${GREEN}lazyglm>${RESET} `);
    else if (target === "stderr") process.stderr.write(`${GREEN}lazyglm>${RESET} `);
  };

  while (!closed) {
    prompt();
    const line = await queue.next();
    if (line === null) break; // EOF
    try {
      const r = await handleLine(line);
      if (r === "exit") closed = true;
    } catch (e: unknown) {
      closeStream();
      console.error(`\n❌ ${toErrorMessage(e)}`);
    }
  }
  closeStream();
  process.stdout.write(`${formatExitMarker(renderOpts())}\n`);
  process.exit(0);
  return 0;
}
