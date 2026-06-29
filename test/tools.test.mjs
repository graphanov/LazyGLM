import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_HANDLERS } from "../dist/agent/tools.js";
import { createDeadline, composeAbortSignals } from "../dist/agent/deadline.js";

let cwd;
test.before(async () => { cwd = await mkdtemp(join(tmpdir(), "lazyglm-tools-")); });
test.after(async () => { await rm(cwd, { recursive: true, force: true }); });

test("write_file creates a file with content", async () => {
  const res = await TOOL_HANDLERS.write_file({ path: "src/a.js", content: "export const x = 1;\n" }, { cwd });
  assert.match(res, /wrote src\/a\.js/);
  const txt = await readFile(join(cwd, "src", "a.js"), "utf8");
  assert.equal(txt, "export const x = 1;\n");
});

test("read_file returns numbered lines", async () => {
  const res = await TOOL_HANDLERS.read_file({ path: "src/a.js" }, { cwd });
  assert.match(res, /1\|export const x = 1;/);
});

test("patch_file replaces a unique string", async () => {
  const res = await TOOL_HANDLERS.patch_file({ path: "src/a.js", old_string: "x = 1", new_string: "x = 2" }, { cwd });
  assert.match(res, /patched/);
  const txt = await readFile(join(cwd, "src", "a.js"), "utf8");
  assert.equal(txt, "export const x = 2;\n");
});

test("patch_file errors on non-unique old_string", async () => {
  await TOOL_HANDLERS.write_file({ path: "dup.js", content: "a\na\n" }, { cwd });
  const res = await TOOL_HANDLERS.patch_file({ path: "dup.js", old_string: "a", new_string: "b" }, { cwd });
  assert.match(res, /not unique/i);
});

test("patch_file errors when old_string missing", async () => {
  const res = await TOOL_HANDLERS.patch_file({ path: "src/a.js", old_string: "ZZZ", new_string: "YYY" }, { cwd });
  assert.match(res, /not found/i);
});

test("list_dir lists entries, dirs first", async () => {
  const res = await TOOL_HANDLERS.list_dir({ path: "." }, { cwd });
  assert.match(res, /src\//);
  assert.match(res, /dup\.js/);
});

test("grep finds a pattern", async () => {
  await TOOL_HANDLERS.write_file({ path: "g.js", content: "function hello() { return 'hi'; }\n" }, { cwd });
  const res = await TOOL_HANDLERS.grep({ pattern: "hello", path: "." }, { cwd });
  assert.match(res, /g\.js:\d+:function hello/);
});

test("grep honors a pre-aborted runtime signal", async () => {
  const controller = new AbortController();
  controller.abort(new Error("grep canceled"));
  await assert.rejects(
    () => TOOL_HANDLERS.grep({ pattern: "hello", path: "." }, { cwd, runtime: { signal: controller.signal } }),
    /grep canceled/,
  );
});

test("run_shell runs a command and captures output", async () => {
  const res = await TOOL_HANDLERS.run_shell({ command: "echo hello-shell" }, { cwd });
  assert.match(res, /hello-shell/);
});

test("run_shell honors the runtime deadline", async () => {
  const deadline = createDeadline(30);
  try {
    await assert.rejects(
      () => TOOL_HANDLERS.run_shell({ command: "node -e \"setTimeout(() => {}, 1000)\"", timeout: 5 }, { cwd, runtime: { deadline } }),
      /timed out/,
    );
  } finally {
    deadline.cancel();
  }
});

test("run_shell honors composed runtime aborts before the deadline", async () => {
  const controller = new AbortController();
  const deadline = createDeadline(1000, { message: "deadline fired" });
  const composed = composeAbortSignals([deadline.signal, controller.signal]);
  const abortTimer = setTimeout(() => controller.abort(new Error("caller canceled")), 25);
  const started = Date.now();
  try {
    await assert.rejects(
      () => TOOL_HANDLERS.run_shell({ command: "node -e \"setTimeout(() => {}, 1000)\"", timeout: 5 }, { cwd, runtime: { deadline, signal: composed.signal } }),
      /caller canceled/,
    );
    assert.ok(Date.now() - started < 500, "caller abort should stop shell command before the deadline");
  } finally {
    clearTimeout(abortTimer);
    composed.cancel();
    deadline.cancel();
  }
});

test("read_file refuses path escapes", async () => {
  await assert.rejects(() => TOOL_HANDLERS.read_file({ path: "../../etc/passwd" }, { cwd }));
});

test("finish returns a finish marker", async () => {
  const res = await TOOL_HANDLERS.finish({ summary: "done" }, { cwd });
  assert.equal(res.__finish, true);
  assert.equal(res.summary, "done");
});
