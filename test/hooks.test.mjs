import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookEngine } from "../dist/hooks/engine.js";
import { createDeadline } from "../dist/agent/deadline.js";

let cwd;
test.before(async () => { cwd = await mkdtemp(join(tmpdir(), "lazyglm-hooks-")); });
test.after(async () => { await rm(cwd, { recursive: true, force: true }); });

test("engine fires events to subscribed plugins and collects injects", async () => {
  const engine = new HookEngine({ cwd });
  engine.register({
    name: "p1",
    hooks: { SessionStart: async () => ({ inject: "hello from p1" }) },
  });
  engine.register({
    name: "p2",
    hooks: { SessionStart: async () => ({ inject: "hello from p2" }) },
  });
  const res = await engine.fire("SessionStart", {});
  assert.equal(res.injects.length, 2);
  assert.ok(res.injects.includes("hello from p1"));
  assert.ok(res.injects.includes("hello from p2"));
});

test("engine collects block decisions from PreToolUse", async () => {
  const engine = new HookEngine({ cwd });
  engine.register({
    name: "guard",
    hooks: { PreToolUse: async () => ({ decision: "block", reason: "not allowed" }) },
  });
  const res = await engine.fire("PreToolUse", { tool_name: "run_shell", tool_input: { command: "rm -rf /" } });
  assert.equal(res.blocks.length, 1);
  assert.match(res.blocks[0], /not allowed/);
});

test("plugins without a handler for an event are skipped", async () => {
  const engine = new HookEngine({ cwd });
  engine.register({ name: "a", hooks: { SessionStart: async () => ({ inject: "a" }) } });
  engine.register({ name: "b", hooks: { Stop: async () => ({}) } });
  const res = await engine.fire("SessionStart", {});
  assert.equal(res.injects.length, 1);
});

test("a throwing handler does not break the chain", async () => {
  const engine = new HookEngine({ cwd, log: () => {} });
  engine.register({ name: "boom", hooks: { SessionStart: async () => { throw new Error("nope"); } } });
  engine.register({ name: "ok", hooks: { SessionStart: async () => ({ inject: "survived" }) } });
  const res = await engine.fire("SessionStart", {});
  assert.equal(res.injects.length, 1);
  assert.equal(res.injects[0], "survived");
});

test("hook input has canonical shape", async () => {
  const engine = new HookEngine({ cwd });
  engine.setMeta({ model: "glm-4.7-flash" });
  let seen;
  engine.register({ name: "spy", hooks: { PostToolUse: async (input) => { seen = input; return undefined; } } });
  await engine.fire("PostToolUse", { tool_name: "write_file", tool_input: { path: "x" }, tool_response: "ok", tool_use_id: "c1" });
  assert.equal(seen.hook_event_name, "PostToolUse");
  assert.equal(seen.cwd, cwd);
  assert.equal(seen.model, "glm-4.7-flash");
  assert.equal(seen.tool_name, "write_file");
  assert.equal(typeof seen.session_id, "string");
});

test("engine passes AbortSignal to hooks and aborts a pending handler", async () => {
  const engine = new HookEngine({ cwd });
  const deadline = createDeadline(25, { message: "hook deadline" });
  let seenSignal;
  engine.register({
    name: "slow",
    hooks: {
      PreToolUse: async (_input, api) => {
        seenSignal = api.signal;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1000);
          timer.unref?.();
        });
      },
    },
  });
  try {
    await assert.rejects(
      engine.fire("PreToolUse", { tool_name: "read_file", tool_input: { path: "x" } }, { signal: deadline.signal }),
      /hook deadline/,
    );
    assert.equal(seenSignal?.aborted, true);
  } finally {
    deadline.cancel();
  }
});
