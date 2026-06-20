import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import commentChecker from "../src/plugins/comment-checker.js";

let cwd;
test.before(async () => { cwd = await mkdtemp(join(tmpdir(), "lazyglm-cc-")); });
test.after(async () => { await rm(cwd, { recursive: true, force: true }); });

async function runChecker(rel, content) {
  await writeFile(join(cwd, rel), content, "utf8");
  const input = {
    tool_name: "write_file",
    tool_input: { path: rel },
    tool_response: "wrote",
    tool_use_id: "c1",
  };
  return commentChecker.hooks.PostToolUse(input, { cwd });
}

test("blocks a placeholder TODO comment", async () => {
  const res = await runChecker("a.js", "// TODO: implement this\nfunction f() {}\n");
  assert.equal(res.decision, "block");
  assert.match(res.reason, /placeholder/i);
});

test("blocks 'let's' AI narration", async () => {
  const res = await runChecker("b.js", "// let's now create a function\nfunction f() {}\n");
  assert.equal(res.decision, "block");
});

test("blocks a restate-the-code comment", async () => {
  const res = await runChecker("c.js", "// set the username to bob\nconst username = 'bob';\n");
  assert.equal(res.decision, "block");
  assert.match(res.reason, /restate|redundant/i);
});

test("passes clean code with a real intent comment", async () => {
  const res = await runChecker("d.js", "// GLM requires the context length set before generation\nconst ctx = 131072;\nctxLength = ctx;\n");
  // no slop patterns hit; restate check requires >=3 overlapping content words
  assert.equal(res, undefined);
});

test("ignores non-code files", async () => {
  await writeFile(join(cwd, "readme.txt"), "// TODO: implement\n", "utf8");
  const res = await commentChecker.hooks.PostToolUse(
    { tool_name: "write_file", tool_input: { path: "readme.txt" }, tool_response: "w", tool_use_id: "c" },
    { cwd },
  );
  assert.equal(res, undefined);
});
