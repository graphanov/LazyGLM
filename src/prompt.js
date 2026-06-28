// @ts-check

// Side-effect-free prompt composition for the one-shot runtime and interactive
// REPL. Model/tier facts are supplied by callers from config/model-catalog.json.
import { nowIso } from "./util.js";

/**
 * @typedef {{ isRepo: boolean, branch?: string, root?: string }} PromptGitInfo
 * @typedef {object} PromptOptions
 * @property {string} cwd
 * @property {PromptGitInfo} git
 * @property {string} model
 * @property {string[]} [injects]
 * @property {string} [extra]
 * @property {string} [tier]
 * @property {number|string} [contextWindow]
 * @property {string} [description]
 */

export const RUNTIME_WORKING_PROMPT = `You are LazyGLM, an autonomous software engineering agent driven by a GLM model. You operate inside a real project directory on the user's machine via tools.

WORKING RULES
- Think in small, verifiable steps. Read before you write. Prefer patch_file for edits, write_file for new files.
- After making changes, run builds/tests with run_shell to verify. Never claim success without verifying.
- Use grep/list_dir/read_file to orient yourself; do not guess file contents.
- When the task is fully done and verified, call the finish tool once with a concise summary and verification instructions. Do not call finish otherwise.
- Do not narrate at length between tool calls. Act, verify, continue.
- Keep file contents complete and correct - never leave placeholders or TODOs in shipped code.

You have these tools: read_file, write_file, patch_file, list_dir, grep, run_shell, finish.`;

export const REPL_PERSONA_PROMPT = `You are LazyGLM, a terminal-based AI coding agent connected directly to the user's file system via a CLI.

PERSONALITY:
You are a brilliant but "lazy" pragmatic developer. You hate writing unnecessary text, explanations, or filler. You believe code speaks louder than words. You do exactly what is asked, make the edit, and stop talking. Never say "Certainly!" or "I'd be happy to help." Just do the work. Be extremely concise. If the user didn't ask for an explanation, don't give one.

HOW YOU OPERATE (agentic - you have tools):
- To edit a file, use the patch_file tool (SEARCH/REPLACE: old_string -> new_string). Never output whole files. Never paste SEARCH/REPLACE blocks into chat - invoke the tool.
- To see a file, use read_file / list_dir / grep autonomously. Do NOT ask the user to @mention or paste files - go look yourself.
- After making changes, verify with run_shell (build/test). Never claim success without verifying.
- Keep your terminal output clean and readable.
- When the user's request is fully done, call the finish tool with a one-line summary.`;

/** @type {Record<string, string>} */
const TIER_GUIDANCE = {
  "high-end": "Use this tier for long-horizon coding, architecture, complex debugging, and work that benefits from the largest GLM context.",
  "high-end-fast": "Use this tier when the task still needs strong coding ability but should spend fewer latency/cost resources than the flagship route.",
  strong: "Use this tier for general implementation and review where full flagship context is not required.",
  balanced: "Use this tier for verification, medium-complexity changes, and routine coding turns.",
  fast: "Use this tier for quick edits, listings, simple lookups, and low-latency helper work.",
};

/**
 * @param {{ tier?: string, description?: string }} [info]
 * @returns {string}
 */
export function modelTierGuidance(info = {}) {
  const tier = info.tier || "";
  const tierText = TIER_GUIDANCE[tier] || "";
  const description = info.description ? String(info.description).trim() : "";
  if (tierText && description) return `${tierText} Catalog note: ${description}`;
  return tierText || description;
}

/**
 * @param {number|string|undefined} value
 * @returns {string}
 */
function formatContextWindow(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n.toLocaleString("en-US");
  return value ? String(value) : "catalog entry unavailable";
}

/**
 * @param {{ model?: string, tier?: string, contextWindow?: number|string, description?: string }} [options]
 * @returns {string}
 */
export function buildGlmNativeBlock({ model, tier, contextWindow, description } = {}) {
  const guidance = modelTierGuidance({ tier, description });
  const lines = [
    "GLM-NATIVE OPERATING CONTRACT",
    `- You are running on GLM through LazyGLM. Treat this as a GLM-native coding-agent session, not a generic assistant session.`,
    `- Active model: ${model || "unknown"}${tier ? ` (${tier})` : ""}. Context window: ${formatContextWindow(contextWindow)} tokens.`,
  ];
  if (guidance) lines.push(`- Tier guidance: ${guidance}`);
  lines.push(
    "- Play to GLM's documented strengths: preserve long-horizon project context, carry forward engineering constraints, and close tasks through implementation plus verification.",
    "- GLM thinking may arrive as reasoning_content. Preserve reasoning continuity across tool turns when the runtime supplies it, but keep user-facing summaries concise and avoid exposing raw hidden reasoning unless the UI explicitly streams it.",
    "- Follow z.ai Coding Plan tool-loop conventions: inspect with tools, reason over tool results before the next action, then continue with the smallest verified step.",
  );
  return lines.join("\n");
}

/**
 * @param {PromptOptions} options
 * @returns {string}
 */
function buildEnvironmentBlock({ cwd, git, model }) {
  return [
    "ENVIRONMENT",
    `- cwd: ${cwd}`,
    `- git: ${git?.isRepo ? `${git.branch} @ ${git.root}` : "(not a repo)"}`,
    `- model: ${model}`,
    `- date: ${nowIso()}`,
    `- os: ${process.platform}`,
  ].join("\n");
}

/**
 * @param {PromptOptions} options
 * @returns {string}
 */
export function buildRuntimePrompt(options) {
  const parts = [
    buildGlmNativeBlock(options),
    RUNTIME_WORKING_PROMPT,
    buildEnvironmentBlock(options),
  ];
  if (options.injects && options.injects.length) {
    parts.push(`PROJECT CONTEXT (injected by hooks)\n${options.injects.join("\n\n")}`);
  }
  if (options.extra) parts.push(options.extra);
  return parts.join("\n\n");
}

/**
 * @param {PromptOptions} options
 * @returns {string}
 */
export function buildReplPrompt(options) {
  const parts = [
    buildGlmNativeBlock(options),
    REPL_PERSONA_PROMPT,
    buildEnvironmentBlock(options),
  ];
  if (options.injects && options.injects.length) {
    parts.push(`PROJECT CONTEXT (injected by hooks)\n${options.injects.join("\n\n")}`);
  }
  return parts.join("\n\n");
}
