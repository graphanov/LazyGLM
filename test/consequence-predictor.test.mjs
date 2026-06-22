import { test } from "node:test";
import assert from "node:assert/strict";
import consequencePredictor from "../src/plugins/consequence-predictor.js";

function pre(toolName, toolInput) {
  return consequencePredictor.hooks.PreToolUse({
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "call_1",
  }, {});
}

test("ignores read-only tools without consequence prediction", async () => {
  const res = await pre("read_file", { path: "src/index.js" });
  assert.equal(res, undefined);
});

test("blocks write_file without consequence prediction", async () => {
  const res = await pre("write_file", { path: "src/a.js", content: "export const a = 1;\n" });
  assert.equal(res.decision, "block");
  assert.match(res.reason, /consequence_prediction/);
});

test("passes write_file with a meaningful consequence prediction", async () => {
  const res = await pre("write_file", {
    path: "src/a.js",
    content: "export const a = 1;\n",
    consequence_prediction:
      "Creates src/a.js with one exported constant; syntax or path mistakes would fail import-time checks, so the next step is running the unit tests.",
  });
  assert.equal(res, undefined);
});

test("blocks generic consequence predictions", async () => {
  const res = await pre("patch_file", {
    path: "src/a.js",
    old_string: "a",
    new_string: "b",
    consequence_prediction: "safe",
  });
  assert.equal(res.decision, "block");
  assert.match(res.reason, /too generic/i);
});

test("blocks high-impact shell commands without mitigation", async () => {
  const res = await pre("run_shell", {
    command: "rm -rf dist",
    consequence_prediction:
      "Deletes the dist directory and may remove generated build artifacts that later commands expect to exist.",
  });
  assert.equal(res.decision, "block");
  assert.match(res.reason, /High-impact shell commands/i);
});

test("passes high-impact shell commands with scoped mitigation", async () => {
  const res = await pre("run_shell", {
    command: "rm -rf dist",
    consequence_prediction:
      "Deletes only the generated dist directory before rebuilding; the scope is limited to disposable artifacts and npm test will verify the rebuild output.",
  });
  assert.equal(res, undefined);
});
