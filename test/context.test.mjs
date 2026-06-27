import { test } from "node:test";
import assert from "node:assert/strict";
import { Context, assistantMessageFrom } from "../src/agent/context.js";

function latestCompactionSummary(ctx) {
  const summaries = ctx.messages.filter((m) => m.role === "system" && /Compacted transcript/.test(m.content || ""));
  return summaries[summaries.length - 1];
}

function decisionsBlock(summary) {
  const marker = "Decisions & rationale:\n";
  const content = summary?.content || "";
  const idx = content.indexOf(marker);
  if (idx < 0) return "";
  return content.slice(idx + marker.length).split("\n\nThe user's original task")[0];
}

function pushRecentTail(ctx, prefix = "recent", count = 14) {
  for (let i = 0; i < count; i++) ctx.push({ role: "assistant", content: `${prefix} ${i}` });
}

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

test("compaction digest retains explicit assistant decisions", async () => {
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  pushRecentTail(ctx);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  assert.ok(summary, "compaction summary should exist");
  assert.match(decisionsBlock(summary), /I decided to use Postgres for persistence\./);
});

test("compaction digest retains because-based rationale", async () => {
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "Going with Postgres because it handles concurrent writes." });
  pushRecentTail(ctx);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  assert.match(decisionsBlock(summary), /Going with Postgres because it handles concurrent writes\./);
});

test("compaction decisions skip generic implementation notes", async () => {
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I'll use write_file to create the config." });
  pushRecentTail(ctx);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  assert.equal(decisionsBlock(summary), "", "generic tool-use notes should not become decisions");
});

test("compaction decisions require because for going-with phrasing", async () => {
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "Going with the existing approach to keep it simple." });
  pushRecentTail(ctx);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  assert.equal(decisionsBlock(summary), "", "going-with phrasing without because should not become a decision");
});

test("compaction decision extraction ignores tool messages", async () => {
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "tool", content: "decided to skip failing test" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  pushRecentTail(ctx);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);
  assert.match(block, /I decided to use Postgres for persistence\./);
  assert.doesNotMatch(block, /decided to skip failing test/);
});

test("compaction decisions preserve dotted paths and identifiers", async () => {
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  // The sentence splitter must not treat the period inside a path/identifier as
  // a sentence boundary, or the decision text is truncated mid-token.
  ctx.push({ role: "assistant", content: "I decided to update src/context.js because it owns compaction." });
  pushRecentTail(ctx);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  assert.match(decisionsBlock(summary), /I decided to update src\/context\.js because it owns compaction\./);
});

test("long decisions are truncated to a single digest line", async () => {
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  // A decision cue sentence longer than 200 chars; it must collapse to one line.
  const long = "I decided to adopt a layered architecture because " + "detail ".repeat(40);
  ctx.push({ role: "assistant", content: long });
  pushRecentTail(ctx);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);
  assert.match(block, /I decided to adopt a layered architecture because/, "long decision should be retained");
  // The numbered entry must occupy exactly one line: no newline + truncation marker.
  assert.doesNotMatch(block, /\n…\[truncated/, "long decision must not get a multi-line truncation marker");
  // Every non-empty line in the decisions block must start with a number prefix.
  for (const line of block.split("\n").filter((l) => l.trim())) {
    assert.match(line, /^\d+\./, `each decisions line should be numbered, got: ${line.slice(0, 60)}`);
  }
});

test("compaction drops a reversed decision when a user override follows it", async () => {
  // Regression for the P2 finding: a compacted user turn reverses an earlier
  // assistant decision ("I decided to use Postgres." → "Actually use SQLite").
  // The rejected decision must NOT survive in the handoff digest, or the agent
  // keeps surfacing a superseded choice after the correction is gone.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  ctx.push({ role: "user", content: "Actually use SQLite instead." });
  pushRecentTail(ctx);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);
  assert.doesNotMatch(block, /Postgres/i, "a decision reversed by a later user turn must not persist in the digest");
  assert.doesNotMatch(
    summary.content,
    /I decided to use Postgres for persistence\./,
    "a reversed decision must not survive via Agent notes either",
  );
});

test("compaction keeps decisions emitted after a user override", async () => {
  // The override only supersedes decisions captured before it; decisions made
  // after the correction are still relevant and must be retained.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  ctx.push({ role: "user", content: "Actually use SQLite instead." });
  ctx.push({ role: "assistant", content: "I decided to keep the parser dependency-free." });
  pushRecentTail(ctx);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);
  assert.doesNotMatch(block, /Postgres/i, "reversed decision before the override must be dropped");
  assert.match(block, /I decided to keep the parser dependency-free\./, "later decision must be retained");
});

test("override allows a later reaffirmation of the same decision text", async () => {
  // Regression for the P2 finding: duplicate suppression is scoped to the
  // current effective decision list. If an override clears a pre-correction
  // decision, the same normalized text can be valid again when the assistant
  // reaffirms it after the correction.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use SQLite for persistence." });
  ctx.push({ role: "user", content: "Actually use SQLite instead." });
  ctx.push({ role: "assistant", content: "I decided to use SQLite for persistence." });
  pushRecentTail(ctx);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);
  assert.match(block, /I decided to use SQLite for persistence\./, "a post-override reaffirmation must not be hidden by stale duplicate cache");
});

test("compaction does not drop decisions on a neutral user turn", async () => {
  // A user turn without a reversal cue must not clear decisions — guards
  // against false-positive overrides on ordinary conversational messages.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  ctx.push({ role: "user", content: "Sounds good, please continue." });
  pushRecentTail(ctx);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);
  assert.match(block, /I decided to use Postgres for persistence\./, "neutral user turn must not drop the decision");
});

test("post-compact inject lands immediately after summary when system exists", async () => {
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  pushRecentTail(ctx, "middle", 20);

  await ctx.maybeCompact({ onCompact: async () => ["injected handoff context"] });
  const summaryIdx = ctx.messages.findIndex((m) => /Compacted transcript/.test(m.content || ""));
  const injectIdx = ctx.messages.findIndex((m) => m.role === "system" && m.content === "injected handoff context");

  assert.ok(summaryIdx >= 0, "summary should exist");
  assert.equal(injectIdx, summaryIdx + 1, "inject should be placed immediately after summary");
});

test("post-compact inject lands immediately after summary when system is absent", async () => {
  const ctx = new Context({ budget: 1 });
  ctx.push({ role: "user", content: "the task" });
  pushRecentTail(ctx, "middle", 20);

  await ctx.maybeCompact({ onCompact: async () => ["injected context"] });
  const summaryIdx = ctx.messages.findIndex((m) => /Compacted transcript/.test(m.content || ""));
  const injectIdx = ctx.messages.findIndex((m) => m.role === "system" && m.content === "injected context");

  assert.equal(ctx.messages[0].role, "user");
  assert.equal(summaryIdx, 1, "summary should follow the pinned task without a system prompt");
  assert.equal(injectIdx, 2, "inject should follow the summary without hardcoded system-present indexing");
});

test("compaction decisions accumulate across multiple compactions", async () => {
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to keep the parser dependency-free." });
  pushRecentTail(ctx, "first");

  await ctx.maybeCompact();

  ctx.push({ role: "assistant", content: "The plan is to thread hook injects through the existing callback." });
  pushRecentTail(ctx, "second");

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.equal(ctx.compactionCount, 2);
  assert.match(block, /I decided to keep the parser dependency-free\./);
  assert.match(block, /The plan is to thread hook injects through the existing callback\./);
});

test("a user override in a later compaction evicts decisions persisted from an earlier pass", async () => {
  // Regression for the P2 finding: a decision stored in compaction 1 must be
  // evicted when a later dropped slice contains a user override. Without this,
  // "I decided to use Postgres" (persisted) survives "Actually use SQLite" in a
  // later compaction and keeps surfacing in handoff digests after the rejection.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  pushRecentTail(ctx, "first");

  await ctx.maybeCompact(); // pass 1: persists the Postgres decision

  // Pass 2 dropped slice: a user override with no assistant decision before it.
  ctx.push({ role: "user", content: "Actually use SQLite instead." });
  pushRecentTail(ctx, "second");

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.equal(ctx.compactionCount, 2);
  assert.doesNotMatch(block, /Postgres/i, "a decision persisted in an earlier pass must be evicted by a later override");
});

test("a user override in the retained tail evicts decisions persisted from an earlier pass", async () => {
  // Regression for the P2 finding: compaction runs immediately after a new user
  // turn, so the override ("Actually use SQLite") lands in the kept recent tail,
  // not in `dropped`. extractDecisions only scans `dropped`, so without a tail
  // override check the persisted Postgres decision survives into the new digest
  // even though the user explicitly reversed it in the live window.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  pushRecentTail(ctx, "first");

  await ctx.maybeCompact(); // pass 1: persists the Postgres decision

  // The override lands in the retained tail: only a few messages are pushed so
  // the override stays within keepRecent=12 and is never in `dropped`.
  ctx.push({ role: "user", content: "Actually use SQLite instead." });
  ctx.push({ role: "assistant", content: "Understood, switching to SQLite now." });

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.equal(ctx.compactionCount, 2);
  assert.doesNotMatch(block, /Postgres/i, "a decision persisted in an earlier pass must be evicted by an override in the retained tail");
});

test("tail override suppresses dropped decisions from the same compaction", async () => {
  // Regression for the P2 finding: when the override is in the retained tail,
  // tailOverridden clears this.decisions but the loop immediately re-adds
  // newDecisions extracted from `dropped` — which are all pre-correction. So a
  // superseded decision ("I decided to use Postgres") reappears in the digest
  // even though the user's correction ("Actually use SQLite") is live in the tail.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  // The decision lands in `dropped` for this compaction.
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  pushRecentTail(ctx, "middle", 13); // enough to push the decision into dropped
  // The override lands in the retained tail (the common path: compaction runs
  // right after a new user turn).
  ctx.push({ role: "user", content: "Actually use SQLite instead." });
  pushRecentTail(ctx, "recent", 1);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.doesNotMatch(
    block,
    /Postgres/i,
    "a pre-correction decision in `dropped` must not re-enter the digest when an override is live in the tail",
  );
});

test("targeted tail override preserves unrelated dropped decisions", async () => {
  // A live targeted correction should evict only the rejected old choice. Other
  // decisions from the compacted slice remain valid handoff context.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to keep the parser dependency-free." });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  pushRecentTail(ctx, "middle", 13);
  ctx.push({ role: "user", content: "Use SQLite instead of Postgres." });
  pushRecentTail(ctx, "recent", 1);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.match(
    block,
    /I decided to keep the parser dependency-free\./,
    "a targeted tail override must preserve unrelated decisions",
  );
  assert.doesNotMatch(block, /Postgres/i, "a targeted tail override must evict only the superseded choice");
});

test("Context.reset clears decisions alongside messages", () => {
  // Regression for the P2 finding: this.decisions lives outside messages, so
  // /clear and /resume (which only replace ctx.messages) left stale rationale
  // in the next compaction digest. A reset() API must zero both.
  const ctx = new Context({ budget: 1 });
  ctx.addDecision("I decided to use Postgres for persistence.");
  ctx.push({ role: "user", content: "the task" });

  assert.equal(ctx.getDecisions().length, 1, "decision should be stored before reset");

  ctx.reset();

  assert.deepEqual(ctx.getDecisions(), [], "reset() must clear the decision store");
  assert.equal(ctx.compactionCount, 0, "reset() must reset compactionCount");
});

test("resetToSystemPrompt drops compaction summaries and one-shot injects", async () => {
  // Regression for the P2 finding: /clear and /resume used to keep every
  // system-role message. Compaction summaries and PostCompact injects are
  // system-role messages too, but they are scoped to the current compacted
  // conversation and must not steer a fresh/replayed transcript.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  pushRecentTail(ctx, "middle", 20);

  await ctx.maybeCompact({ onCompact: async () => ["temporary handoff context"] });
  ctx.addDecision("I decided to use Postgres for persistence.");

  assert.ok(ctx.messages.some((m) => /Compacted transcript/.test(m.content || "")), "summary should exist before reset");
  assert.ok(ctx.messages.some((m) => m.content === "temporary handoff context"), "inject should exist before reset");

  ctx.resetToSystemPrompt();

  assert.deepEqual(ctx.messages, [{ role: "system", content: "system prompt" }]);
  assert.deepEqual(ctx.getDecisions(), [], "resetToSystemPrompt must clear the decision store");
  assert.equal(ctx.compactionCount, 0, "resetToSystemPrompt must reset compactionCount");
});

test("neutral negation user turn does not drop decisions", async () => {
  // Regression for the P2 finding: broad negation cues like /\bnot\b/i and
  // /\bdon'?t\b/i matched ordinary messages ("Do not run tests yet"), wrongly
  // clearing the Decisions & rationale block in multi-compaction sessions.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  // A neutral instruction that contains "not" but does not reverse any decision.
  ctx.push({ role: "user", content: "Do not run tests yet." });
  pushRecentTail(ctx, "filler", 13);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.match(
    block,
    /I decided to use Postgres for persistence\./,
    "a neutral negation message must not evict decisions",
  );
});

test("neutral wait instruction does not drop decisions", async () => {
  // Regression for the P2 finding: /\bwait\b/i was a broad override cue that
  // matched ordinary instructions ("please wait for CI before finalizing") and
  // wrongly cleared the Decisions & rationale block in multi-compaction sessions.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  // A neutral instruction that contains "wait" but does not reverse any decision.
  ctx.push({ role: "user", content: "Please wait for CI before finalizing." });
  pushRecentTail(ctx, "filler", 13);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.match(
    block,
    /I decided to use Postgres for persistence\./,
    "a neutral wait message must not evict decisions",
  );
});

test("neutral switch statement discussion does not drop decisions", async () => {
  // Regression for the P2 finding: /\bswitch\b/i was a broad override cue that
  // matched ordinary code discussion ("the switch statement still fails") and
  // wrongly cleared the Decisions & rationale block in multi-compaction sessions.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  // A neutral diagnostic sentence that contains "switch" but does not reverse any decision.
  ctx.push({ role: "user", content: "The switch statement still fails in the parser." });
  pushRecentTail(ctx, "filler", 13);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.match(
    block,
    /I decided to use Postgres for persistence\./,
    "a neutral switch statement message must not evict decisions",
  );
});

test("neutral actually request does not drop decisions", async () => {
  // Regression for the P2 finding: standalone /\bactually\b/i matched ordinary
  // follow-up requests ("Actually, please run the full test suite") and wrongly
  // cleared the Decisions & rationale block in multi-compaction sessions.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  // A neutral request that contains "Actually" but does not reverse any decision.
  ctx.push({ role: "user", content: "Actually, please run the full test suite before finishing." });
  pushRecentTail(ctx, "filler", 13);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.match(
    block,
    /I decided to use Postgres for persistence\./,
    "a neutral actually message must not evict decisions",
  );
});

test("neutral actually use tool/action requests do not drop decisions", async () => {
  // Regression for the P2 finding: `actually ... use` is only a replacement when
  // it changes the approach. Routine tool/action requests should not clear a
  // retained unrelated decision.
  for (const request of [
    "Actually, use npm test to verify.",
    "Actually use patch_file to update the README.",
    "Actually, use the test suite to verify.",
    "Actually, use the README to update docs.",
    "Actually use rg to inspect references.",
    "Actually use tsc to verify.",
  ]) {
    const ctx = new Context({ budget: 1 });
    ctx.addDecision("I decided to use Postgres for persistence.");
    ctx.setSystem("system prompt");
    ctx.push({ role: "user", content: "the task" });
    ctx.push({ role: "user", content: request });
    pushRecentTail(ctx, "filler", 13);

    await ctx.maybeCompact();
    const summary = latestCompactionSummary(ctx);
    const block = decisionsBlock(summary);

    assert.match(
      block,
      /I decided to use Postgres for persistence\./,
      `an actually-use tool/action request must not evict decisions: ${request}`,
    );
  }
});

test("actually use technology swap drops superseded decisions", async () => {
  // Regression for the P2 finding: `Actually use Svelte to build the UI` is a
  // technology replacement, not a neutral request to use a tool/command.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use React for the UI." });
  ctx.push({ role: "user", content: "Actually use Svelte to build the UI." });
  pushRecentTail(ctx, "filler", 13);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.doesNotMatch(block, /React/i, "an actually-use technology swap must evict superseded decisions");
});

test("actually use lowercase technology swap drops superseded decisions", async () => {
  // Regression for the P2 finding: a lowercase tech name after an article
  // ("a svelte frontend") was treated as a neutral artifact because only
  // title-case first words returned false from isNeutralActionUseTurn. The
  // rejected prior decision then survived compaction in the digest.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use React for the UI." });
  ctx.push({ role: "user", content: "Actually use a svelte frontend to build the UI." });
  pushRecentTail(ctx, "filler", 13);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.doesNotMatch(block, /React/i, "a lowercase tech swap must evict superseded decisions");
});

test("neutral search/find tool-action requests do not drop decisions", async () => {
  // Regression for the P2 finding: search/find/look verbs were missing from
  // the neutral-action list, so "Actually use rg to search the repo" matched
  // ACTUALLY_REPLACEMENT_CUE and evicted all decisions instead of being treated
  // as a neutral tool/action request.
  for (const request of [
    "Actually use rg to search the repo.",
    "Actually use fd to find the config.",
    "Actually use grep to look for imports.",
  ]) {
    const ctx = new Context({ budget: 1 });
    ctx.addDecision("I decided to use Postgres for persistence.");
    ctx.setSystem("system prompt");
    ctx.push({ role: "user", content: "the task" });
    ctx.push({ role: "user", content: request });
    pushRecentTail(ctx, "filler", 13);

    await ctx.maybeCompact();
    const summary = latestCompactionSummary(ctx);
    const block = decisionsBlock(summary);

    assert.match(
      block,
      /I decided to use Postgres for persistence\./,
      `an actually-use search/find request must not evict decisions: ${request}`,
    );
  }
});

test("article-prefixed technology swap drops superseded decisions", async () => {
  // Regression for the P2 finding: "Actually use a Svelte frontend to build the
  // UI" was classified as neutral because ARTICLE_ACTION_TARGET_CUE matched the
  // article prefix, preserving the stale prior decision instead of evicting it.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use React for the UI." });
  ctx.push({ role: "user", content: "Actually use a Svelte frontend to build the UI." });
  pushRecentTail(ctx, "filler", 13);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.doesNotMatch(block, /React/i, "an article-prefixed technology swap must evict superseded decisions");
});

test("neutral replace edit request does not drop decisions", async () => {
  // Regression for the P2 finding: plain /\breplace\b/i matched ordinary edit
  // requests ("replace the README placeholder"), clearing persisted rationale
  // even though the user was not reversing a prior decision.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  ctx.push({ role: "user", content: "Replace the README placeholder with the final wording." });
  pushRecentTail(ctx, "filler", 13);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.match(
    block,
    /I decided to use Postgres for persistence\./,
    "a neutral replace edit request must not evict decisions",
  );
});

test("neutral change-to edit request does not drop decisions", async () => {
  // Regression for the P2 finding: plain /\bchange\b.*\bto\b/i matched ordinary
  // edit requests ("change the README heading to LazyGLM"), clearing retained
  // rationale even though the user was not reversing a prior decision.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  ctx.push({ role: "user", content: "Change the README heading to LazyGLM." });
  pushRecentTail(ctx, "filler", 13);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.match(
    block,
    /I decided to use Postgres for persistence\./,
    "a neutral change-to edit request must not evict decisions",
  );
});

test("neutral change-to plan file edit request does not drop decisions", async () => {
  // Regression for the P2 finding: `change ... plan ... to` must not treat a
  // file edit like `plan.md` as a decision reversal just because the filename
  // contains "plan".
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  ctx.push({ role: "user", content: "Change plan.md to add a verification checklist." });
  pushRecentTail(ctx, "filler", 13);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.match(
    block,
    /I decided to use Postgres for persistence\./,
    "a plan.md edit request must not evict unrelated decisions",
  );
});

test("decision change-to wording drops superseded decisions", async () => {
  // Keep explicit decision-reversal wording active after narrowing plain change-to
  // requests: changing a prior decision is still an override.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  ctx.push({ role: "user", content: "Change the prior decision to SQLite." });
  pushRecentTail(ctx, "filler", 13);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.doesNotMatch(block, /Postgres/i, "decision change-to wording must evict superseded decisions");
});

test("neutral instead-of command request does not drop decisions", async () => {
  // Regression for the P2 finding: plain /\binstead\b/i matched ordinary
  // command substitutions ("run npm test instead of npm run test"), clearing
  // persisted rationale even though the user was not reversing a prior decision.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  ctx.push({ role: "user", content: "Run `npm test` instead of `npm run test`." });
  pushRecentTail(ctx, "filler", 13);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.match(
    block,
    /I decided to use Postgres for persistence\./,
    "a neutral instead-of command request must not evict decisions",
  );
});

test("neutral use instead-of command request does not drop decisions", async () => {
  // `Use npm test instead of npm run test` has replacement grammar, but the
  // replaced target is not an active prior decision, so retained rationale stays.
  const ctx = new Context({ budget: 1 });
  ctx.addDecision("I decided to use Postgres for persistence.");
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "user", content: "Use `npm test` instead of `npm run test`." });
  pushRecentTail(ctx, "filler", 13);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.match(
    block,
    /I decided to use Postgres for persistence\./,
    "a use instead-of command request must not evict unrelated decisions",
  );
});

test("neutral short instead command request does not drop decisions", async () => {
  // `Use npm test instead` is a routine command substitution; without a named
  // old choice it must not broad-clear unrelated persisted rationale.
  for (const request of ["Use npm test instead.", "Use `npm test` instead."]) {
    const ctx = new Context({ budget: 1 });
    ctx.addDecision("I decided to use Postgres for persistence.");
    ctx.setSystem("system prompt");
    ctx.push({ role: "user", content: "the task" });
    ctx.push({ role: "user", content: request });
    pushRecentTail(ctx, "filler", 13);

    await ctx.maybeCompact();
    const summary = latestCompactionSummary(ctx);
    const block = decisionsBlock(summary);

    assert.match(
      block,
      /I decided to use Postgres for persistence\./,
      `a short command substitution must not evict unrelated decisions: ${request}`,
    );
  }
});

test("neutral short instead generic-target request does not drop decisions", async () => {
  // `Use the existing test command instead.` / `Use the test script instead.`
  // have replacement grammar with an article-prefixed generic artifact target
  // that is not a technology choice, so retained rationale must stay.
  for (const request of [
    "Use the existing test command instead.",
    "Use the test script instead.",
    "Use the current config instead.",
    "Use the README instead.",
  ]) {
    const ctx = new Context({ budget: 1 });
    ctx.addDecision("I decided to use Postgres for persistence.");
    ctx.setSystem("system prompt");
    ctx.push({ role: "user", content: "the task" });
    ctx.push({ role: "user", content: request });
    pushRecentTail(ctx, "filler", 13);

    await ctx.maybeCompact();
    const summary = latestCompactionSummary(ctx);
    const block = decisionsBlock(summary);

    assert.match(
      block,
      /I decided to use Postgres for persistence\./,
      `a generic-artifact short instead request must not evict unrelated decisions: ${request}`,
    );
  }
});

test("bare or identifier short instead drops superseded decisions", async () => {
  // Bare CLI names such as Go can be technology choices; only command-shaped
  // targets like `npm test` should be neutral command substitutions. Backticks
  // can also quote identifiers/package names and must not be neutral by itself.
  for (const request of ["Use Go instead.", "Use `SQLite` instead."]) {
    const ctx = new Context({ budget: 1 });
    ctx.setSystem("system prompt");
    ctx.push({ role: "user", content: "the task" });
    ctx.push({ role: "assistant", content: "I decided to use Rust for the CLI." });
    ctx.push({ role: "user", content: request });
    pushRecentTail(ctx, "filler", 13);

    await ctx.maybeCompact();
    const summary = latestCompactionSummary(ctx);
    const block = decisionsBlock(summary);

    assert.doesNotMatch(block, /Rust/i, `a short replacement must evict superseded decisions: ${request}`);
  }
});

test("short instead database choice with test noun drops superseded decisions", async () => {
  // Regression for the P2 finding: `test` inside a noun phrase like "SQLite
  // test database" is not enough to classify the replacement target as a
  // neutral command substitution.
  for (const persistOldDecision of [false, true]) {
    const ctx = new Context({ budget: 1 });
    ctx.setSystem("system prompt");
    ctx.push({ role: "user", content: "the task" });
    if (persistOldDecision) {
      ctx.addDecision("I decided to use Postgres for persistence.");
    } else {
      ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
    }
    ctx.push({ role: "user", content: "Use a SQLite test database instead." });
    pushRecentTail(ctx, "filler", 13);

    await ctx.maybeCompact();
    const summary = latestCompactionSummary(ctx);
    const block = decisionsBlock(summary);

    assert.doesNotMatch(
      block,
      /Postgres/i,
      `a test-database replacement must evict superseded decisions; persisted=${persistOldDecision}`,
    );
  }
});

test("choice instead-of wording drops superseded decisions", async () => {
  // Regression for the P2 finding: `Use SQLite instead of Postgres` names the
  // old active choice after `instead of`, so it must evict the Postgres rationale.
  // Inline rationale after the old choice must not become part of the target.
  for (const overrideMessage of [
    "Use SQLite instead of Postgres.",
    "Use SQLite instead of Postgres because it is simpler.",
    "Use SQLite instead of Postgres in tests.",
    "Use SQLite instead of Postgres and update tests.",
    "Use SQLite instead of Postgres and do not update tests.",
    "Use SQLite instead of the current Postgres.",
    "Use SQLite instead of using Postgres.",
  ]) {
    for (const persistOldDecision of [false, true]) {
      const ctx = new Context({ budget: 1 });
      ctx.setSystem("system prompt");
      ctx.push({ role: "user", content: "the task" });
      if (persistOldDecision) {
        ctx.addDecision("I decided to use Postgres for persistence.");
      } else {
        ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
      }
      ctx.push({ role: "user", content: overrideMessage });
      pushRecentTail(ctx, "filler", 13);

      await ctx.maybeCompact();
      const summary = latestCompactionSummary(ctx);
      const block = decisionsBlock(summary);

      assert.doesNotMatch(
        block,
        /Postgres/i,
        `choice instead-of wording must evict superseded decisions; persisted=${persistOldDecision}; message=${overrideMessage}`,
      );
    }
  }
});

test("choice instead-of target matching preserves substring-unrelated decisions", async () => {
  // `go` must not match the `go` substring in Mongo.
  const ctx = new Context({ budget: 1 });
  ctx.addDecision("I decided to use Mongo for persistence.");
  ctx.addDecision("I decided to use Go for the CLI.");
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "user", content: "Use Rust instead of Go." });
  pushRecentTail(ctx, "filler", 13);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.match(block, /I decided to use Mongo for persistence\./, "substring-unrelated decisions should survive targeted overrides");
  assert.doesNotMatch(block, /I decided to use Go for the CLI\./, "the named old choice should be evicted");
});

test("choice instead-of with unrelated keep wording drops superseded decisions", async () => {
  // Regression for the P2 finding: a keep/preserve clause for unrelated work
  // must not prevent the named old choice after `instead of` from being evicted.
  for (const persistOldDecision of [false, true]) {
    const ctx = new Context({ budget: 1 });
    ctx.setSystem("system prompt");
    ctx.push({ role: "user", content: "the task" });
    if (persistOldDecision) {
      ctx.addDecision("I decided to use Postgres for persistence.");
    } else {
      ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
    }
    ctx.push({ role: "user", content: "Use SQLite instead of Postgres and keep the parser dependency-free." });
    pushRecentTail(ctx, "filler", 13);

    await ctx.maybeCompact();
    const summary = latestCompactionSummary(ctx);
    const block = decisionsBlock(summary);

    assert.doesNotMatch(
      block,
      /Postgres/i,
      `choice instead-of with unrelated keep wording must evict superseded decisions; persisted=${persistOldDecision}`,
    );
  }
});

test("use-based instead wording drops superseded decisions", async () => {
  // Keep explicit replacement wording active after narrowing plain instead:
  // choosing a different tool/approach "instead" is still an override.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  ctx.push({ role: "user", content: "Use SQLite instead." });
  pushRecentTail(ctx, "filler", 13);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.doesNotMatch(block, /Postgres/i, "use-based instead wording must evict superseded decisions");
});

test("rather preserve-current wording does not drop decisions", async () => {
  // Regression for the P2 finding: plain /\brather\b/i matched preference
  // reaffirmations ("I'd rather keep Postgres"), clearing retained rationale
  // even though the user preserved the current choice.
  for (const preserveMessage of [
    "I'd rather keep Postgres.",
    "On second thought, keep Postgres.",
    "On second thought, keep the current decision.",
  ]) {
    const ctx = new Context({ budget: 1 });
    ctx.setSystem("system prompt");
    ctx.push({ role: "user", content: "the task" });
    ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
    ctx.push({ role: "user", content: preserveMessage });
    pushRecentTail(ctx, "filler", 13);

    await ctx.maybeCompact();
    const summary = latestCompactionSummary(ctx);
    const block = decisionsBlock(summary);

    assert.match(
      block,
      /I decided to use Postgres for persistence\./,
      `preserve-current wording must not evict decisions: ${preserveMessage}`,
    );
  }
});

test("rather replacement wording drops superseded decisions", async () => {
  // Keep explicit rather-based replacement wording active after narrowing plain
  // rather: "I'd rather use SQLite" is still an override.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  ctx.push({ role: "user", content: "I'd rather use SQLite." });
  pushRecentTail(ctx, "filler", 13);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.doesNotMatch(block, /Postgres/i, "rather replacement wording must evict superseded decisions");
});

test("\"use X rather than Y\" wording drops superseded decisions", async () => {
  // Regression for the P2 finding: "Use SQLite rather than Postgres." did not
  // fire any override cue because RATHER_REPLACEMENT_CUE only matches the
  // reversed "rather ... use" order. The rejected Postgres decision survived in
  // the handoff digest and could steer the agent back to the old choice.
  for (const overrideMessage of [
    "Use SQLite rather than Postgres.",
    "Prefer SQLite rather than Postgres.",
    "Switch to SQLite rather than Postgres.",
  ]) {
    const ctx = new Context({ budget: 1 });
    ctx.setSystem("system prompt");
    ctx.push({ role: "user", content: "the task" });
    ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
    ctx.push({ role: "user", content: overrideMessage });
    pushRecentTail(ctx, "filler", 13);

    await ctx.maybeCompact();
    const summary = latestCompactionSummary(ctx);
    const block = decisionsBlock(summary);

    assert.doesNotMatch(block, /Postgres/i, `"${overrideMessage}" must evict the superseded Postgres decision`);
  }
});

test("\"rather than\" replacement does not evict unrelated decisions", async () => {
  // The "rather than Y" cue is targeted: it must only evict decisions that
  // mention the rejected old target Y, not unrelated retained rationale.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  ctx.push({ role: "assistant", content: "I chose React for the frontend." });
  ctx.push({ role: "user", content: "Use SQLite rather than Postgres." });
  pushRecentTail(ctx, "filler", 13);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.doesNotMatch(block, /Postgres/i, "\"rather than Postgres\" must evict the Postgres decision");
  assert.match(block, /React/i, "unrelated React decision must survive a targeted rather-than override");
});

test("non-word technology names are matched in override targets", async () => {
  // Regression for the P2 finding: decisionMentionsTarget used \b...\b which
  // fails after non-word endpoints (C++, C#, F#, .NET). The rejected decision
  // survived a targeted "instead of"/"rather than" override and kept surfacing
  // in handoff digests, steering the agent back to the old choice.
  for (const overrideMessage of [
    "Use Rust instead of C++.",
    "Use Rust rather than C++.",
  ]) {
    const ctx = new Context({ budget: 1 });
    ctx.setSystem("system prompt");
    ctx.push({ role: "user", content: "the task" });
    ctx.push({ role: "assistant", content: "I decided to use C++ for the CLI." });
    ctx.push({ role: "user", content: overrideMessage });
    pushRecentTail(ctx, "filler", 13);

    await ctx.maybeCompact();
    const summary = latestCompactionSummary(ctx);
    const block = decisionsBlock(summary);

    assert.doesNotMatch(block, /C\+\+/i, `non-word target must be evicted: ${overrideMessage}`);
  }
});

test("neutral rework wording does not drop decisions", async () => {
  // Guard sibling broad cues: discard/rework words must not clear decisions when
  // they refer to routine work rather than a prior decision or approach.
  for (const neutralMessage of [
    "Redo the failing test run.",
    "Scrap the temporary debug file.",
    "Revert the README heading to LazyGLM.",
    "Never mind, run the tests.",
    "On second thought, run the tests.",
  ]) {
    const ctx = new Context({ budget: 1 });
    ctx.setSystem("system prompt");
    ctx.push({ role: "user", content: "the task" });
    ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
    ctx.push({ role: "user", content: neutralMessage });
    pushRecentTail(ctx, "filler", 13);

    await ctx.maybeCompact();
    const summary = latestCompactionSummary(ctx);
    const block = decisionsBlock(summary);

    assert.match(
      block,
      /I decided to use Postgres for persistence\./,
      `neutral rework wording must not evict decisions: ${neutralMessage}`,
    );
  }
});

test("explicit rework decision wording drops superseded decisions", async () => {
  // Keep explicit decision/approach discard wording active after narrowing broad
  // rework verbs: discarding a prior decision is still an override.
  for (const overrideMessage of [
    "Never mind, use SQLite.",
    "On second thought, use SQLite.",
    "Scrap the current approach.",
    "Redo the prior decision.",
    "Revert the decision.",
  ]) {
    const ctx = new Context({ budget: 1 });
    ctx.setSystem("system prompt");
    ctx.push({ role: "user", content: "the task" });
    ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
    ctx.push({ role: "user", content: overrideMessage });
    pushRecentTail(ctx, "filler", 13);

    await ctx.maybeCompact();
    const summary = latestCompactionSummary(ctx);
    const block = decisionsBlock(summary);

    assert.doesNotMatch(block, /Postgres/i, `explicit rework decision wording must evict superseded decisions: ${overrideMessage}`);
  }
});

test("decision replacement wording drops superseded decisions", async () => {
  // Keep explicit decision-reversal wording active after narrowing plain replace
  // requests: replacing a prior decision is still an override.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  ctx.push({ role: "user", content: "Replace the prior decision with SQLite." });
  pushRecentTail(ctx, "filler", 13);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.doesNotMatch(block, /Postgres/i, "decision replacement wording must evict superseded decisions");
});

test("negated change-to wording does not drop decisions", async () => {
  // Regression for the P2 finding: /\bchange\b.*\bto\b/i matched "No change
  // to the Postgres decision", clearing persisted rationale even though the
  // user explicitly preserved the prior choice.
  const ctx = new Context({ budget: 1 });
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
  ctx.push({ role: "user", content: "No change to the Postgres decision; keep going." });
  pushRecentTail(ctx, "filler", 13);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.match(
    block,
    /I decided to use Postgres for persistence\./,
    "a negated change-to message must not evict decisions",
  );
});

test("negated replacement wording does not drop decisions", async () => {
  // Regression for the P2 finding: /\breplace\b/i and the `actually ... switch
  // to` replacement cue matched preserve-current wording such as "Don't replace
  // Postgres; keep it", clearing rationale the user explicitly kept.
  for (const preserveMessage of [
    "Don't replace Postgres; keep it.",
    "Don't replace Postgres; keep going.",
    "Actually, do not switch to SQLite; keep Postgres.",
    "Actually, do not use SQLite; keep Postgres.",
    "Do not use SQLite instead; keep Postgres.",
  ]) {
    const ctx = new Context({ budget: 1 });
    ctx.setSystem("system prompt");
    ctx.push({ role: "user", content: "the task" });
    ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
    ctx.push({ role: "user", content: preserveMessage });
    pushRecentTail(ctx, "filler", 13);

    await ctx.maybeCompact();
    const summary = latestCompactionSummary(ctx);
    const block = decisionsBlock(summary);

    assert.match(
      block,
      /I decided to use Postgres for persistence\./,
      `negated replacement preserve wording must not evict decisions: ${preserveMessage}`,
    );
  }
});

test("negated old-choice replacement drops superseded decisions", async () => {
  // Regression for the P2 finding: negating the active Postgres choice rejects
  // it, with or without a punctuation-separated replacement. It must evict both
  // freshly dropped decisions and decisions persisted from an earlier compaction.
  for (const overrideMessage of [
    "Do not use Postgres; use SQLite.",
    "Do not use Postgres; keep going.",
    "Do not use Postgres.",
    "Do not use Postgres but use SQLite.",
    "Do not use Postgres and keep going.",
    "Do not use Postgres but keep going.",
    "Do not use Postgres because it requires a server",
  ]) {
    for (const persistOldDecision of [false, true]) {
      const ctx = new Context({ budget: 1 });
      ctx.setSystem("system prompt");
      ctx.push({ role: "user", content: "the task" });
      if (persistOldDecision) {
        ctx.addDecision("I decided to use Postgres for persistence.");
      } else {
        ctx.push({ role: "assistant", content: "I decided to use Postgres for persistence." });
      }
      ctx.push({ role: "user", content: overrideMessage });
      pushRecentTail(ctx, "filler", 13);

      await ctx.maybeCompact();
      const summary = latestCompactionSummary(ctx);
      const block = decisionsBlock(summary);

      assert.doesNotMatch(
        block,
        /Postgres/i,
        `negated old-choice replacement must evict superseded decisions; persisted=${persistOldDecision}; message=${overrideMessage}`,
      );
    }
  }
});

test("negated old-choice replacement preserves already-negated decisions", async () => {
  // Reaffirming a negative constraint should not remove the prior negative
  // decision just because it mentions the same target.
  for (const persistOldDecision of [false, true]) {
    const ctx = new Context({ budget: 1 });
    ctx.setSystem("system prompt");
    ctx.push({ role: "user", content: "the task" });
    if (persistOldDecision) {
      ctx.addDecision("I decided not to use Postgres for persistence.");
    } else {
      ctx.push({ role: "assistant", content: "I decided not to use Postgres for persistence." });
    }
    ctx.push({ role: "user", content: "Do not use Postgres; use SQLite." });
    pushRecentTail(ctx, "filler", 13);

    await ctx.maybeCompact();
    const summary = latestCompactionSummary(ctx);
    const block = decisionsBlock(summary);

    assert.match(
      block,
      /I decided not to use Postgres for persistence\./,
      `an already-negated decision should survive a reaffirming negated replacement; persisted=${persistOldDecision}`,
    );
  }
});

test("targeted negated replacement preserves unrelated decisions", async () => {
  const ctx = new Context({ budget: 1 });
  ctx.addDecision("I decided to keep the parser dependency-free.");
  ctx.addDecision("I decided to use Postgres for persistence.");
  ctx.setSystem("system prompt");
  ctx.push({ role: "user", content: "the task" });
  ctx.push({ role: "user", content: "Do not use Postgres; use SQLite." });
  pushRecentTail(ctx, "filler", 13);

  await ctx.maybeCompact();
  const summary = latestCompactionSummary(ctx);
  const block = decisionsBlock(summary);

  assert.match(block, /I decided to keep the parser dependency-free\./, "unrelated decisions should survive a targeted negated replacement");
  assert.doesNotMatch(block, /Postgres/i, "the negated active choice should be evicted");
});

test("default context budget stays conservative for unknown models", async () => {
  // The bare Context() default applies when no catalog budget is resolved
  // (unknown/custom model). It must stay conservative so small-window models
  // (Ollama, OpenAI-compatible shims) still compact before provider rejection.
  const ctx = new Context();
  assert.equal(ctx.budget, 24_000);
  ctx.setSystem("sys");
  ctx.push({ role: "user", content: "task" });
  ctx.push({ role: "assistant", content: "A".repeat(60_000) }); // ~15K tokens, under budget.
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
