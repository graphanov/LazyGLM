// Message context + compaction for the agent loop. Keeps a running estimate
// of token usage and compacts the middle of the transcript when over budget.
//
// Compaction design (0.1.0 hardening):
//   - The original task message is PINNED — never dropped — so the agent never
//     loses sight of what it was asked to do.
//   - The dropped middle is replaced by a deterministic digest (files written,
//     commands run, errors hit, agent notes, and decisions/rationale), not a
//     generic placeholder. This is the operational memory that stops the agent
//     from re-doing work or thrashing after a compaction.
import { nowIso, truncate } from "../util.js";

const CHARS_PER_TOKEN = 4; // rough estimate

/**
 * Build a wire-format assistant message from a provider chat() response,
 * preserving GLM `reasoning_content` (preserved thinking) verbatim.
 *
 * Both the one-shot runtime (runtime.js, also covering /ultrawork) and the
 * REPL (repl.js) build their next-turn assistant message through this helper,
 * so preserved thinking is replayed across turns in both call paths.
 *
 * The provider response carries tool_calls in the internal form
 * `{id, type, name, arguments(object)}`; the wire form z.ai/OpenAI expect is
 * `{id, type:"function", function:{name, arguments:string}}`.
 *
 * @param {object} resp  - { content, reasoning, tool_calls, ... }
 * @returns {{role:"assistant", content:string, reasoning_content?:string, tool_calls?:Array}}
 */
export function assistantMessageFrom(resp) {
  const msg = { role: "assistant", content: resp?.content || "" };
  if (resp?.reasoning) {
    msg.reasoning_content = resp.reasoning;
  }
  if (resp?.tool_calls?.length) {
    msg.tool_calls = resp.tool_calls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
  }
  return msg;
}

export class Context {
  constructor({ model = "", budget = 24_000, preserveThinking = true } = {}) {
    this.model = model;
    this.budget = budget; // soft token budget for the rolling window
    // Whether reasoning_content counts toward the budget. It only occupies the
    // wire payload for providers that keep it (zai / LAZYGLM_PRESERVE_THINKING=on);
    // stripping providers never send it, so counting it would force premature
    // compaction. Set from shouldPreserveThinking(provider) by the runtime/REPL.
    this.preserveThinking = preserveThinking;
    this.messages = [];
    this.compactionCount = 0;
    this.totalTokensIn = 0;
    this.totalTokensOut = 0;
    this.decisions = [];
  }

  setSystem(text) {
    const existing = this.messages.findIndex((m) => m.role === "system");
    const msg = { role: "system", content: text };
    if (existing >= 0) this.messages[existing] = msg;
    else this.messages.unshift(msg);
  }

  push(msg) {
    this.messages.push(msg);
  }

  addDecision(text) {
    const decision = normalizeDecision(text);
    if (!decision) return;
    this.decisions.push(decision);
    if (this.decisions.length > 12) this.decisions.shift();
  }

  getDecisions() {
    return [...this.decisions];
  }

  estimateTokens() {
    let chars = 0;
    for (const m of this.messages) {
      chars += (m.content?.length || 0);
      // Preserved thinking counts toward the budget only when it's actually on
      // the wire (this.preserveThinking). Stripping providers never send
      // reasoning_content, so counting it would force premature compaction.
      if (this.preserveThinking && m.reasoning_content) chars += m.reasoning_content.length;
      if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }

  /**
   * Compact if over budget. Preserves:
   *   - the system prompt
   *   - the original task message (PINNED — never dropped)
   *   - a deterministic digest of the dropped middle (files/commands/errors/notes/decisions)
   *   - the most recent `keepRecent` messages
   * Fires `onCompact` so the hook engine can react. Returns true if compaction occurred.
   */
  async maybeCompact({ onCompact, force = false } = {}) {
    const tokens = this.estimateTokens();
    if (!force && tokens <= this.budget) return false;
    const keepRecent = 12;
    if (this.messages.length <= keepRecent + 2) return false;

    const system = this.messages[0]?.role === "system" ? this.messages[0] : null;
    const rest = system ? this.messages.slice(1) : this.messages;

    // Pin the original task (first message after system — the user's task,
    // possibly bundled with UserPromptSubmit hook injects).
    const taskMsg = rest[0];

    const tailStart = Math.max(1, rest.length - keepRecent);
    const tail = rest.slice(tailStart);
    const dropped = rest.slice(1, tailStart); // everything between task and recent tail

    const newDecisions = extractDecisions(dropped);
    for (const decision of newDecisions) {
      if (!this.decisions.includes(decision)) this.addDecision(decision);
    }
    const digest = buildDigest(dropped, this.getDecisions());

    const summary = {
      role: "system",
      content:
        `[Compacted transcript — ${dropped.length} earlier messages digested at ${nowIso()} to fit the GLM context window.]\n\n` +
        `${digest}\n\n` +
        `The user's original task is restated in the message immediately above this one. ` +
        `Continue from the most recent messages. Do not re-ask what was already discussed or re-do work listed in the digest above.`,
    };

    this.messages = [system, taskMsg, summary, ...tail].filter(Boolean);
    this.compactionCount += 1;
    let injects = [];
    if (onCompact) {
      const res = await onCompact({ compactionCount: this.compactionCount, droppedTokens: tokens });
      if (Array.isArray(res)) injects = res;
    }
    if (injects.length) {
      // PostCompact injects are one-shot context for the current window.
      // They are NOT persisted across subsequent compactions (buildDigest has
      // no system-role branch). Decisions persist separately via this.decisions.
      const summaryIdx = this.messages.indexOf(summary);
      if (summaryIdx >= 0) {
        this.messages.splice(summaryIdx + 1, 0, { role: "system", content: injects.join("\n\n") });
      }
    }
    return true;
  }

  recordUsage(usage) {
    if (!usage) return;
    this.totalTokensIn += usage.prompt_tokens || 0;
    this.totalTokensOut += usage.completion_tokens || 0;
  }
}

function safeParse(s) {
  if (!s) return {};
  if (typeof s !== "string") return s;
  try { return JSON.parse(s); } catch { return {}; }
}

const DECISION_CUES = [
  /\bdecided?\b/i,
  /\bchose\b/i,
  /\bthe (?:plan|approach|design) is\b/i,
  /\brationale\b/i,
  /\bgoing with\b.*\bbecause\b/i,
];

function normalizeDecision(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= 200) return s;
  // Keep decisions on a single line: the shared truncate() appends a newline
  // plus marker, which would split a numbered digest entry. Use an inline
  // ellipsis here so each decision stays one digest line.
  return s.slice(0, 197) + "…";
}

function extractSentences(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  return normalized.match(/[^.!?]+[.!?]?(?=\s|$)/g) || [normalized];
}

function extractDecisions(dropped) {
  const decisions = [];
  const seen = new Set();

  for (const m of dropped) {
    if (m.role !== "assistant") continue;
    if (typeof m.content !== "string") continue;

    for (const sentence of extractSentences(m.content)) {
      const decision = normalizeDecision(sentence);
      if (!decision) continue;
      if (!DECISION_CUES.some((cue) => cue.test(decision))) continue;
      if (seen.has(decision)) continue;
      seen.add(decision);
      decisions.push(decision);
    }
  }

  return decisions;
}

/**
 * Build a deterministic digest of a slice of dropped messages so the agent
 * retains operational memory (what it already did) after compaction — without
 * spending an extra LLM call on summarization.
 */
function buildDigest(dropped, prevDecisions = []) {
  const filesWritten = new Set();
  const filesPatched = new Set();
  const commands = [];
  const errors = [];
  let notes = "";

  for (const m of dropped) {
    if (m.role === "assistant") {
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc.function || {};
          const args = safeParse(fn.arguments);
          if (fn.name === "write_file" && args.path) filesWritten.add(args.path);
          else if (fn.name === "patch_file" && args.path) filesPatched.add(args.path);
          else if (fn.name === "run_shell" && args.command) commands.push(truncate(args.command, 80));
        }
      }
      if (typeof m.content === "string" && m.content.trim() && notes.length < 800) {
        notes += " " + m.content.trim();
      }
    }
    if (m.role === "tool" && typeof m.content === "string") {
      if (/\b(error|failed|exit code [1-9]|not found|cannot|blocked)\b/i.test(m.content)) {
        errors.push(truncate(m.content.replace(/\s+/g, " ").trim(), 140));
      }
    }
  }

  const parts = [];
  if (filesWritten.size) parts.push(`Files created: ${[...filesWritten].join(", ")}`);
  if (filesPatched.size) parts.push(`Files modified: ${[...filesPatched].join(", ")}`);
  if (commands.length) parts.push(`Commands run: ${commands.slice(-8).join(" | ")}`);
  if (errors.length) parts.push(`Errors encountered: ${errors.slice(-6).join(" | ")}`);
  if (notes.trim()) parts.push(`Agent notes: ${truncate(notes.trim(), 600)}`);
  if (prevDecisions.length) {
    parts.push(`Decisions & rationale:\n${prevDecisions.map((d, i) => `${i + 1}. ${d}`).join("\n")}`);
  }
  return parts.length ? parts.join("\n") : "(no notable actions recorded in the compacted region)";
}
