// Dep-free, side-effect-free on-demand status/telemetry renderer for the
// LazyGLM REPL (`/status`).
//
// Pure by design: renderStatus() does NOT touch process.stdout/stdin, read the
// environment, or import anything. It takes explicit inputs and returns a
// single string. Mirrors the contract of banner.js so it is unit-testable
// without spawning a process.
//
// Two render modes, driven by the caller-supplied `isTTY`:
//   • isTTY true  -> a single compact human line with ANSI accents.
//   • isTTY false -> a single machine-readable key=value line, ZERO ANSI, so
//                    pipes / CI logs are never corrupted by escape codes.
//
// Credits: no supported provider (zai/nous/ollama) exposes a remaining-balance
// field in the chat-completions response, and the issue explicitly forbids an
// extra authenticated call to fetch one. Therefore credits always render as
// `n/a` (TTY) / `unsupported` (non-TTY) — a clear unavailable state, never an
// estimate or fake value.

const RESET = "\x1b[0m";
const GRAY = "\x1b[90m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

interface TokenCounts {
  prompt?: number;
  completion?: number;
  reasoning?: number;
}

export interface StatusOptions {
  sessionId?: string | null;
  model?: string | null;
  provider?: string | null;
  role?: string | null;
  reasoningEffort?: string | null;
  tier?: string | null;
  tierReason?: string | null;
  cumulative?: TokenCounts | null;
  lastTurn?: TokenCounts | null;
  sessionElapsedMs?: number | null;
  lastTurnMs?: number | null;
  isTTY?: boolean;
}

function cleanSegment(value: unknown): string {
  return String(value ?? "").replace(/[|\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function truncateToChars(value: unknown, max = 96): string {
  const text = cleanSegment(value);
  return text.length > max ? text.slice(0, Math.max(0, max - 1)) + "…" : text;
}

/** Human-readable duration for the TTY line (e.g. "2m13s", "4.2s", "0ms"). */
function humanizeMs(ms: number | null | undefined): string {
  const n = Number(ms) || 0;
  if (n < 1000) return `${Math.max(0, Math.round(n))}ms`;
  const s = n / 1000;
  // Round total seconds before choosing seconds-vs-minutes so upper-boundary
  // values render as 1m0s/2m0s, never 60s or 1m60s.
  const totalSec = Math.max(0, Math.round(s));
  if (totalSec < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(totalSec / 60);
  const rem = totalSec % 60;
  return `${m}m${rem}s`;
}

/**
 * Render a compact on-demand status/telemetry line as a single string.
 *
 * @param {object} opts
 * @param {string} opts.sessionId       - active session id
 * @param {string} [opts.model]         - active model id (e.g. "glm-5.2")
 * @param {string} [opts.provider]      - active provider (e.g. "zai")
 * @param {string} [opts.role]          - routing role (e.g. "default")
 * @param {string} [opts.reasoningEffort] - "high"|"low"|... from the catalog role
 * @param {string} [opts.tier]          - catalog tier for the active model
 * @param {string} [opts.tierReason]    - catalog-derived tier guidance
 * @param {object} [opts.cumulative]    - { prompt, completion, reasoning } running totals
 * @param {object} [opts.lastTurn]      - { prompt, completion, reasoning } for the last turn
 * @param {number} [opts.sessionElapsedMs] - wall-clock ms since session start
 * @param {number} [opts.lastTurnMs]    - wall-clock ms the last turn took
 * @param {boolean} [opts.isTTY]        - true => compact ANSI line; false/undefined => key=value
 * @returns {string} one newline-terminated line (no console writes, no process reads)
 */
export function renderStatus({
  sessionId,
  model,
  provider,
  role,
  reasoningEffort,
  tier,
  tierReason,
  cumulative,
  lastTurn,
  sessionElapsedMs,
  lastTurnMs,
  isTTY,
}: StatusOptions = {}): string {
  const sid = sessionId ?? "?";
  const m = model ?? "?";
  const p = provider ?? "?";
  const r = role ?? "default";
  const effort = reasoningEffort ?? "high";
  const c: TokenCounts = cumulative && typeof cumulative === "object" ? cumulative : { prompt: 0, completion: 0, reasoning: 0 };
  const lt = lastTurn && typeof lastTurn === "object" ? lastTurn : null;
  const sElapsed = humanizeMs(sessionElapsedMs);
  const tElapsed = lastTurnMs != null ? humanizeMs(lastTurnMs) : "—";

  // Non-TTY: one machine-readable line, no ANSI, no art. Pipe-parseable key=value.
  if (!isTTY) {
    const parts = [
      "LazyGLM status",
      `session=${sid}`,
      `model=${m}`,
      `provider=${p}`,
      `role=${r}`,
      `effort=${effort}`,
    ];
    if (tier) parts.push(`tier=${cleanSegment(tier)}`);
    if (tierReason) parts.push(`tier_reason=${cleanSegment(tierReason)}`);
    parts.push(
      `turn_ms=${lastTurnMs != null ? Math.max(0, Math.round(Number(lastTurnMs) || 0)) : ""}`,
      `session_ms=${Math.max(0, Math.round(Number(sessionElapsedMs) || 0))}`,
      `prompt=${c.prompt || 0}`,
      `completion=${c.completion || 0}`,
      `reasoning=${c.reasoning || 0}`,
    );
    if (lt) {
      parts.push(`last_prompt=${lt.prompt || 0}`);
      parts.push(`last_completion=${lt.completion || 0}`);
      parts.push(`last_reasoning=${lt.reasoning || 0}`);
    }
    parts.push("credits=unsupported");
    return parts.join(" | ");
  }

  // TTY: a single compact, ANSI-accented line for humans.
  const tot = (c.prompt || 0) + (c.completion || 0);
  let line =
    `${GRAY}   ${sid}${RESET} ${DIM}|${RESET} ` +
    `${CYAN}${m}${RESET} ${DIM}·${RESET} ${p} ${DIM}|${RESET} ` +
    `${DIM}role${RESET} ${r}/${effort} ${DIM}|${RESET} ` +
    (tier ? `${DIM}tier${RESET} ${tier}${tierReason ? `: ${truncateToChars(tierReason)}` : ""} ${DIM}|${RESET} ` : "") +
    `${GRAY}⏱${RESET} turn ${tElapsed} ${DIM}·${RESET} session ${sElapsed} ${DIM}|${RESET} ` +
    `${DIM}tok${RESET} ${c.prompt || 0}↑/${c.completion || 0}↓ (${GRAY}🧠 ${c.reasoning || 0}${RESET}) ${DIM}|${RESET} ` +
    `${GRAY}credits: n/a${RESET}`;
  return line;
}

// Exported for tests so the strip helper stays in sync with the module's
// understanding of an ANSI escape sequence (mirrors banner.js's ANSI_RE).
export { ANSI_RE };
