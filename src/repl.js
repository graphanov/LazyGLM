// Interactive self-sustained REPL: `lazyglm` with no args launches a live
// agentic shell (like `claude` / `hermes`). Reuses provider.chat (streaming),
// Context, tools, hooks, and plugins — does NOT call runAgent (the one-shot
// path). Human-in-the-loop: a text-only response ends the turn and returns
// control to the user; the agent only auto-loops on tool calls within a turn.
import * as readline from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chat, resolveProviderConfig, shouldPreserveThinking } from "./agent/provider.js";
import { TOOL_SPECS, TOOL_HANDLERS } from "./agent/tools.js";
import { Context, assistantMessageFrom } from "./agent/context.js";
import { HookEngine } from "./hooks/engine.js";
import { loadPlugins } from "./plugins/index.js";
import { loadSkills, getSkill, detectSkillInvocation } from "./skills/index.js";
import { runOnboarding, needsOnboarding } from "./onboard.js";
import { createSession, appendEvent, listSessions, loadSessionEvents, lastSession } from "./sessions.js";
import { install } from "./installer.js";
import { runUltrawork } from "./ulw.js";
import { readJson, gitInfo, truncate, nowIso } from "./util.js";
import { renderBanner } from "./banner.js";
import { renderStatus } from "./status.js";
import { fileURLToPath } from "node:url";
import { dirname, join as pjoin } from "node:path";

const ROOT = pjoin(dirname(fileURLToPath(import.meta.url)), "..");

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

function ansi(code, { isTTY = true } = {}) {
  return isTTY ? code : "";
}

function displayValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatReasoning(text = "", opts = {}) {
  return `${ansi(GRAY, opts)}✶ ${text}`;
}

export function formatText(text = "") {
  return `💬 ${text}`;
}

export function formatToolCall(name, args = "", opts = {}) {
  const argText = truncate(displayValue(args), 100);
  return `${TOOL_INDENT}${ansi(CYAN, opts)}🔧 ${name}${ansi(RESET, opts)}${ansi(DIM, opts)}(${argText})${ansi(RESET, opts)}`;
}

export function formatToolResult(result = "", opts = {}) {
  const preview = truncate(displayValue(result), 400).replace(/\n/g, `\n${TOOL_INDENT}${ansi(GREEN, opts)}`);
  return `${TOOL_INDENT}${ansi(GREEN, opts)}↳ ${preview}${ansi(RESET, opts)}`;
}

export function turnDivider(opts = {}) {
  return `${TOOL_INDENT}${ansi(DIM, opts)}${TOOL_DIVIDER_RULE} tools ${TOOL_DIVIDER_RULE}${ansi(RESET, opts)}`;
}

export function formatExitMarker(opts = {}) {
  return `${ansi(DIM, opts)}bye.${ansi(RESET, opts)}`;
}

// Turn-boundary frame helpers (purely additive). Each assistant+tool turn is
// wrapped so consecutive turns stop blending. TTY: a dim fixed-width rule
// above and below the turn (symmetric). Non-TTY: a plain `> text` echo with
// zero ANSI and no rule, so piped output stays clean + parseable. The existing
// `── tools ──` divider nests inside this frame and is left untouched.
export function turnRule({ isTTY = true } = {}) {
  return isTTY ? `${DIM}${TURN_RULE}${RESET}` : "";
}

export function stripControlSequences(text = "") {
  return String(text).replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

export function turnStart(userText, { isTTY = true } = {}) {
  if (!isTTY) {
    // Single-line truncation: the shared truncate() inserts a newline before
    // its marker, which would break the "standalone `> text` line" contract
    // for piped output. Use a flat inline marker instead.
    const clean = stripControlSequences(userText ?? "");
    const display = clean.length > 100 ? clean.slice(0, 100) + "…" : clean;
    return `> ${display}\n`;
  }
  return `\n${turnRule({ isTTY })}\n`;
}

export function turnEnd({ isTTY = true } = {}) {
  if (!isTTY) return "";
  return `${turnRule({ isTTY })}\n\n`;
}

const REPL_PERSONA = `You are LazyGLM, a terminal-based AI coding agent connected directly to the user's file system via a CLI.

PERSONALITY:
You are a brilliant but "lazy" pragmatic developer. You hate writing unnecessary text, explanations, or filler. You believe code speaks louder than words. You do exactly what is asked, make the edit, and stop talking. Never say "Certainly!" or "I'd be happy to help." Just do the work. Be extremely concise. If the user didn't ask for an explanation, don't give one.

HOW YOU OPERATE (agentic — you have tools):
- To edit a file, use the patch_file tool (SEARCH/REPLACE: old_string → new_string). Never output whole files. Never paste SEARCH/REPLACE blocks into chat — invoke the tool.
- To see a file, use read_file / list_dir / grep autonomously. Do NOT ask the user to @mention or paste files — go look yourself.
- After making changes, verify with run_shell (build/test). Never claim success without verifying.
- Keep your terminal output clean and readable.
- When the user's request is fully done, call the finish tool with a one-line summary.`;

/**
 * A single readline interface over stdin that buffers lines and serves them
 * sequentially via next(). This is shared by onboarding and the REPL so that
 * piped / burst stdin is never lost between sequential consumers (a known
 * readline race when lines arrive faster than question listeners attach).
 * On a TTY, lines pop one per Enter (human-paced). On a pipe, all lines buffer
 * up front and are handed out in order.
 */
class LineQueue {
  constructor({ input, output }) {
    this.lines = [];
    this.waiters = [];
    this.closed = false;
    this.rl = readline.createInterface({ input, output });
    this.rl.on("line", (line) => {
      if (this.waiters.length) this.waiters.shift()(line);
      else this.lines.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      while (this.waiters.length) this.waiters.shift()(null);
    });
  }
  next() {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

// --- streaming renderer (shared across REPL turns and /ultrawork) ---
let streamOpen = false;
let streamMode = null; // "text" | "reasoning"
let toolDividerShown = false;
let toolDividerKey = null;

function renderOpts() {
  return { isTTY: process.stdout.isTTY === true };
}

function resetTurnDivider(key = null) {
  toolDividerKey = key;
  toolDividerShown = false;
}

function writeTurnDivider(key = toolDividerKey) {
  if (key !== toolDividerKey) resetTurnDivider(key);
  if (toolDividerShown) return;
  toolDividerShown = true;
  if (process.stdout.isTTY === true) process.stdout.write(`${turnDivider(renderOpts())}\n`);
}

function closeStream() {
  if (streamOpen) {
    process.stdout.write(ansi(RESET, renderOpts()) + "\n");
    streamOpen = false;
    streamMode = null;
  }
}

function renderDelta(d) {
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

function buildSystemPrompt({ cwd, git, model, injects }) {
  const parts = [REPL_PERSONA];
  parts.push(
    `\nENVIRONMENT\n- cwd: ${cwd}\n- git: ${git.isRepo ? `${git.branch} @ ${git.root}` : "(not a repo)"}\n- model: ${model}\n- date: ${nowIso()}\n- os: ${process.platform}`,
  );
  if (injects && injects.length) parts.push(`\nPROJECT CONTEXT (injected by hooks)\n${injects.join("\n\n")}`);
  return parts.join("\n");
}

function extractQuoted(s) {
  const m = s.match(/"([^"]*)"/);
  return m ? m[1] : null;
}
function extractFlag(s, flag) {
  const re = new RegExp(`--${flag}\\s+"([^"]*)"`);
  const m = s.match(re);
  return m ? m[1] : null;
}

export function replPromptTarget({ stdinIsTTY, stdoutIsTTY } = {}) {
  if (stdoutIsTTY) return "stdout";
  if (stdinIsTTY) return "stderr";
  return null;
}

/** Rebuild a Context's messages from a session's event records. */
export function replayIntoContext(events, ctx) {
  for (const ev of events) {
    if (ev.type === "user") {
      ctx.push({ role: "user", content: ev.content });
    } else if (ev.type === "assistant") {
      const m = { role: "assistant", content: ev.content || "" };
      // Restore GLM preserved thinking so resumed sessions replay prior
      // reasoning_content across turns (the provider gates the wire payload).
      if (ev.reasoning_content) m.reasoning_content = ev.reasoning_content;
      if (ev.tool_calls && ev.tool_calls.length) {
        m.tool_calls = ev.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      ctx.push(m);
    } else if (ev.type === "tool") {
      ctx.push({ role: "tool", tool_call_id: ev.tool_call_id, content: ev.content });
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
export function replayTelemetry(events) {
  const cumulative = { prompt: 0, completion: 0, reasoning: 0 };
  let lastTurn = null;
  let sessionStartMs = Date.now();
  for (const ev of events || []) {
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
      const u = ev.usage;
      if (u && typeof u === "object") {
        const reasoning = u.completion_tokens_details?.reasoning_tokens || u.reasoning_tokens || 0;
        cumulative.prompt += u.prompt_tokens || 0;
        cumulative.completion += u.completion_tokens || 0;
        cumulative.reasoning += reasoning;
        lastTurn = { prompt: u.prompt_tokens || 0, completion: u.completion_tokens || 0, reasoning };
      }
    }
  }
  return { cumulative, lastTurn, sessionStartMs };
}

/** Render runAgent / runUltrawork events into the REPL (compact). */
function renderUltraworkEvent(ev) {
  switch (ev.type) {
    case "start":
      resetTurnDivider("ultrawork:start");
      console.log(`\n🚀 iteration start | model: ${ev.model} | task: ${truncate(ev.task, 120)}`);
      break;
    case "reasoning_delta":
      renderDelta({ type: "reasoning", text: ev.text });
      break;
    case "assistant_delta":
      renderDelta({ type: "text", text: ev.text });
      break;
    case "tool_call_start":
      closeStream();
      break;
    case "tool_call":
      closeStream();
      writeTurnDivider(ev.turn === undefined ? "ultrawork" : `ultrawork:${ev.turn}`);
      console.log(formatToolCall(ev.name, ev.input, renderOpts()));
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
      console.log(`${GREEN}   ✅ ${truncate(ev.summary, 400)}${RESET}`);
      break;
    case "ultrawork_iteration":
      closeStream();
      console.log(`\n${CYAN}🔁 iteration ${ev.iteration}/${ev.max}${RESET}`);
      break;
    case "ultrawork_verify":
      console.log(`   verify: ${ev.pass ? GREEN + "PASS ✅" : YELLOW + "FAIL ❌"}${RESET} — ${truncate(ev.reason, 200)}`);
      break;
    case "retry":
      closeStream();
      console.log(`${YELLOW}   ⏳ retry ${ev.attempt}: ${ev.reason}${RESET}`);
      break;
    case "compact":
      console.log(`${DIM}   (compacted #${ev.compactionCount})${RESET}`);
      break;
    case "blocked":
      console.log(`${YELLOW}   ⛔ ${ev.tool}: ${ev.reasons.join("; ")}${RESET}`);
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
export async function launchREPL({ cwd, flags = {} } = {}) {
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
    } catch (e) {
      console.error(`\n❌ ${e.message}`);
      process.exit(1);
    }
  }

  // 2. Resolve provider config (env > config file > catalog default)
  let providerConfig;
  try {
    providerConfig = await resolveProviderConfig({ model: flags.model, provider: flags.provider, role: "default" });
  } catch (e) {
    console.error(`\n❌ ${e.message}`);
    process.exit(1);
  }
  let currentModel = providerConfig.modelId;

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
  const ctx = new Context({ model: currentModel, budget: 24_000, preserveThinking: shouldPreserveThinking(providerConfig.provider) });
  const startRes = await engine.fire("SessionStart", {});
  const system = buildSystemPrompt({ cwd: dir, git: gi, model: currentModel, injects: startRes.injects });
  ctx.setSystem(system);

  let yolo = !!flags.yolo;
  engine.setMeta({ model: currentModel, transcriptPath: null, permissionMode: yolo ? "yolo" : "auto" });

  // 6. Cost tracking
  const cumulative = { prompt: 0, completion: 0, reasoning: 0 };
  // Last-turn usage + timing snapshot, surfaced by /status. lastTurn is null
  // until the first turn completes; lastTurnMs includes retry backoff (wall-clock
  // around chat()), so it is a human-facing figure, not a latency benchmark.
  let lastTurn = null;
  let lastTurnMs = null;
  let sessionStartMs = Date.now();
  const restoreTelemetry = (events) => {
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
  let session;
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
      isTTY: process.stdout.isTTY ?? false,
    }),
  );

  // --- slash commands (closure over mutable REPL state) ---
  const handleSlash = async (input) => {
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
  /status               show session, model, role/effort, timing, and token totals
  /cost                 show cumulative token spend (incl. reasoning)
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
        ctx.messages = ctx.messages.filter((m) => m.role === "system");
        ctx.decisions.length = 0;
        ctx.compactionCount = 0;
        console.log(`${DIM}   (context cleared)${RESET}`);
        return;
      case "model": {
        if (!argStr) {
          console.log(`   current model: ${currentModel}`);
          const cat = await readJson(pjoin(ROOT, "config", "model-catalog.json"), {});
          console.log(`   available: ${Object.keys(cat.models || {}).join(", ")}`);
          return;
        }
        try {
          const nc = await resolveProviderConfig({ model: argStr, provider: flags.provider, role: "default" });
          providerConfig = nc;
          currentModel = nc.modelId;
          ctx.model = currentModel;
          // A /model switch can change the provider (e.g. zai → ollama), which
          // flips whether reasoning_content is on the wire. Keep the budget
          // estimator in sync so compaction decisions match the new payload.
          ctx.preserveThinking = shouldPreserveThinking(nc.provider);
          engine.setMeta({ model: currentModel });
          console.log(`${GREEN}   ✓ model: ${currentModel}${RESET}`);
        } catch (e) {
          console.log(`${YELLOW}   ✗ ${e.message}${RESET}`);
        }
        return;
      }
      case "cost":
        console.log(`   tokens in/out: ${cumulative.prompt}/${cumulative.completion} | ${GRAY}🧠 reasoning: ${cumulative.reasoning}${RESET}`);
        return;
      case "status": {
        // Derive reasoningEffort at /status time from the live role + catalog
        // (mirrors router.js pickModel: roleEntry.reasoning_effort ||
        // catalog.current.model_reasoning_effort). Done here so a /model switch
        // is reflected without threading effort through providerConfig's return.
        let effort = "high";
        let role = providerConfig.role || "default";
        try {
          const cat = await readJson(pjoin(ROOT, "config", "model-catalog.json"), {});
          const roleEntry = cat.roles?.[role] || cat.roles?.default || {};
          effort = roleEntry.reasoning_effort || cat.current?.model_reasoning_effort || "high";
        } catch {
          // catalog read failure is non-fatal for a status line
        }
        console.log(
          renderStatus({
            sessionId: session?.id,
            model: currentModel,
            provider: providerConfig.provider,
            role,
            reasoningEffort: effort,
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
        ctx.messages = ctx.messages.filter((m) => m.role === "system");
        ctx.decisions.length = 0;
        ctx.compactionCount = 0;
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
        console.log(`\n${CYAN}🔁 ULTRAWORK${RESET} — task: ${truncate(task, 120)}`);
        if (verifyCommand) console.log(`   verify: ${verifyCommand}`);
        const res = await runUltrawork({
          task,
          cwd: dir,
          model: currentModel,
          role: "ultrabrain",
          config: providerConfig,
          completionPromise,
          verifyCommand,
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
  const runAgentTurn = async (userContent, displayText = userContent) => {
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

      let resp;
      const turnStartMs = Date.now();
      try {
        resp = await chat({
          model: currentModel,
          messages: ctx.messages,
          tools: TOOL_SPECS,
          config: providerConfig,
          onDelta: renderDelta,
          onRetry: (r) => {
            closeStream();
            process.stdout.write(`${YELLOW}   ⏳ retry ${r.attempt}: ${r.reason} (${r.delay}ms)${RESET}\n`);
          },
        });
      } catch (err) {
        closeStream();
        process.stdout.write(`\n${YELLOW}❌ ${err.message}${RESET}\n`);
        process.stdout.write(turnEnd(renderOpts()));
        return;
      }
      // Per-turn timing: wall-clock around chat() (includes retry backoff).
      lastTurnMs = Date.now() - turnStartMs;

      ctx.recordUsage(resp.usage);
      const u = resp.usage || {};
      const reasoning = u.completion_tokens_details?.reasoning_tokens || u.reasoning_tokens || 0;
      cumulative.prompt += u.prompt_tokens || 0;
      cumulative.completion += u.completion_tokens || 0;
      cumulative.reasoning += reasoning;
      lastTurn = { prompt: u.prompt_tokens || 0, completion: u.completion_tokens || 0, reasoning };
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
        return;
      }

      // execute each tool call (Pre/PostToolUse hooks fire around it)
      writeTurnDivider();
      let finished = false;
      for (const tc of resp.tool_calls) {
        const handler = TOOL_HANDLERS[tc.name];
        if (!handler) {
          const m = `Error: unknown tool '${tc.name}'. Available: read_file, write_file, patch_file, list_dir, grep, run_shell, finish.`;
          ctx.push({ role: "tool", tool_call_id: tc.id, content: m });
          await appendEvent(session, { type: "tool", tool_call_id: tc.id, name: tc.name, content: m });
          continue;
        }
        const pre = await engine.fire("PreToolUse", {
          tool_name: tc.name,
          tool_input: tc.arguments,
          tool_use_id: tc.id,
        });
        let resultStr;
        if (pre.blocks.length) {
          resultStr = `Blocked by hook:\n${pre.blocks.join("\n")}`;
          process.stdout.write(`${TOOL_INDENT}${ansi(YELLOW, renderOpts())}⛔ ${tc.name} blocked: ${pre.blocks.join("; ")}${ansi(RESET, renderOpts())}\n`);
        } else {
          process.stdout.write(`${formatToolCall(tc.name, tc.arguments, renderOpts())}\n`);
          let result;
          try {
            result = await handler(tc.arguments, {
              cwd: dir,
              runtime: { engine, ctx, log: async (o) => appendEvent(session, { type: "log", ...o }) },
            });
          } catch (err) {
            result = `Error executing ${tc.name}: ${err?.message || err}`;
          }
          if (result && result.__finish) {
            finished = true;
            resultStr = `finish: ${result.summary}`;
            process.stdout.write(`${TOOL_INDENT}${ansi(GREEN, renderOpts())}✅ ${result.summary}${ansi(RESET, renderOpts())}\n`);
          } else {
            resultStr = typeof result === "string" ? result : JSON.stringify(result);
            process.stdout.write(`${formatToolResult(resultStr, renderOpts())}\n`);
          }
          const post = await engine.fire("PostToolUse", {
            tool_name: tc.name,
            tool_input: tc.arguments,
            tool_response: resultStr,
            tool_use_id: tc.id,
          });
          if (post.blocks.length) resultStr += `\n\n[hook feedback — address] ${post.blocks.join(" | ")}`;
          if (post.feedbacks.length) resultStr += `\n\n[hook note] ${post.feedbacks.join(" | ")}`;
        }
        ctx.push({ role: "tool", tool_call_id: tc.id, content: resultStr });
        await appendEvent(session, { type: "tool", tool_call_id: tc.id, name: tc.name, content: truncate(resultStr, 2000) });
        if (finished) break;
      }
      if (finished) {
        await engine.fire("Stop", { response: "(finish)", finished: true });
        process.stdout.write(turnEnd(renderOpts()));
        return;
      }
      // otherwise loop: the model continues with the tool results
    }
    closeStream();
    process.stdout.write(`\n   ${YELLOW}(turn limit reached — task may be incomplete)${RESET}\n`);
    process.stdout.write(turnEnd(renderOpts()));
  };

  const handleLine = async (raw) => {
    const input = raw.trim();
    if (!input) return;
    if (input.startsWith("/")) {
      const r = await handleSlash(input);
      if (r === "exit") return "exit";
      return;
    }
    // inline $skill invocation → expand the skill body into the user message
    let userContent = input;
    const skillName = detectSkillInvocation(input);
    if (skillName) {
      const skill = getSkill(skillName);
      if (skill) userContent = `${skill.body}\n\n---\n\nUSER REQUEST\n${input}`;
      else console.log(`${YELLOW}   (unknown skill: $${skillName})${RESET}`);
    }
    await runAgentTurn(userContent, input);
  };

  // 10. REPL loop: prompt → read line → handle → repeat (sequential via the queue)
  let closed = false;
  const prompt = () => {
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
    } catch (e) {
      closeStream();
      console.error(`\n❌ ${e?.message || e}`);
    }
  }
  closeStream();
  process.stdout.write(`${formatExitMarker(renderOpts())}\n`);
  process.exit(0);
  return 0;
}
