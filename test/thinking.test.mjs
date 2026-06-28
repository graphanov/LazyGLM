import { test } from "node:test";
import assert from "node:assert/strict";
import { thinkingControlForRequest } from "../src/agent/thinking.js";

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

