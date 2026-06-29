import { detectRole } from "./router.js";
import { isToolErrorResult } from "./tool-errors.js";
import type {
  EffectiveBundle,
  ModelCatalog,
  ProviderConfig,
  ReasoningEffort,
  RoleModelConfig,
  RoleName,
  RoutingDecision,
} from "../types/index.js";

interface AdaptiveRoutingState {
  manualOverride: boolean;
  cooldownTurnsLeft: number;
  routineUserTurns: number;
  errorStreak: number;
  writePathsInCurrentUserTurn: Set<string>;
  explicitComplexityInCurrentUserTurn: boolean;
}

interface PromptRoutingSignal {
  source: "prompt_intake";
  role: RoleName;
  explicitComplexity: boolean;
  reason: string;
}

interface ToolRoutingSignal {
  hadError: boolean;
  wroteFile: boolean;
  errorStreak: number;
  distinctWritePaths: number;
}

interface UserTurnSummary {
  hadError?: boolean;
  wroteFiles?: boolean;
  explicitComplexity?: boolean;
}

interface PromptRoleOptions {
  role?: RoleName;
}

interface PromptRoutingOptions {
  state: AdaptiveRoutingState;
  currentBundle: EffectiveBundle;
  candidateBundle: EffectiveBundle;
  signal: PromptRoutingSignal;
}

interface ToolResultObservation {
  toolName?: string | null;
  toolInput?: Record<string, unknown> | null;
  result?: string | null;
  handlerThrew?: boolean;
}

interface ToolRoutingOptions {
  state: AdaptiveRoutingState;
  currentBundle: EffectiveBundle;
  candidateBundle: EffectiveBundle;
}

interface UserTurnRoutingOptions {
  state: AdaptiveRoutingState;
  currentBundle: EffectiveBundle;
  quickBundle: EffectiveBundle;
  turnSummary?: UserTurnSummary;
}

interface BuildDecisionOptions {
  state: AdaptiveRoutingState;
  source: RoutingDecision["source"];
  currentBundle: EffectiveBundle;
  candidateBundle: EffectiveBundle;
  reason: string;
  direction: "escalate" | "deescalate";
  hard: boolean;
}

export const ERROR_STREAK_THRESHOLD = 2;
export const MULTI_FILE_THRESHOLD = 2;
export const ROUTINE_USER_TURNS_THRESHOLD = 3;
export const COOLDOWN_USER_TURNS = 2;

const HIGH_ROLE: RoleName = "planner";

const ROLE_RANK: Record<string, number> = {
  quick: 1,
  verifier: 2,
  default: 3,
  worker: 3,
  planner: 3,
  ultrabrain: 4,
};

const COMPLEXITY_SIGNALS = [
  {
    role: "planner" as RoleName,
    reason: "prompt complexity: cleanup/refactor scope",
    re: /\b(clean\s*up|cleanup|refactor|overhaul|migrat(?:e|ion))\b/i,
  },
  {
    role: "planner" as RoleName,
    reason: "prompt complexity: architecture or multi-file scope",
    re: /\b(architect(?:ure|ural)?|design|multi[-\s]?file|cross[-\s]?file|database layer|auth(?:entication)? module)\b/i,
  },
  {
    role: "default" as RoleName,
    reason: "prompt complexity: debugging/error recovery",
    re: /\b(debug(?:ging)?|failing|failure|error recovery|root cause|regression)\b/i,
  },
];

export function createAdaptiveRoutingState({ manualOverride = false }: { manualOverride?: boolean } = {}): AdaptiveRoutingState {
  return {
    manualOverride,
    cooldownTurnsLeft: 0,
    routineUserTurns: 0,
    errorStreak: 0,
    writePathsInCurrentUserTurn: new Set(),
    explicitComplexityInCurrentUserTurn: false,
  };
}

export function resetAdaptiveRoutingState(
  state: AdaptiveRoutingState,
  { manualOverride = state.manualOverride }: { manualOverride?: boolean } = {},
): AdaptiveRoutingState {
  state.manualOverride = manualOverride;
  state.cooldownTurnsLeft = 0;
  state.routineUserTurns = 0;
  state.errorStreak = 0;
  state.writePathsInCurrentUserTurn.clear();
  state.explicitComplexityInCurrentUserTurn = false;
  return state;
}

export function beginAdaptiveUserTurn(state: AdaptiveRoutingState): void {
  state.writePathsInCurrentUserTurn.clear();
  state.explicitComplexityInCurrentUserTurn = false;
}

/**
 */
export function effectiveBundleFromProviderConfig(config: ProviderConfig, catalog: ModelCatalog = {}): EffectiveBundle {
  const role = (config.role || "default") as RoleName;
  const roleEntry: RoleModelConfig = catalog.roles?.[role] || catalog.roles?.default || {};
  return {
    provider: config.provider,
    model: config.model,
    modelId: config.modelId,
    role,
    reasoningEffort: (roleEntry.reasoning_effort || catalog.current?.model_reasoning_effort || "high") as ReasoningEffort,
  };
}

/**
 * Two bundles are "equal" only when they represent the same route. Effort now
 * counts even though z.ai is the only provider with a wire-level thinking
 * toggle today: routing is provider-agnostic, and effort changes must remain
 * visible when a pinned model moves between quick/high-style roles.
 *
 */
export function bundlesEqual(a: EffectiveBundle | null | undefined, b: EffectiveBundle | null | undefined): boolean {
  return !!a && !!b &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.modelId === b.modelId &&
    a.reasoningEffort === b.reasoningEffort;
}

/**
 */
export function classifyPromptForRouting(prompt: string | null | undefined, options: PromptRoleOptions = {}): PromptRoutingSignal {
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
 */
export function observePromptIntake(
  state: AdaptiveRoutingState,
  prompt: string | null | undefined,
  options: PromptRoleOptions = {},
): PromptRoutingSignal {
  const signal = classifyPromptForRouting(prompt, options);
  state.explicitComplexityInCurrentUserTurn = signal.explicitComplexity;
  if (signal.explicitComplexity) state.routineUserTurns = 0;
  return signal;
}

/**
 */
export function evaluatePromptRouting({ state, currentBundle, candidateBundle, signal }: PromptRoutingOptions): RoutingDecision | null {
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
 */
export function observeToolResult(
  state: AdaptiveRoutingState,
  { toolName, toolInput, result, handlerThrew = false }: ToolResultObservation,
): ToolRoutingSignal {
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
 */
export function evaluateToolResultRouting({ state, currentBundle, candidateBundle }: ToolRoutingOptions): RoutingDecision | null {
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
 */
export function evaluateUserTurnCompleteRouting({
  state,
  currentBundle,
  quickBundle,
  turnSummary = {},
}: UserTurnRoutingOptions): RoutingDecision | null {
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
 */
export function recordRoutingApplied(state: AdaptiveRoutingState, decision: RoutingDecision): void {
  state.cooldownTurnsLeft = COOLDOWN_USER_TURNS;
  state.routineUserTurns = 0;
  state.errorStreak = 0;
  if (decision.direction === "deescalate") {
    state.writePathsInCurrentUserTurn.clear();
  }
}

export function highRole(): RoleName {
  return HIGH_ROLE;
}

function roleRank(role: RoleName | string | null | undefined): number {
  return ROLE_RANK[String(role || "")] || ROLE_RANK.default;
}

function tickCooldown(state: AdaptiveRoutingState): void {
  if (state.cooldownTurnsLeft > 0) state.cooldownTurnsLeft -= 1;
}

/**
 */
function buildDecision({
  state,
  source,
  currentBundle,
  candidateBundle,
  reason,
  direction,
  hard,
}: BuildDecisionOptions): RoutingDecision | null {
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
