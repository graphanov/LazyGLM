import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "../src/agent/context.js";

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
