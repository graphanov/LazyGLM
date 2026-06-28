import { test } from "node:test";
import assert from "node:assert/strict";
import { thinkingControlForRequest, supportsReasoningEffort } from "../src/agent/thinking.js";

test("thinkingControlForRequest maps only z.ai low effort to disabled", () => {
  assert.deepEqual(
    thinkingControlForRequest({ provider: "zai", reasoningEffort: "low", preserveThinking: true }),
    { type: "disabled" },
  );
  assert.equal(
    thinkingControlForRequest({ provider: "ollama", reasoningEffort: "low", preserveThinking: true }),
    null,
  );
});

test("thinkingControlForRequest maps medium high max to enabled", () => {
  for (const reasoningEffort of ["medium", "high", "max"]) {
    assert.deepEqual(
      thinkingControlForRequest({ provider: "zai", reasoningEffort, preserveThinking: false }),
      { type: "enabled" },
    );
  }
});

test("thinkingControlForRequest preserves z.ai thinking chains only when requested", () => {
  assert.deepEqual(
    thinkingControlForRequest({ provider: "zai", reasoningEffort: "high", preserveThinking: true }),
    { type: "enabled", clear_thinking: false },
  );
  assert.deepEqual(
    thinkingControlForRequest({ provider: "zai", reasoningEffort: "high", preserveThinking: false }),
    { type: "enabled" },
  );
});

// --- supportsReasoningEffort ---

test("supportsReasoningEffort: true only for GLM-5.2 and above", () => {
  assert.equal(supportsReasoningEffort("glm-5.2"), true);
  assert.equal(supportsReasoningEffort("glm-5.2-flash"), true);
  assert.equal(supportsReasoningEffort("glm-6.0"), true);
});

test("supportsReasoningEffort: false for models below the 5.2 floor", () => {
  assert.equal(supportsReasoningEffort("glm-4.7"), false);
  assert.equal(supportsReasoningEffort("glm-4.7-flash"), false);
  assert.equal(supportsReasoningEffort("glm-5.1"), false);
  assert.equal(supportsReasoningEffort("glm-5.0"), false);
});

test("supportsReasoningEffort: false for unparseable / empty names", () => {
  assert.equal(supportsReasoningEffort(""), false);
  assert.equal(supportsReasoningEffort("custom"), false);
  assert.equal(supportsReasoningEffort(undefined), false);
  assert.equal(supportsReasoningEffort(null), false);
});

