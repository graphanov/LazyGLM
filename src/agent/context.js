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

const CHARS_PER_TOKEN = 4; // rough cross-model estimate; budget windows come from the catalog.

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

  /**
   * Reset the conversation to an empty transcript. Clears messages, the
   * per-context decision store, and compaction counters — used by REPL
   * /clear and /resume so a stale `decisions` array does not leak rationale
   * from a prior session into the next compaction digest.
   */
  reset() {
    this.messages = [];
    this.decisions = [];
    this.compactionCount = 0;
  }

  /**
   * Reset the conversation while preserving only the original system prompt.
   * Compaction summaries and PostCompact injects are also `system` messages,
   * but they are scoped to the current compacted conversation and must not
   * survive REPL /clear or /resume into a fresh transcript.
   */
  resetToSystemPrompt() {
    const system = this.messages.find((m) => m.role === "system");
    this.messages = system ? [system] : [];
    this.decisions = [];
    this.compactionCount = 0;
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

    const existingDecisions = this.getDecisions();
    const { decisions: newDecisions, override: droppedOverride } = extractDecisions(dropped, existingDecisions);
    // Overrides can be broad ("Actually use SQLite") or targeted ("Use SQLite
    // instead of Postgres"). Broad overrides clear all prior rationale; targeted
    // ones only evict decisions that mention the rejected choice so unrelated
    // handoff context survives.
    let retainedExistingDecisions = applyDecisionOverride(existingDecisions, droppedOverride);
    const tailOverride = collectDecisionOverrides(tail, [...retainedExistingDecisions, ...newDecisions]);
    retainedExistingDecisions = applyDecisionOverride(retainedExistingDecisions, tailOverride);
    const effectiveNewDecisions = applyDecisionOverride(newDecisions, tailOverride);

    this.decisions.length = 0;
    for (const decision of [...retainedExistingDecisions, ...effectiveNewDecisions]) {
      if (!this.decisions.includes(decision)) this.addDecision(decision);
    }
    const digest = buildDigest(dropped, this.getDecisions(), {
      suppressDecisionNotes: Boolean(tailOverride?.all),
      suppressedDecisionTargets: tailOverride?.targets || [],
    });

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

// Cues that a user turn reverses a prior assistant decision. A user message
// matching one of these in the dropped region causes preceding assistant
// decisions to be treated as superseded, so the handoff does not keep
// surfacing a rejected choice after the user's correction is gone.
//
// These are narrowed to explicit correction/replacement phrasing. Broad
// negation cues (\bnot\b, \bdon'?t\b) were removed: they matched neutral
// instructions ("Do not run tests yet", "No need to update docs") and wrongly
// cleared the Decisions & rationale block in multi-compaction sessions.
const CHANGE_TO_CUE = /\bchange\b.*\b(?:decision|choice|approach|rationale|plan(?!\.[\w-])|design(?!\.[\w-]))\b.*\bto\b|\b(?:decision|choice|approach|rationale|plan(?!\.[\w-])|design(?!\.[\w-]))\b.*\bchange\b.*\bto\b/i;
const NEGATED_CHANGE_TO_CUE = /\b(?:no|not|without)\s+change\b.*\bto\b|\b(?:do not|don't)\s+change\b.*\bto\b/i;
const NEGATED_REPLACEMENT_CUE = /\b(?:do not|don't|dont)\s+(?:replace|use|switch\s+to|change\s+to|prefer|go with)\b|\b(?:no|not|without)\s+(?:replace|replacement|use|switch\s+to|change\s+to|preference)\b/i;
const PRESERVE_CHOICE_CUE = /\b(?:keep|preserve|retain|stick with|stay with|leave)\b|\b(?:same|current|existing|prior|previous)\b.*\b(?:choice|decision|approach|plan)\b/i;
const REPLACE_DECISION_CUE = /\breplace\b.*\b(?:decision|choice|approach|rationale)\b|\b(?:decision|choice|approach|rationale)\b.*\breplace\b/i;
const INSTEAD_REPLACEMENT_CUE = /\b(?:use|switch\s+to|change\s+to|prefer|go with)\b.*\binstead\b(?!\s+of\b)|\binstead\b(?!\s+of\b).*\b(?:use|switch\s+to|change\s+to|prefer|go with)\b/i;
const SHORT_INSTEAD_REPLACEMENT_TARGET_CUE = /\b(?:use|switch\s+to|change\s+to|prefer|go with)\s+([^.;,\n]+?)\s+instead\b(?!\s+of\b)/i;
const INSTEAD_OF_REPLACEMENT_CUE = /\b(?:use|switch\s+to|change\s+to|prefer|go with)\s+([^.;,\n]+?)\s+instead\s+of\s+([^.;,\n]+?)(?=\s+(?:because|since|as|in|for|on|during|when|while|where|under|with)\b|\s+(?:but|and)\s+(?:(?:do not|don't|dont|not|never)\s+)?(?:keep|preserve|retain|stick with|stay with|leave|update|edit|modify|write|patch|create|delete|read|open|run|rerun|test|verify|check|build|lint|format|fix)\b|[.;,\n]|$)/i;
const ACTUALLY_REPLACEMENT_CUE = /\bactually\b.*\b(?:use|switch to|change to|prefer|go with)\b/i;
const RATHER_REPLACEMENT_CUE = /\brather\b.*\b(?:use|switch to|change to|prefer|go with)\b/i;
// Targeted "use X rather than Y" form: RATHER_REPLACEMENT_CUE only matches the
// reversed "rather ... use" order, so a direct correction like "Use SQLite
// rather than Postgres." slipped through and left the rejected Postgres
// decision in the handoff digest. This cue names both targets so the old one
// (the second capture group) can be evicted precisely, mirroring
// INSTEAD_OF_REPLACEMENT_CUE for the "instead of" phrasing.
const RATHER_THAN_REPLACEMENT_CUE = /\b(?:use|switch\s+to|change\s+to|prefer|go\s+with)\s+([^.;,\n]+?)\s+rather\s+than\s+([^.;,\n]+?)(?=\s+(?:because|since|as|in|for|on|during|when|while|where|under|with)\b|\s+(?:but|and)\s+(?:(?:do not|don't|dont|not|never)\s+)?(?:keep|preserve|retain|stick with|stay with|leave|update|edit|modify|write|patch|create|delete|read|open|run|rerun|test|verify|check|build|lint|format|fix)\b|[.;,\n]|$)/i;
const SECOND_THOUGHT_REPLACEMENT_CUE = /\bon second thought\b.*\b(?:use|switch to|change to|prefer|go with|replace|scrap|redo|revert)\b/i;
const NEVERMIND_REPLACEMENT_CUE = /\bnever ?mind\b.*\b(?:use|switch to|change to|prefer|go with|replace|decision|choice|approach|plan|design|rationale)\b/i;
const DISCARD_DECISION_CUE = /\b(?:scrap|redo|revert)\b.*\b(?:decision|choice|approach|plan|design|rationale)\b|\b(?:decision|choice|approach|plan|design|rationale)\b.*\b(?:scrap|redo|revert)\b/i;
const NEGATED_REPLACEMENT_TARGET_CUES = [
  /\b(?:do not|don't|dont)\s+(?:use|replace|prefer|go with)\s+([^.;,\n]+?)(?=\s+(?:because\b|since\b|as\b|instead\b|(?:but|and)\s+(?:use|switch|change|prefer|go with|keep\s+going|continue|carry\s+on|move\s+on|proceed)\b)|[.;,\n]|$)/i,
  /\b(?:do not|don't|dont)\s+(?:switch|change)\s+to\s+([^.;,\n]+?)(?=\s+(?:because\b|since\b|as\b|instead\b|(?:but|and)\s+(?:use|switch|change|prefer|go with|keep\s+going|continue|carry\s+on|move\s+on|proceed)\b)|[.;,\n]|$)/i,
  /\b(?:no|not|without)\s+(?:replacement|use|switch\s+to|change\s+to|preference)\s+(?:of\s+|for\s+)?([^.;,\n]+?)(?=\s+(?:because\b|since\b|as\b|instead\b|(?:but|and)\s+(?:use|switch|change|prefer|go with|keep\s+going|continue|carry\s+on|move\s+on|proceed)\b)|[.;,\n]|$)/i,
];
const PRESERVE_TARGET_CUES = [
  /\b(?:keep|preserve|retain|stick with|stay with|leave)\s+([^.;,\n]+?)(?=[.;,\n]|$)/i,
];
const NEUTRAL_ACTION_USE_CUE = /\bactually\b.*\buse\s+(`[^`]+`|[^.;,\n]+?)\s+to\s+(?:verify|test|run|check|build|lint|format|inspect|update|edit|modify|write|patch|create|delete|read|open|search|find|look)\b/i;
const COMMANDISH_REPLACEMENT_TARGET_CUE = /^(?:`(?:(?:npm|pnpm|yarn|node|npx|git|gh|python3?|pytest|go|cargo|make|cmake|bash|sh)\s+[^`]+|[a-z][a-z0-9]*_[a-z0-9_]+)`|(?:npm|pnpm|yarn|node|npx|git|gh|python3?|pytest|go|cargo|make|cmake|bash|sh)\s+\S+|[a-z][a-z0-9]*_[a-z0-9_]+\b)/i;
const ONE_WORD_TOOL_ACTION_TARGET_CUE = /^(?:`)?(?:rg|ripgrep|tsc|eslint|prettier|biome|ruff|mypy|grep|fd|jq)(?:`)?$/;
const ARTICLE_ACTION_TARGET_CUE = /^(?:`)?(?:the|a|an|this|that|these|those)\s+\S+/i;
const PRONOUN_CHOICE_TARGETS = new Set(["it", "that", "this", "them"]);
// Generic artifact/tool nouns that name what you use for a task, not a
// technology choice. Used to keep "actually use the test suite to verify"
// neutral while letting lowercase tech names ("svelte", "react") evict.
const GENERIC_ARTIFACT_NOUNS = new Set([
  "test", "tests", "suite", "config", "configuration", "file", "files",
  "schema", "code", "docs", "documentation", "log", "logs", "output",
  "build", "results", "report", "summary", "diff", "patch", "commit",
  "script", "command", "tool", "tools", "package", "module", "library",
  "setup", "approach", "method", "process", "environment", "directory",
  "folder", "path", "branch", "version", "existing", "current",
  "previous", "same", "latest", "fixture", "stubs", "binary",
]);

const OVERRIDE_CUES = [
  // `actually` is only an override when it introduces a replacement target;
  // standalone "Actually, please run tests" is a neutral request. `replace` is
  // intentionally excluded here because normal edit requests also say replace.
  ACTUALLY_REPLACEMENT_CUE,
  // Plain /\binstead\b/i was too broad: command substitutions like
  // "run npm test instead of npm run test" are not decision reversals.
  INSTEAD_REPLACEMENT_CUE,
  // Plain /\bchange\b.*\bto\b/i was too broad: ordinary edits like
  // "change the README heading to LazyGLM" are not decision reversals.
  CHANGE_TO_CUE,
  // Note: /\bswitch\b/i was removed — it matched neutral discussion of switch
  // statements ("the switch statement still fails") and wrongly cleared the
  // Decisions & rationale block, the same false-positive class that removed
  // /\bwait\b/, /\bnot\b/, and /\bdon'?t\b/.
  // Plain /\breplace\b/i is also too broad: ordinary editing requests like
  // "replace the README placeholder" are not decision reversals.
  REPLACE_DECISION_CUE,
  // Note: /\bwait\b/i was removed — it matched neutral instructions ("please wait
  // for CI before finalizing") and wrongly cleared the Decisions & rationale
  // block, the same false-positive class that removed /\bnot\b/ and /\bdon'?t\b/.
  SECOND_THOUGHT_REPLACEMENT_CUE,
  NEVERMIND_REPLACEMENT_CUE,
  // Discard/rework verbs are only overrides when tied to decision/plan nouns;
  // "redo the test run" or "revert the README heading" must not clear rationale.
  DISCARD_DECISION_CUE,
  // Plain /\brather\b/i was too broad: preserve-current phrasing like
  // "I'd rather keep Postgres" must not evict the retained rationale.
  RATHER_REPLACEMENT_CUE,
];

function hasPositiveReplacementCue(content) {
  return ACTUALLY_REPLACEMENT_CUE.test(content)
    || INSTEAD_REPLACEMENT_CUE.test(content)
    || CHANGE_TO_CUE.test(content)
    || REPLACE_DECISION_CUE.test(content)
    || RATHER_REPLACEMENT_CUE.test(content)
    || SECOND_THOUGHT_REPLACEMENT_CUE.test(content)
    || NEVERMIND_REPLACEMENT_CUE.test(content)
    || DISCARD_DECISION_CUE.test(content);
}

function normalizeChoiceTarget(value) {
  return String(value || "")
    .replace(/[`"']/g, "")
    .replace(/^\s*(?:(?:the|a|an|current|existing|prior|previous|same)\s+)+/i, "")
    .replace(/^\s*(?:using|use|running|run|switching\s+to|switch\s+to|changing\s+to|change\s+to|choosing|choose|preferring|prefer|going\s+with|go\s+with)\s+/i, "")
    .replace(/^\s*(?:(?:the|a|an|current|existing|prior|previous|same)\s+)+/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?;:,]+$/g, "")
    .trim()
    .toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

function decisionNegatesTarget(decision, target) {
  if (!target) return false;
  const normalized = normalizeChoiceTarget(decision);
  const escaped = escapeRegExp(target);
  // Lookarounds instead of \b so non-word targets (C++, C#, .NET) match.
  return new RegExp(`(?<![\\w])(?:not|never|without|avoid|avoiding|no)(?:\\s+\\w+){0,4}\\s+${escaped}(?![\\w])`, "i").test(normalized);
}

function firstChoiceTarget(content, cues) {
  for (const cue of cues) {
    const match = cue.exec(content);
    const target = normalizeChoiceTarget(match?.[1]);
    if (target) return target;
  }
  return "";
}

function isNeutralReplacementTarget(target) {
  if (!target) return false;
  if (COMMANDISH_REPLACEMENT_TARGET_CUE.test(target)
      || ONE_WORD_TOOL_ACTION_TARGET_CUE.test(target)) return true;
  // An article-prefixed target is neutral when it names a generic artifact
  // ("the test suite", "a config file", "the existing test command") or an
  // all-caps file/acronym ("the README", "the JSON schema"). A technology or
  // approach name after the article ("a Svelte frontend", "the Rust port",
  // "a svelte frontend") is a real replacement target that should evict a
  // prior decision, not preserve it. Title-case-only detection missed
  // lowercase tech names (svelte, react).
  if (ARTICLE_ACTION_TARGET_CUE.test(target)) {
    const afterArticle = target.replace(/^(?:`)?(?:the|a|an|this|that|these|those)\s+/i, "");
    const firstWord = afterArticle.split(/\s/)[0] || "";
    if (/^[A-Z][a-z]/.test(firstWord)) return false;
    if (/^[A-Z]{2,}$/.test(firstWord)) return true;
    if (GENERIC_ARTIFACT_NOUNS.has(firstWord.toLowerCase())) return true;
    return false;
  }
  // A bare lowercase word that is a generic artifact noun ("tests", "config",
  // "script") is a routine command substitution, not a technology choice.
  if (GENERIC_ARTIFACT_NOUNS.has(target.toLowerCase())) return true;
  return false;
}

function isNeutralShortInsteadTurn(content) {
  const target = SHORT_INSTEAD_REPLACEMENT_TARGET_CUE.exec(content)?.[1]?.trim() || "";
  return isNeutralReplacementTarget(target);
}

function isNeutralActionUseTurn(content) {
  const target = NEUTRAL_ACTION_USE_CUE.exec(content)?.[1]?.trim() || "";
  return isNeutralReplacementTarget(target);
}

function isPronounChoiceTarget(target) {
  return PRONOUN_CHOICE_TARGETS.has(target);
}

function decisionMentionsTarget(decision, target) {
  const normalizedTarget = normalizeChoiceTarget(target);
  if (!normalizedTarget) return false;
  const targetPattern = normalizedTarget.split(/\s+/).map(escapeRegExp).join("\\s+");
  // Use lookarounds instead of \b so targets ending/starting in non-word
  // characters (C++, C#, F#, .NET) still match. \b only fires between a word
  // and a non-word char, so it fails after a trailing +/#/. boundary.
  return new RegExp(`(?<![\\w])${targetPattern}(?![\\w])`, "i").test(normalizeChoiceTarget(decision));
}

function decisionAffirmsTarget(decision, target) {
  return decisionMentionsTarget(decision, target) && !decisionNegatesTarget(decision, target);
}

function decisionsMentionChoice(decisions, target) {
  if (!target || isPronounChoiceTarget(target)) return false;
  return decisions.some((decision) => decisionAffirmsTarget(decision, target));
}

function decisionMatchesTargets(decision, targets = []) {
  return targets.some((target) => decisionAffirmsTarget(decision, target));
}

function mergeDecisionOverride(existing, next) {
  if (!next) return existing;
  if (!existing) return next.all ? { all: true, targets: [] } : { all: false, targets: [...new Set(next.targets)] };
  if (existing.all || next.all) return { all: true, targets: [] };
  return { all: false, targets: [...new Set([...existing.targets, ...next.targets])] };
}

function applyDecisionOverride(decisions, override) {
  if (!override) return [...decisions];
  if (override.all) return [];
  return decisions.filter((decision) => !decisionMatchesTargets(decision, override.targets));
}

function decisionRemovedByOverride(decision, override) {
  if (!override) return false;
  if (override.all) return true;
  return decisionMatchesTargets(decision, override.targets);
}

function insteadOfOldChoiceTargets(content, activeDecisions = []) {
  const match = INSTEAD_OF_REPLACEMENT_CUE.exec(content);
  const replacedTarget = normalizeChoiceTarget(match?.[2]);
  return decisionsMentionChoice(activeDecisions, replacedTarget) ? [replacedTarget] : [];
}

function ratherThanOldChoiceTargets(content, activeDecisions = []) {
  const match = RATHER_THAN_REPLACEMENT_CUE.exec(content);
  const replacedTarget = normalizeChoiceTarget(match?.[2]);
  return decisionsMentionChoice(activeDecisions, replacedTarget) ? [replacedTarget] : [];
}

function isNegatedReplacementOverride(content, activeDecisions = []) {
  return negatedReplacementOverrideTargets(content, activeDecisions).length > 0;
}

function negatedReplacementOverrideTargets(content, activeDecisions = []) {
  const negatedTarget = firstChoiceTarget(content, NEGATED_REPLACEMENT_TARGET_CUES);
  const preservedTarget = firstChoiceTarget(content, PRESERVE_TARGET_CUES);
  if (!decisionsMentionChoice(activeDecisions, negatedTarget)) return [];
  if (preservedTarget && (negatedTarget === preservedTarget || isPronounChoiceTarget(preservedTarget))) return [];
  if (isNegatedReplaceOnlyTurn(content) && isKeepGoingTarget(preservedTarget)) return [];
  return [negatedTarget];
}

function isKeepGoingTarget(target) {
  return /^(?:going|working|on|at it)$/i.test(target);
}

function isNegatedReplaceOnlyTurn(content) {
  return /\b(?:do not|don't|dont)\s+replace\b|\b(?:no|not|without)\s+replacement\b/i.test(content);
}

function targetedOverrideTargets(content, activeDecisions = []) {
  return [...new Set([
    ...negatedReplacementOverrideTargets(content, activeDecisions),
    ...insteadOfOldChoiceTargets(content, activeDecisions),
    ...ratherThanOldChoiceTargets(content, activeDecisions),
  ])];
}

function isPreserveChoiceTurn(content, activeDecisions = []) {
  // "No change to ..." and "do not change to ..." preserve the current choice;
  // negated replacement/use wording does too when paired with explicit keep/retain
  // language ("Don't replace Postgres; keep it"). If the negated target matches
  // an active prior decision while keep/retain names a different target, the user
  // is rejecting the old choice and the decision must be evicted instead.
  if (isNegatedReplacementOverride(content, activeDecisions)) return false;
  if (isNeutralActionUseTurn(content)) return true;
  return NEGATED_CHANGE_TO_CUE.test(content)
    || (NEGATED_REPLACEMENT_CUE.test(content) && PRESERVE_CHOICE_CUE.test(content))
    || (PRESERVE_CHOICE_CUE.test(content) && !hasPositiveReplacementCue(content));
}

function decisionOverrideForTurn(m, activeDecisions = []) {
  if (m.role !== "user" || typeof m.content !== "string") return false;
  const targets = targetedOverrideTargets(m.content, activeDecisions);
  if (targets.length) return { all: false, targets };
  if (isPreserveChoiceTurn(m.content, activeDecisions)) return false;
  if (isNeutralShortInsteadTurn(m.content)) return null;
  if (OVERRIDE_CUES.some((cue) => cue.test(m.content))) return { all: true, targets: [] };
  return null;
}

function collectDecisionOverrides(messages, activeDecisions = []) {
  let override = null;
  let visibleDecisions = [...activeDecisions];
  for (const m of messages) {
    const turnOverride = decisionOverrideForTurn(m, visibleDecisions);
    if (turnOverride) {
      override = mergeDecisionOverride(override, turnOverride);
      visibleDecisions = applyDecisionOverride(visibleDecisions, turnOverride);
      continue;
    }
    if (m.role !== "assistant" || typeof m.content !== "string") continue;
    for (const sentence of extractSentences(m.content)) {
      const decision = normalizeDecision(sentence);
      if (decision && isDecisionSentence(decision) && !visibleDecisions.includes(decision)) visibleDecisions.push(decision);
    }
  }
  return override;
}

function isDecisionSentence(text) {
  return DECISION_CUES.some((cue) => cue.test(text));
}

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
  // Split on [.!?] only at a real sentence boundary: a period directly followed
  // by a non-space char (e.g. "src/context.js", "v2.1.3", "3.14", "config.json")
  // is an intra-token period, not a boundary. A terminator counts only at
  // end-of-string or when followed by whitespace.
  return normalized.match(/.+?(?:[.!?](?=\s|$)|$)(?:\s|$)*/gsu) || [normalized];
}

function extractDecisions(dropped, existingDecisions = []) {
  let activeExistingDecisions = [...existingDecisions];
  let decisions = [];
  const seen = new Set();
  let override = null;

  for (const m of dropped) {
    // A user turn that reverses an earlier assistant decision. Once an override
    // appears, assistant decisions captured before it are superseded: drop them
    // so the handoff does not keep surfacing a rejected choice (e.g. assistant
    // "I decided to use Postgres." then user "Actually use SQLite"). Decisions
    // emitted after the override are retained. The returned override also lets
    // the caller evict decisions persisted from earlier compaction passes.
    const activeDecisions = [...activeExistingDecisions, ...decisions];
    const turnOverride = decisionOverrideForTurn(m, activeDecisions);
    if (turnOverride) {
      activeExistingDecisions = applyDecisionOverride(activeExistingDecisions, turnOverride);
      decisions = applyDecisionOverride(decisions, turnOverride);
      seen.clear();
      for (const decision of decisions) seen.add(decision);
      override = mergeDecisionOverride(override, turnOverride);
      continue;
    }
    if (m.role !== "assistant") continue;
    if (typeof m.content !== "string") continue;

    for (const sentence of extractSentences(m.content)) {
      const decision = normalizeDecision(sentence);
      if (!decision) continue;
      if (!isDecisionSentence(decision)) continue;
      if (seen.has(decision)) continue;
      seen.add(decision);
      decisions.push(decision);
    }
  }

  return { decisions, override };
}

/**
 * Build a deterministic digest of a slice of dropped messages so the agent
 * retains operational memory (what it already did) after compaction — without
 * spending an extra LLM call on summarization.
 */
function buildDigest(dropped, prevDecisions = [], { suppressDecisionNotes = false, suppressedDecisionTargets = [] } = {}) {
  const filesWritten = new Set();
  const filesPatched = new Set();
  const commands = [];
  const errors = [];
  let notes = [];
  let notesLength = 0;

  const appendNote = (text) => {
    if (notesLength >= 800) return;
    const isDecision = isDecisionSentence(text);
    if (suppressDecisionNotes && isDecision) return;
    if (isDecision && decisionMatchesTargets(text, suppressedDecisionTargets)) return;
    notes.push({ text, isDecision });
    notesLength += text.length + 1;
  };

  for (const m of dropped) {
    const activeDecisionNotes = notes.filter((note) => note.isDecision).map((note) => note.text);
    const noteOverride = decisionOverrideForTurn(m, activeDecisionNotes);
    if (noteOverride) {
      // If a user correction is in the dropped slice, decision sentences before
      // it are superseded not only in Decisions & rationale but also in Agent
      // notes. Keep non-decision operational notes; drop only the rejected
      // decision sentences so the handoff does not contradict the correction.
      notes = notes.filter((note) => !note.isDecision || !decisionRemovedByOverride(note.text, noteOverride));
      notesLength = notes.reduce((n, note) => n + note.text.length + 1, 0);
    }
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
      if (typeof m.content === "string" && m.content.trim() && notesLength < 800) {
        for (const sentence of extractSentences(m.content)) {
          const note = String(sentence || "").replace(/\s+/g, " ").trim();
          if (!note) continue;
          appendNote(note);
          if (notesLength >= 800) break;
        }
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
  const notesText = notes.map((note) => note.text).join(" ").trim();
  if (notesText) parts.push(`Agent notes: ${truncate(notesText, 600)}`);
  if (prevDecisions.length) {
    parts.push(`Decisions & rationale:\n${prevDecisions.map((d, i) => `${i + 1}. ${d}`).join("\n")}`);
  }
  return parts.length ? parts.join("\n") : "(no notable actions recorded in the compacted region)";
}
