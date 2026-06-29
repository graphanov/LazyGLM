import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGlmNativeBlock,
  buildReplPrompt,
  buildRuntimePrompt,
  modelTierGuidance,
} from "../dist/prompt.js";

const git = { isRepo: true, branch: "main", root: "/tmp/demo" };
const modelInfo = {
  model: "glm-5.2",
  tier: "high-end",
  contextWindow: 1000000,
  description: "High-end GLM coding model. Use for hard reasoning, architecture, complex debugging.",
};

test("GLM-native block names the active model, tier, context, reasoning_content, and z.ai tool loop", () => {
  const block = buildGlmNativeBlock(modelInfo);
  assert.match(block, /^GLM-NATIVE OPERATING CONTRACT/);
  assert.match(block, /glm-5\.2 \(high-end\)/);
  assert.match(block, /1,000,000 tokens/);
  assert.match(block, /reasoning_content/);
  assert.match(block, /z\.ai Coding Plan tool-loop/);
});

test("runtime prompt prepends the GLM-native block and preserves working rules", () => {
  const prompt = buildRuntimePrompt({
    cwd: "/tmp/demo",
    git,
    ...modelInfo,
    injects: ["repo rule"],
    extra: "EXTRA_RUNTIME_RULE",
  });
  assert.ok(prompt.startsWith("GLM-NATIVE OPERATING CONTRACT"));
  assert.ok(prompt.indexOf("GLM-NATIVE OPERATING CONTRACT") < prompt.indexOf("WORKING RULES"));
  assert.match(prompt, /You have these tools: read_file, write_file, patch_file, list_dir, grep, run_shell, finish\./);
  assert.match(prompt, /PROJECT CONTEXT \(injected by hooks\)\nrepo rule/);
  assert.match(prompt, /EXTRA_RUNTIME_RULE/);
});

test("REPL prompt prepends GLM-native behavior and preserves LazyGLM terminal persona", () => {
  const prompt = buildReplPrompt({
    cwd: "/tmp/demo",
    git,
    ...modelInfo,
    injects: ["AGENTS.md rule"],
  });
  assert.ok(prompt.startsWith("GLM-NATIVE OPERATING CONTRACT"));
  assert.ok(prompt.indexOf("GLM-NATIVE OPERATING CONTRACT") < prompt.indexOf("PERSONALITY:"));
  assert.match(prompt, /terminal-based AI coding agent/);
  assert.match(prompt, /PROJECT CONTEXT \(injected by hooks\)\nAGENTS\.md rule/);
});

test("tier guidance is derived from catalog tier plus catalog description", () => {
  const guidance = modelTierGuidance({
    tier: "fast",
    description: "Fast, efficient GLM for quick edits, listings, sub-agents. Lowest cost/latency.",
  });
  assert.match(guidance, /quick edits/);
  assert.match(guidance, /Catalog note: Fast, efficient GLM/);
});

test("unknown catalog entries degrade without inventing model guidance", () => {
  assert.equal(modelTierGuidance({}), "");
  assert.equal(modelTierGuidance({ description: "Custom GLM-compatible endpoint." }), "Custom GLM-compatible endpoint.");
  const block = buildGlmNativeBlock({ model: "custom-glm" });
  assert.match(block, /custom-glm/);
  assert.match(block, /catalog entry unavailable/);
});
