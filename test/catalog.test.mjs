import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "../src/util.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("model catalog targets GLM, not Codex models", async () => {
  const catalog = await readJson(join(ROOT, "config", "model-catalog.json"));
  assert.ok(catalog.current.model.startsWith("glm"), `current model should be GLM, got ${catalog.current.model}`);
  for (const [name, entry] of Object.entries(catalog.models)) {
    assert.ok(name.startsWith("glm"), `model '${name}' should be a GLM model`);
  }
  const blob = JSON.stringify(catalog);
  assert.ok(!/gpt-5|codex/i.test(blob), "catalog must not reference gpt-5/codex models");
});

test("model catalog defaults to the z.ai API + glm-5.2 (frontier)", async () => {
  const catalog = await readJson(join(ROOT, "config", "model-catalog.json"));
  assert.equal(catalog.default_provider, "zai");
  assert.equal(catalog.current.model, "glm-5.2");
  assert.equal(catalog.current.provider, "zai");
  assert.equal(catalog.providers.zai.base_url, "https://api.z.ai/api/coding/paas/v4");
  assert.ok(catalog.providers.zai.requires_key, "zai provider must require a key");
  // nous remains available as an alternative backend
  assert.equal(catalog.providers.nous.base_url, "https://inference-api.nousresearch.com/v1");
  assert.ok(catalog.providers.nous.requires_key, "nous provider must require a key");
});

test("model catalog has the standard routing roles", async () => {
  const catalog = await readJson(join(ROOT, "config", "model-catalog.json"));
  for (const role of ["default", "worker", "quick", "planner", "verifier", "ultrabrain"]) {
    assert.ok(catalog.roles[role], `missing role: ${role}`);
    assert.ok(catalog.roles[role].model, `${role} role must specify a model`);
  }
});

test("every role maps to a model defined in the catalog", async () => {
  const catalog = await readJson(join(ROOT, "config", "model-catalog.json"));
  for (const [role, entry] of Object.entries(catalog.roles)) {
    assert.ok(catalog.models[entry.model], `role '${role}' -> '${entry.model}' but model not in catalog.models`);
  }
});

test("ultrabrain role uses glm-5.2, quick role uses a lower-tier model", async () => {
  const catalog = await readJson(join(ROOT, "config", "model-catalog.json"));
  assert.equal(catalog.roles.ultrabrain.model, "glm-5.2");
  assert.notEqual(catalog.roles.quick.model, "glm-5.2", "quick role should use a cheaper model than glm-5.2");
});

test("model aliases map to provider-specific IDs", async () => {
  const catalog = await readJson(join(ROOT, "config", "model-catalog.json"));
  assert.equal(catalog.models["glm-5.2"].aliases.nous, "z-ai/glm-5.2");
  assert.equal(catalog.models["glm-5.2"].aliases.ollama, "glm-5.2");
});

test("package.json is the lazyglm package with no lazycodex branding", async () => {
  const pkg = await readJson(join(ROOT, "package.json"));
  assert.equal(pkg.name, "lazyglm");
  assert.equal(pkg.bin.lazyglm, "bin/lazyglm.js");
  const blob = JSON.stringify(pkg);
  assert.ok(!/lazycodex/i.test(blob), "package.json must not reference lazycodex");
});
