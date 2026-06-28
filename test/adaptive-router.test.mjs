import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COOLDOWN_USER_TURNS,
  ROUTINE_USER_TURNS_THRESHOLD,
  beginAdaptiveUserTurn,
  bundlesEqual,
  classifyPromptForRouting,
  createAdaptiveRoutingState,
  effectiveBundleFromProviderConfig,
  evaluatePromptRouting,
  evaluateToolResultRouting,
  evaluateUserTurnCompleteRouting,
  highRole,
  observePromptIntake,
  observeToolResult,
} from "../src/agent/adaptive-router.js";
import { isToolErrorResult } from "../src/agent/tool-errors.js";
import { resolveProviderConfig } from "../src/agent/provider.js";

const catalog = {
  current: { model_reasoning_effort: "high" },
  roles: {
    default: { model: "glm-5.2", reasoning_effort: "high" },
    worker: { model: "glm-5.2", reasoning_effort: "high" },
    ultrabrain: { model: "glm-5.2", reasoning_effort: "high" },
    planner: { model: "glm-5.2", reasoning_effort: "high" },
    verifier: { model: "glm-4.7", reasoning_effort: "high" },
    quick: { model: "glm-4.7", reasoning_effort: "low" },
  },
};

function configForRole(role) {
  const entry = catalog.roles[role];
  return {
    baseURL: "http://localhost:11434/v1",
    apiKey: "ollama",
    model: entry.model,
    modelId: entry.model,
    provider: "ollama",
    role,
    timeout: 1,
    maxRetries: 0,
  };
}

function bundle(role) {
  return effectiveBundleFromProviderConfig(configForRole(role), catalog);
}

test("effective bundle equality treats default -> planner as a no-op", () => {
  const current = bundle("default");
  const candidate = bundle("planner");

  assert.equal(bundlesEqual(current, candidate), true);

  const state = createAdaptiveRoutingState();
  const signal = classifyPromptForRouting("refactor the auth module");
  const decision = evaluatePromptRouting({
    state,
    currentBundle: current,
    candidateBundle: candidate,
    signal,
  });

  assert.equal(decision, null);
});

test("prompt intake escalates from quick to high for cleanup/database-layer work", () => {
  const state = createAdaptiveRoutingState();
  beginAdaptiveUserTurn(state);

  const signal = observePromptIntake(state, "clean up the database layer");
  const decision = evaluatePromptRouting({
    state,
    currentBundle: bundle("quick"),
    candidateBundle: bundle(signal.role),
    signal,
  });

  assert.equal(signal.explicitComplexity, true);
  assert.equal(signal.role, "planner");
  assert.equal(decision?.direction, "escalate");
  assert.equal(decision?.to.model, "glm-5.2");
  assert.equal(decision?.to.reasoningEffort, "high");
  assert.match(decision?.reason || "", /cleanup\/refactor/);
});

test("detectRole-backed prompt candidate maps refactor to high but stays stable when already high", () => {
  const signal = classifyPromptForRouting("refactor auth module");
  assert.equal(signal.role, "planner");

  const state = createAdaptiveRoutingState();
  const decision = evaluatePromptRouting({
    state,
    currentBundle: bundle("default"),
    candidateBundle: bundle(signal.role),
    signal,
  });

  assert.equal(decision, null);
});

test("shared tool error helper matches runtime error result forms", () => {
  assert.equal(isToolErrorResult("Error executing run_shell: boom"), true);
  assert.equal(isToolErrorResult("Error: old_string not found"), true);
  assert.equal(isToolErrorResult("Command exited 1:\nnope"), true);
  assert.equal(isToolErrorResult("Blocked by hook:\nwrite denied"), true);
  assert.equal(isToolErrorResult("patched src/repl.js (1 replacement)"), false);
});

test("effort-only bundle differences are treated as equal (no-op routes)", () => {
  // Same provider/model/modelId, differing only in reasoningEffort — as when
  // LAZYGLM_MODEL pins the model across quick/default candidates. Routing must
  // not churn on this since resolveProviderConfig/chat never carry effort.
  const a = { provider: "ollama", model: "glm-4.7", modelId: "glm-4.7", role: "quick", reasoningEffort: "low" };
  const b = { provider: "ollama", model: "glm-4.7", modelId: "glm-4.7", role: "default", reasoningEffort: "high" };
  assert.equal(bundlesEqual(a, b), true);

  // A real model change is still a real route.
  const c = { provider: "ollama", model: "glm-5.2", modelId: "glm-5.2", role: "default", reasoningEffort: "high" };
  assert.equal(bundlesEqual(a, c), false);
});

test("blocked PreToolUse hook result counts as a tool error for adaptive routing", () => {
  const state = createAdaptiveRoutingState();

  observeToolResult(state, {
    toolName: "write_file",
    toolInput: { path: "src/x.js" },
    result: "Blocked by hook:\nwrite denied",
  });
  assert.equal(state.errorStreak, 1);

  observeToolResult(state, {
    toolName: "write_file",
    toolInput: { path: "src/y.js" },
    result: "Blocked by hook:\nwrite denied",
  });
  assert.equal(state.errorStreak, 2);

  const decision = evaluateToolResultRouting({
    state,
    currentBundle: bundle("quick"),
    candidateBundle: bundle(highRole()),
  });
  assert.equal(decision?.source, "tool_result");
  assert.equal(decision?.hard, true);
  assert.match(decision?.reason || "", /2 tool errors/);
});

test("two consecutive tool errors escalate to the high bundle", () => {
  const state = createAdaptiveRoutingState();

  observeToolResult(state, { toolName: "run_shell", result: "Error executing run_shell: first" });
  assert.equal(
    evaluateToolResultRouting({
      state,
      currentBundle: bundle("quick"),
      candidateBundle: bundle(highRole()),
    }),
    null,
  );

  observeToolResult(state, { toolName: "run_shell", result: "Command exited 1:\nfail" });
  const decision = evaluateToolResultRouting({
    state,
    currentBundle: bundle("quick"),
    candidateBundle: bundle(highRole()),
  });

  assert.equal(decision?.source, "tool_result");
  assert.equal(decision?.hard, true);
  assert.match(decision?.reason || "", /2 tool errors/);
  assert.equal(decision?.to.model, "glm-5.2");
});

test("two distinct write paths in one user turn escalate to the high bundle", () => {
  const state = createAdaptiveRoutingState();
  beginAdaptiveUserTurn(state);

  observeToolResult(state, {
    toolName: "write_file",
    toolInput: { path: "src/a.js" },
    result: "wrote src/a.js (10 bytes)",
  });
  assert.equal(
    evaluateToolResultRouting({
      state,
      currentBundle: bundle("quick"),
      candidateBundle: bundle(highRole()),
    }),
    null,
  );

  observeToolResult(state, {
    toolName: "patch_file",
    toolInput: { path: "src/b.js" },
    result: "patched src/b.js (1 replacement)",
  });
  const decision = evaluateToolResultRouting({
    state,
    currentBundle: bundle("quick"),
    candidateBundle: bundle(highRole()),
  });

  assert.equal(decision?.hard, true);
  assert.match(decision?.reason || "", /2 files changed/);
});

test("routine de-escalation counts completed user turns, not internal tool results", () => {
  const state = createAdaptiveRoutingState();
  for (let i = 0; i < 5; i++) {
    observeToolResult(state, { toolName: "read_file", result: "ok" });
  }
  assert.equal(state.routineUserTurns, 0);

  for (let i = 1; i < ROUTINE_USER_TURNS_THRESHOLD; i++) {
    const decision = evaluateUserTurnCompleteRouting({
      state,
      currentBundle: bundle("default"),
      quickBundle: bundle("quick"),
      turnSummary: {},
    });
    assert.equal(decision, null);
    assert.equal(state.routineUserTurns, i);
  }

  const decision = evaluateUserTurnCompleteRouting({
    state,
    currentBundle: bundle("default"),
    quickBundle: bundle("quick"),
    turnSummary: {},
  });

  assert.equal(decision?.direction, "deescalate");
  assert.equal(decision?.to.model, "glm-4.7");
  assert.equal(decision?.to.reasoningEffort, "low");
});

test("manual override suppresses prompt, tool, and routine adaptive decisions", () => {
  const state = createAdaptiveRoutingState({ manualOverride: true });
  const signal = observePromptIntake(state, "clean up the database layer");
  assert.equal(
    evaluatePromptRouting({
      state,
      currentBundle: bundle("quick"),
      candidateBundle: bundle(signal.role),
      signal,
    }),
    null,
  );

  observeToolResult(state, { toolName: "run_shell", result: "Error executing run_shell: first" });
  observeToolResult(state, { toolName: "run_shell", result: "Error executing run_shell: second" });
  assert.equal(
    evaluateToolResultRouting({
      state,
      currentBundle: bundle("quick"),
      candidateBundle: bundle(highRole()),
    }),
    null,
  );

  state.routineUserTurns = ROUTINE_USER_TURNS_THRESHOLD - 1;
  assert.equal(
    evaluateUserTurnCompleteRouting({
      state,
      currentBundle: bundle("default"),
      quickBundle: bundle("quick"),
      turnSummary: {},
    }),
    null,
  );
});

test("cooldown blocks routine de-escalation but hard tool escalation remains allowed", () => {
  const routineState = createAdaptiveRoutingState();
  routineState.cooldownTurnsLeft = 1;
  routineState.routineUserTurns = ROUTINE_USER_TURNS_THRESHOLD - 1;

  assert.equal(
    evaluateUserTurnCompleteRouting({
      state: routineState,
      currentBundle: bundle("default"),
      quickBundle: bundle("quick"),
      turnSummary: {},
    }),
    null,
  );
  assert.equal(routineState.cooldownTurnsLeft, 0);

  const errorState = createAdaptiveRoutingState();
  errorState.cooldownTurnsLeft = COOLDOWN_USER_TURNS;
  observeToolResult(errorState, { toolName: "run_shell", result: "Error executing run_shell: first" });
  observeToolResult(errorState, { toolName: "run_shell", result: "Error executing run_shell: second" });

  const decision = evaluateToolResultRouting({
    state: errorState,
    currentBundle: bundle("quick"),
    candidateBundle: bundle(highRole()),
  });

  assert.equal(decision?.hard, true);
  assert.equal(decision?.direction, "escalate");
});

test("resolveProviderConfig quick role produces the low-effort glm-4.7 bundle", async () => {
  const savedModel = process.env.LAZYGLM_MODEL;
  try {
    delete process.env.LAZYGLM_MODEL;
    const cfg = await resolveProviderConfig({ provider: "ollama", role: "quick" });
    const effective = effectiveBundleFromProviderConfig(cfg, catalog);
    assert.equal(effective.model, "glm-4.7");
    assert.equal(effective.modelId, "glm-4.7");
    assert.equal(effective.reasoningEffort, "low");
  } finally {
    if (savedModel === undefined) delete process.env.LAZYGLM_MODEL;
    else process.env.LAZYGLM_MODEL = savedModel;
  }
});

test("steady non-escalating signals produce no routing decision", () => {
  const state = createAdaptiveRoutingState();
  const signal = observePromptIntake(state, "list files");

  assert.equal(
    evaluatePromptRouting({
      state,
      currentBundle: bundle("default"),
      candidateBundle: bundle(signal.role),
      signal,
    }),
    null,
  );

  observeToolResult(state, { toolName: "read_file", result: "ok" });
  assert.equal(
    evaluateToolResultRouting({
      state,
      currentBundle: bundle("default"),
      candidateBundle: bundle(highRole()),
    }),
    null,
  );
});
