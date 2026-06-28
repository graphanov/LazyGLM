// @ts-check

import { detectRole } from "./router.js";
import { isToolErrorResult } from "./tool-errors.js";

/**
 * @typedef {import("../types/index.js").EffectiveBundle} EffectiveBundle
 * @typedef {import("../types/index.js").ModelCatalog} ModelCatalog
 * @typedef {import("../types/index.js").ProviderConfig} ProviderConfig
 * @typedef {import("../types/index.js").ReasoningEffort} ReasoningEffort
 * @typedef {import("../types/index.js").RoleName} RoleName
 * @typedef {import("../types/index.js").RoutingDecision} RoutingDecision
 *
 * @typedef {object} AdaptiveRoutingState
 * @property {boolean} manualOverride
 * @property {number} cooldownTurnsLeft
 * @property {number} routineUserTurns
 * @property {number} errorStreak
 * @property {Set<string>} writePathsInCurrentUserTurn
 * @property {boolean} explicitComplexityInCurrentUserTurn
 *
 * @typedef {object} PromptRoutingSignal
 * @property {"prompt_intake"} source
 * @property {RoleName} role
 * @property {boolean} explicitComplexity
 * @property {string} reason
 *
 * @typedef {object} ToolRoutingSignal
 * @property {boolean} hadError
 * @property {boolean} wroteFile
 * @property {number} errorStreak
 * @property {number} distinctWritePaths
 *
 * @typedef {object} UserTurnSummary
 * @property {boolean} [hadError]
 * @property {boolean} [wroteFiles]
 * @property {boolean} [explicitComplexity]
 */

export const ERROR_STREAK_THRESHOLD = 2;
export const MULTI_FILE_THRESHOLD = 2;
export const ROUTINE_USER_TURNS_THRESHOLD = 3;
export const COOLDOWN_USER_TURNS = 2;

const HIGH_ROLE = "planner";

const ROLE_RANK = {
  quick: 1,
  verifier: 2,
  default: 3,
  worker: 3,
  planner: 3,
  ultrabrain: 4,
};

const COMPLEXITY_SIGNALS = [
  {
    role: /** @type {RoleName} */ ("planner"),
    reason: "prompt complexity: cleanup/refactor scope",
    re: /\b(clean\s*up|cleanup|refactor|overhaul|migrat(?:e|ion))\b/i,
  },
  {
    role: /** @type {RoleName} */ ("planner"),
    reason: "prompt complexity: architecture or multi-file scope",
    re: /\b(architect(?:ure|ural)?|design|multi[-\s]?file|cross[-\s]?file|database layer|auth(?:entication)? module)\b/i,
  },
  {
    role: /** @type {RoleName} */ ("default"),
    reason: "prompt complexity: debugging/error recovery",
    re: /\b(debug(?:ging)?|failing|failure|error recovery|root cause|regression)\b/i,
  },
];

/**
 * @param {object} [options]
 * @param {boolean} [options.manualOverride]
 * @returns {AdaptiveRoutingState}
 */
export function createAdaptiveRoutingState({ manualOverride = false } = {}) {
  return {
    manualOverride,
    cooldownTurnsLeft: 0,
    routineUserTurns: 0,
    errorStreak: 0,
    writePathsInCurrentUserTurn: new Set(),
    explicitComplexityInCurrentUserTurn: false,
  };
}

/**
 * @param {AdaptiveRoutingState} state
 * @param {object} [options]
 * @param {boolean} [options.manualOverride]
 * @returns {AdaptiveRoutingState}
 */
export function resetAdaptiveRoutingState(state, { manualOverride = state.manualOverride } = {}) {
  state.manualOverride = manualOverride;
  state.cooldownTurnsLeft = 0;
  state.routineUserTurns = 0;
  state.errorStreak = 0;
  state.writePathsInCurrentUserTurn.clear();
  state.explicitComplexityInCurrentUserTurn = false;
  return state;
}

/** @param {AdaptiveRoutingState} state */
export function beginAdaptiveUserTurn(state) {
  state.writePathsInCurrentUserTurn.clear();
  state.explicitComplexityInCurrentUserTurn = false;
}

/**
 * @param {ProviderConfig} config
 * @param {ModelCatalog} [catalog]
 * @returns {EffectiveBundle}
 */
export function effectiveBundleFromProviderConfig(config, catalog = {}) {
  const role = /** @type {RoleName} */ (config.role || "default");
  const roleEntry = catalog.roles?.[role] || catalog.roles?.default || {};
  return {
    provider: config.provider,
    model: config.model,
    modelId: config.modelId,
    role,
    reasoningEffort: /** @type {ReasoningEffort} */ (
      roleEntry.reasoning_effort || catalog.current?.model_reasoning_effort || "high"
    ),
  };
}

/**
 * Two bundles are "equal" only when they represent the same route. Effort now
 * counts even though z.ai is the only provider with a wire-level thinking
 * toggle today: routing is provider-agnostic, and effort changes must remain
 * visible when a pinned model moves between quick/high-style roles.
 *
 * @param {EffectiveBundle | null | undefined} a
 * @param {EffectiveBundle | null | undefined} b
 * @returns {boolean}
 */
export function bundlesEqual(a, b) {
  return !!a && !!b &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.modelId === b.modelId &&
    a.reasoningEffort === b.reasoningEffort;
}

/**
 * @param {string | null | undefined} prompt
 * @param {{ role?: RoleName }} [options]
 * @returns {PromptRoutingSignal}
 */
export function classifyPromptForRouting(prompt, options = {}) {
  const text = (prompt || "").trim();
  for (const signal of COMPLEXITY_SIGNALS) {
    if (signal.re.test(text)) {
      return {
        source: "prompt_intake",
        role: options.role || signal.role,
        explicitComplexity: true,
        reason: signal.reason,
      };
    }
  }
  const role = detectRole(text, options);
  return {
    source: "prompt_intake",
    role,
    explicitComplexity: false,
    reason: `prompt role: ${role}`,
  };
}

/**
 * Classify the prompt and remember whether this user turn is explicitly complex.
 *
 * @param {AdaptiveRoutingState} state
 * @param {string | null | undefined} prompt
 * @param {{ role?: RoleName }} [options]
 * @returns {PromptRoutingSignal}
 */
export function observePromptIntake(state, prompt, options = {}) {
  const signal = classifyPromptForRouting(prompt, options);
  state.explicitComplexityInCurrentUserTurn = signal.explicitComplexity;
  if (signal.explicitComplexity) state.routineUserTurns = 0;
  return signal;
}

/**
 * @param {object} options
 * @param {AdaptiveRoutingState} options.state
 * @param {EffectiveBundle} options.currentBundle
 * @param {EffectiveBundle} options.candidateBundle
 * @param {PromptRoutingSignal} options.signal
 * @returns {RoutingDecision | null}
 */
export function evaluatePromptRouting({ state, currentBundle, candidateBundle, signal }) {
  if (state.manualOverride) return null;
  const currentRank = roleRank(currentBundle.role);
  const candidateRank = roleRank(signal.role);
  const isEscalation = signal.explicitComplexity || candidateRank > currentRank;
  if (!isEscalation) return null;
  return buildDecision({
    state,
    source: "prompt_intake",
    currentBundle,
    candidateBundle,
    reason: signal.reason,
    direction: "escalate",
    hard: signal.explicitComplexity,
  });
}

/**
 * @param {AdaptiveRoutingState} state
 * @param {object} options
 * @param {string | null | undefined} options.toolName
 * @param {Record<string, unknown> | null | undefined} [options.toolInput]
 * @param {string | null | undefined} [options.result]
 * @param {boolean} [options.handlerThrew]
 * @returns {ToolRoutingSignal}
 */
export function observeToolResult(state, { toolName, toolInput, result, handlerThrew = false }) {
  const hadError = handlerThrew || isToolErrorResult(result);
  if (hadError) {
    state.errorStreak += 1;
    state.routineUserTurns = 0;
  } else {
    state.errorStreak = 0;
  }

  let wroteFile = false;
  if ((toolName === "write_file" || toolName === "patch_file") && typeof toolInput?.path === "string") {
    state.writePathsInCurrentUserTurn.add(toolInput.path);
    state.routineUserTurns = 0;
    wroteFile = true;
  }

  return {
    hadError,
    wroteFile,
    errorStreak: state.errorStreak,
    distinctWritePaths: state.writePathsInCurrentUserTurn.size,
  };
}

/**
 * @param {object} options
 * @param {AdaptiveRoutingState} options.state
 * @param {EffectiveBundle} options.currentBundle
 * @param {EffectiveBundle} options.candidateBundle
 * @returns {RoutingDecision | null}
 */
export function evaluateToolResultRouting({ state, currentBundle, candidateBundle }) {
  if (state.manualOverride) return null;
  if (state.errorStreak >= ERROR_STREAK_THRESHOLD) {
    return buildDecision({
      state,
      source: "tool_result",
      currentBundle,
      candidateBundle,
      reason: `error recovery: ${state.errorStreak} tool errors`,
      direction: "escalate",
      hard: true,
    });
  }
  if (state.writePathsInCurrentUserTurn.size >= MULTI_FILE_THRESHOLD) {
    return buildDecision({
      state,
      source: "tool_result",
      currentBundle,
      candidateBundle,
      reason: `scope growth: ${state.writePathsInCurrentUserTurn.size} files changed`,
      direction: "escalate",
      hard: true,
    });
  }
  return null;
}

/**
 * @param {object} options
 * @param {AdaptiveRoutingState} options.state
 * @param {EffectiveBundle} options.currentBundle
 * @param {EffectiveBundle} options.quickBundle
 * @param {UserTurnSummary} [options.turnSummary]
 * @returns {RoutingDecision | null}
 */
export function evaluateUserTurnCompleteRouting({ state, currentBundle, quickBundle, turnSummary = {} }) {
  if (state.manualOverride) return null;

  const resetsRoutine = !!(
    turnSummary.hadError ||
    turnSummary.wroteFiles ||
    turnSummary.explicitComplexity ||
    state.explicitComplexityInCurrentUserTurn
  );
  if (resetsRoutine) {
    state.routineUserTurns = 0;
    tickCooldown(state);
    return null;
  }

  state.routineUserTurns += 1;
  if (state.routineUserTurns < ROUTINE_USER_TURNS_THRESHOLD) {
    tickCooldown(state);
    return null;
  }

  if (state.cooldownTurnsLeft > 0) {
    tickCooldown(state);
    return null;
  }

  return buildDecision({
    state,
    source: "user_turn_complete",
    currentBundle,
    candidateBundle: quickBundle,
    reason: `${state.routineUserTurns} routine user turns`,
    direction: "deescalate",
    hard: false,
  });
}

/**
 * @param {AdaptiveRoutingState} state
 * @param {RoutingDecision} decision
 */
export function recordRoutingApplied(state, decision) {
  state.cooldownTurnsLeft = COOLDOWN_USER_TURNS;
  state.routineUserTurns = 0;
  state.errorStreak = 0;
  if (decision.direction === "deescalate") {
    state.writePathsInCurrentUserTurn.clear();
  }
}

/** @returns {RoleName} */
export function highRole() {
  return HIGH_ROLE;
}

/**
 * @param {RoleName | string | null | undefined} role
 * @returns {number}
 */
function roleRank(role) {
  return ROLE_RANK[/** @type {keyof typeof ROLE_RANK} */ (role)] || ROLE_RANK.default;
}

/** @param {AdaptiveRoutingState} state */
function tickCooldown(state) {
  if (state.cooldownTurnsLeft > 0) state.cooldownTurnsLeft -= 1;
}

/**
 * @param {object} options
 * @param {AdaptiveRoutingState} options.state
 * @param {RoutingDecision["source"]} options.source
 * @param {EffectiveBundle} options.currentBundle
 * @param {EffectiveBundle} options.candidateBundle
 * @param {string} options.reason
 * @param {"escalate" | "deescalate"} options.direction
 * @param {boolean} options.hard
 * @returns {RoutingDecision | null}
 */
function buildDecision({ state, source, currentBundle, candidateBundle, reason, direction, hard }) {
  if (state.manualOverride || bundlesEqual(currentBundle, candidateBundle)) return null;
  if (direction === "deescalate" && state.cooldownTurnsLeft > 0 && !hard) return null;
  return {
    source,
    from: currentBundle,
    to: candidateBundle,
    reason,
    direction,
    hard,
  };
}
