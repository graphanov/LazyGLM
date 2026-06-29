// Dep-free, side-effect-free boot banner renderer for the LazyGLM REPL.
//
// Pure by design: renderBanner() does NOT touch process.stdout/stdin, read the
// environment, or import anything. It takes explicit inputs and returns a single
// string. That makes it unit-testable without spawning a process, and reusable
// later by the one-shot `run` path and `doctor`.
//
// Two render modes, driven by the caller-supplied `isTTY`:
//   • isTTY true  -> ASCII `LAZYGLM` wordmark (cyan->gray 256-color gradient) +
//                    a Unicode-bordered info panel. Tasteful, for humans.
//   • isTTY false -> a single machine-readable line, ZERO ANSI, no art:
//                    `LazyGLM | <model> | <provider> | <cwd>`
//                    Pipes / CI logs are never corrupted by escape codes.
//
// Public-safety: nothing in this module hardcodes author names, handles, emails,
// or absolute home paths. Only the caller-supplied `cwd` may appear in output.

// --- palette (same raw ANSI codes the REPL already uses; no new colors) ---
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GRAY = "\x1b[90m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";

// --- cyan -> gray 256-color gradient for the wordmark (one step per row) ---
const GRADIENT = ["\x1b[38;5;51m", "\x1b[38;5;45m", "\x1b[38;5;39m", "\x1b[38;5;102m", "\x1b[38;5;245m"];

// --- ASCII `LAZYGLM` wordmark. Hand-authored, fixed 58-col width, 5 rows tall.
// The previous tiny hash glyphs were readable but underwhelming. This keeps the
// banner dependency-free and plain ASCII while giving the CLI a stronger,
// better-aligned first impression. Exported so tests stay in sync with the art
// without coupling to magic strings. ---
export const WORDMARK = [
  " _        _     ______   __   __   _____   _       __  __ ",
  "| |      / \\   |__  / \\  \\ \\ / /  / ____| | |     |  \\/  |",
  "| |     / _ \\    / /   \\  \\ V /  | |  __  | |     | |\\/| |",
  "| |___ / ___ \\  / /_      | |   | |__| |  | |___  | |  | |",
  "|_____/_/   \\_\\/____|     |_|    \\_____|  |_____| |_|  |_|",
];
const WORDMARK_WIDTH = WORDMARK[0].length;

// --- box characters: Unicode (light) under TTY, ASCII (+ - |) otherwise.
// Only the TTY path actually draws a box, but the helper degrades correctly so a
// future caller (doctor / run) can render an ASCII frame without ANSI. ---
const BOX = {
  tty: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  ascii: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
};

const PANEL_WIDTH = WORDMARK_WIDTH - 4; // panel total width aligns with the wordmark
const LABEL_WIDTH = 9; // left-aligned label field (model/provider/cwd/...)

export interface BannerGitInfo {
  isRepo: boolean;
  branch?: string | null;
  root?: string | null;
}

export interface BannerSessionInfo {
  id?: string | null;
}

export interface BannerOptions {
  model?: string | null;
  provider?: string | null;
  cwd?: string | null;
  git?: BannerGitInfo | null;
  session?: BannerSessionInfo | null;
  yolo?: boolean;
  tier?: string | null;
  tierReason?: string | null;
  isTTY?: boolean;
}

// Visible-width helpers so styled rows (with raw ANSI codes) still pad to the
// panel width. Escape sequences render as 0 cols but inflate String.length, and
// some glyphs (⚡, emoji, CJK) render as 2 cols — both must be accounted for or
// the panel's right border misaligns. This is a minimal wcwidth approximation:
// emoji / dingbat / CJK ranges count as 2, everything else as 1.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function isWide(cp: number | undefined): boolean {
  if (cp == null) return false;
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x2600 && cp <= 0x27bf) // misc symbols & dingbats (incl ⚡ U+26A1)
  );
}
function renderedWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, "")) w += isWide(ch.codePointAt(0)) ? 2 : 1;
  return w;
}
function padVisible(s: string, width: number): string {
  const v = renderedWidth(s);
  return v >= width ? s : s + " ".repeat(width - v);
}

/** Trailing-truncate `s` to a max RENDERED width, keeping the leading part + `…`. */
function truncateToWidth(s: unknown, maxW: number): string {
  const str = String(s ?? "");
  if (renderedWidth(str) <= maxW) return str;
  if (maxW <= 1) return "…";
  let acc = "";
  let w = 0;
  for (const ch of str) {
    const cw = isWide(ch.codePointAt(0)) ? 2 : 1;
    if (w + cw > maxW - 1) break; // reserve 1 col for the ellipsis
    acc += ch;
    w += cw;
  }
  return acc + "…";
}

function centerVisible(s: string, width: number): string {
  const value = truncateToWidth(s, width);
  const v = renderedWidth(value);
  if (v >= width) return value;
  const left = Math.floor((width - v) / 2);
  const right = width - v - left;
  return " ".repeat(left) + value + " ".repeat(right);
}

function cleanSegment(value: unknown): string {
  return String(value ?? "").replace(/[|\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

/** One `label  value` row, padded to exactly `width` rendered columns. */
function fieldRow(label: string, value: unknown, width: number): string {
  const labelField = label ? String(label).padEnd(LABEL_WIDTH) : "";
  const valueField = truncateToWidth(value, width - renderedWidth(labelField));
  return padVisible(labelField + valueField, width);
}

/**
 * Render the LazyGLM boot banner as a single string (newline-separated).
 *
 * @param {object} opts
 * @param {string} opts.model      - active model id (e.g. "glm-5.2")
 * @param {string} opts.provider   - active provider (e.g. "zai")
 * @param {string} opts.cwd        - working directory
 * @param {object} [opts.git]      - { isRepo, branch, root } from gitInfo()
 * @param {object} [opts.session]  - { id, ... } from createSession(); omitted => no session line
 * @param {boolean} [opts.yolo]    - render the yolo line when true
 * @param {string} [opts.tier]     - catalog tier for the active model
 * @param {string} [opts.tierReason] - catalog-derived tier guidance
 * @param {boolean} [opts.isTTY]   - true => art + panel; false/undefined => one clean line
 * @returns {string} the full banner (no console writes, no process reads)
 */
export function renderBanner({
  model,
  provider,
  cwd,
  git,
  session,
  yolo,
  tier,
  tierReason,
  isTTY,
}: BannerOptions = {}): string {
  const m = model ?? "?";
  const p = provider ?? "?";
  const dir = cwd ?? "";
  const g = git && typeof git === "object" ? git : { isRepo: false };
  const tty = !!isTTY;

  // Non-TTY: one machine-readable line, no ANSI, no art.
  if (!tty) {
    const parts = ["LazyGLM", m, p, dir];
    if (tier) parts.push(`tier=${cleanSegment(tier)}`);
    if (tierReason) parts.push(`guidance=${cleanSegment(tierReason)}`);
    return `${parts.join(" | ")}\n`;
  }

  const out: string[] = [];
  out.push(""); // leading blank line for breathing room

  // Wordmark with per-row cyan->gray gradient.
  for (let r = 0; r < WORDMARK.length; r++) {
    out.push(`${GRADIENT[r]}${WORDMARK[r]}${RESET}`);
  }
  out.push(`${DIM}${centerVisible("GLM-native coding agent", WORDMARK_WIDTH)}${RESET}`);
  out.push("");

  // Info panel.
  const b = BOX.tty;
  const rows: string[] = [];
  rows.push(fieldRow("model", m, PANEL_WIDTH));
  if (tier) rows.push(fieldRow("tier", tier, PANEL_WIDTH));
  if (tierReason) rows.push(fieldRow("guidance", tierReason, PANEL_WIDTH));
  rows.push(fieldRow("provider", p, PANEL_WIDTH));
  rows.push(fieldRow("cwd", dir, PANEL_WIDTH));
  if (g.isRepo && g.branch) rows.push(fieldRow("git", g.branch, PANEL_WIDTH));
  if (session && session.id) rows.push(fieldRow("session", session.id, PANEL_WIDTH));
  if (yolo) rows.push(padVisible(`${YELLOW}⚡ yolo mode — all permission gates bypassed${RESET}`, PANEL_WIDTH));
  rows.push(padVisible(`${DIM}/help · /resume · /ultrawork · /skills${RESET}`, PANEL_WIDTH));

  // Box geometry: each body line is `v + " " + content(PANEL_WIDTH) + " " + v`,
  // so the run between the corners is PANEL_WIDTH + 2 cols. Top/bottom borders
  // match that width so the panel is rectangular on any terminal. The top border
  // embeds a cyan title.
  const innerRun = PANEL_WIDTH + 2;
  const titleText = " LazyGLM "; // 9 visible cols
  const ruleAfter = b.h.repeat(innerRun - 2 - titleText.length); // pad right of title
  out.push(`${GRAY}${b.tl}${b.h}${b.h}${RESET}${titleText.replace("LazyGLM", `${CYAN}LazyGLM${RESET}${GRAY}`)}${ruleAfter}${b.tr}${RESET}`);
  for (const row of rows) {
    out.push(`${GRAY}${b.v}${RESET} ${row} ${GRAY}${b.v}${RESET}`);
  }
  out.push(`${GRAY}${b.bl}${b.h.repeat(innerRun)}${b.br}${RESET}`);
  out.push(""); // trailing blank line

  return out.join("\n");
}
