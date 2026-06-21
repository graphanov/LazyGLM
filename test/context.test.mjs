import { test } from "node:test";
import assert from "node:assert/strict";
import { Context, assistantMessageFrom } from "../src/agent/context.js";

test("compaction preserves the original task message", async () => {
  const ctx = new Context({ budget: 1 }); // tiny budget → forces compaction
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "Build a todo app with tests. This is the original task." });
  // enough messages to exceed keepRecent+2
  for (let i = 0; i < 20; i++) {
    ctx.push({ role: "assistant", content: `step ${i}` });
    ctx.push({ role: "user", content: `nudge ${i}` });
  }
  const compacted = await ctx.maybeCompact();
  assert.ok(compacted, "should have compacted");
  // The original task must survive somewhere in the message list.
  const hasTask = ctx.messages.some((m) => /original task/.test(m.content || ""));
  assert.ok(hasTask, "original task message must be preserved after compaction");
  assert.equal(ctx.compactionCount, 1);
});

test("compaction builds a real digest of dropped work (not a generic placeholder)", async () => {
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  // Simulate real work in the middle that should be digested.
  ctx.push({
    role: "assistant",
    content: "I will create the main file.",
    tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "src/main.js", content: "x" }) } }],
  });
  ctx.push({ role: "tool", tool_call_id: "c1", content: "wrote src/main.js" });
  ctx.push({
    role: "assistant",
    content: "",
    tool_calls: [{ id: "c2", type: "function", function: { name: "run_shell", arguments: JSON.stringify({ command: "npm test" }) } }],
  });
  ctx.push({ role: "tool", tool_call_id: "c2", content: "Error: tests failed exit code 1" });
  // recent tail
  for (let i = 0; i < 14; i++) ctx.push({ role: "assistant", content: `recent ${i}` });

  await ctx.maybeCompact();
  const summary = ctx.messages.find((m) => m.role === "system" && /Compacted transcript/.test(m.content || ""));
  assert.ok(summary, "compaction summary should exist");
  assert.match(summary.content, /src\/main\.js/, "digest should list the file written");
  assert.match(summary.content, /npm test/, "digest should list the command run");
  assert.match(summary.content, /tests failed/i, "digest should record the error");
  assert.doesNotMatch(summary.content, /^\[Compacted[^\n]*\]\n\n\(no notable actions/, "digest must not be the empty placeholder when work was done");
});

test("compaction does not trigger when under budget", async () => {
  const ctx = new Context({ budget: 100_000 });
  ctx.setSystem("sys");
  ctx.push({ role: "user", content: "task" });
  ctx.push({ role: "assistant", content: "ok" });
  const compacted = await ctx.maybeCompact();
  assert.equal(compacted, false);
  assert.equal(ctx.compactionCount, 0);
});

// --- assistantMessageFrom (preserved-thinking replay) ---

test("assistantMessageFrom preserves reasoning_content verbatim and serializes tool_calls to wire form", () => {
  const resp = {
    content: "I'll create the file.",
    reasoning: "First consider A, then act on B.",
    tool_calls: [
      { id: "call_1", type: "function", name: "write_file", arguments: { path: "a.js", content: "x" } },
    ],
  };
  const msg = assistantMessageFrom(resp);
  assert.equal(msg.role, "assistant");
  assert.equal(msg.content, "I'll create the file.");
  assert.equal(msg.reasoning_content, "First consider A, then act on B.", "reasoning_content attached verbatim");
  assert.ok(Array.isArray(msg.tool_calls));
  assert.equal(msg.tool_calls[0].id, "call_1");
  assert.equal(msg.tool_calls[0].type, "function");
  assert.equal(msg.tool_calls[0].function.name, "write_file");
  assert.equal(
    typeof msg.tool_calls[0].function.arguments,
    "string",
    "wire form must serialize arguments to a string",
  );
  assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { path: "a.js", content: "x" });
});

test("assistantMessageFrom omits reasoning_content/tool_calls keys when absent", () => {
  const msg = assistantMessageFrom({ content: "hi" });
  assert.equal(msg.content, "hi");
  assert.equal("reasoning_content" in msg, false, "no reasoning key when absent");
  assert.equal("tool_calls" in msg, false, "no tool_calls key when absent");
  // empty/null reasoning should not attach
  const empty = assistantMessageFrom({ content: "x", reasoning: null, tool_calls: [] });
  assert.equal("reasoning_content" in empty, false);
  assert.equal("tool_calls" in empty, false, "empty tool_calls array should not attach");
});

// --- estimateTokens counts reasoning_content ---

test("estimateTokens counts reasoning_content: a message with reasoning scores higher than without", () => {
  const without = new Context();
  without.push({ role: "assistant", content: "done" });
  const withReasoning = new Context();
  withReasoning.push({ role: "assistant", content: "done", reasoning_content: "A".repeat(400) });
  assert.ok(
    withReasoning.estimateTokens() > without.estimateTokens(),
    "reasoning_content must raise the token estimate",
  );
});

test("estimateTokens ignores reasoning_content when preserveThinking is false (stripping providers)", () => {
  // Regression for Codex review finding on head f255126: ollama/nous/custom
  // (and LAZYGLM_PRESERVE_THINKING=off) strip reasoning_content from the wire
  // payload, so counting it against the budget would force premature compaction.
  const stripping = new Context({ preserveThinking: false });
  stripping.push({ role: "assistant", content: "done", reasoning_content: "A".repeat(400) });
  const baseline = new Context({ preserveThinking: false });
  baseline.push({ role: "assistant", content: "done" });
  assert.equal(
    stripping.estimateTokens(),
    baseline.estimateTokens(),
    "reasoning_content must not count toward the budget when the provider strips it",
  );
  // And a flipping check: toggling preserveThinking back on makes it count.
  stripping.preserveThinking = true;
  assert.ok(
    stripping.estimateTokens() > baseline.estimateTokens(),
    "reasoning_content must count again once preserveThinking is enabled",
  );
});
