// Message context + compaction for the agent loop. Keeps a running estimate
// of token usage and compacts the middle of the transcript when over budget.
import { nowIso } from "../util.js";

const CHARS_PER_TOKEN = 4; // rough estimate

export class Context {
  constructor({ model = "", budget = 24_000 } = {}) {
    this.model = model;
    this.budget = budget; // soft token budget for the rolling window
    this.messages = [];
    this.compactionCount = 0;
    this.totalTokensIn = 0;
    this.totalTokensOut = 0;
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

  estimateTokens() {
    let chars = 0;
    for (const m of this.messages) {
      chars += (m.content?.length || 0);
      if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }

  /**
   * Compact if over budget. Keeps: system message, first user message,
   * and the most recent `keepRecent` messages. The middle is replaced by a
   * compacted summary marker. Fires `onCompact` so the hook engine can react.
   * Returns true if compaction occurred.
   */
  async maybeCompact({ onCompact } = {}) {
    const tokens = this.estimateTokens();
    if (tokens <= this.budget) return false;
    const keepRecent = 10;
    if (this.messages.length <= keepRecent + 2) return false;

    const system = this.messages[0]?.role === "system" ? this.messages[0] : null;
    const rest = system ? this.messages.slice(1) : this.messages;
    const head = rest.slice(0, 1); // first user task
    const tail = rest.slice(-keepRecent);
    const dropped = rest.length - head.length - tail.length;

    const summary = {
      role: "system",
      content:
        `[Compacted transcript — ${dropped} earlier messages summarized at ${nowIso()} to fit the GLM context window.]\n` +
        `The conversation above this point involved ongoing work toward the user's task. ` +
        `Continue from the most recent messages. Do not re-ask what was already discussed.`,
    };

    this.messages = [system, ...head, summary, ...tail].filter(Boolean);
    this.compactionCount += 1;
    if (onCompact) await onCompact({ compactionCount: this.compactionCount, droppedTokens: tokens });
    return true;
  }

  recordUsage(usage) {
    if (!usage) return;
    this.totalTokensIn += usage.prompt_tokens || 0;
    this.totalTokensOut += usage.completion_tokens || 0;
  }
}
