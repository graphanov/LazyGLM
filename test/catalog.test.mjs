import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "../src/util.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("model catalog targets GLM, not Codex models", async () => {
  const catalog = await readJson(join(ROOT, "config", "model-catalog.json"));
  assert.ok(catalog.current.model.startsWith("glm"), `current model should be GLM, got ${catalog.current.model}`);
  for (const [role, cfg] of Object.entries(catalog.roles)) {
    assert.ok(cfg.model.startsWith("glm"), `role '${role}' should use a GLM model, got ${cfg.model}`);
  }
  // no codex/gpt leakage
  const blob = JSON.stringify(catalog);
  assert.ok(!/gpt-5|codex/i.test(blob), "catalog must not reference gpt-5/codex models");
});

test("model catalog has the standard roles", async () => {
  const catalog = await readJson(join(ROOT, "config", "model-catalog.json"));
  for (const role of ["default", "worker", "quick", "planner", "verifier", "ultrabrain"]) {
    assert.ok(catalog.roles[role], `missing role: ${role}`);
  }
});

test("roles.json defines sub-agent roles", async () => {
  const roles = await readJson(join(ROOT, "config", "roles.json"));
  for (const name of ["explorer", "librarian", "planner", "verifier"]) {
    assert.ok(roles[name], `missing sub-agent role: ${name}`);
    assert.ok(roles[name].model_role, `${name} missing model_role`);
  }
});

test("package.json is the lazyglm package", async () => {
  const pkg = await readJson(join(ROOT, "package.json"));
  assert.equal(pkg.name, "lazyglm");
  assert.equal(pkg.bin.lazyglm, "bin/lazyglm.js");
});

test("no codex/lazycodex branding leaks into the lazyglm package", async () => {
  const pkg = await readJson(join(ROOT, "package.json"));
  const blob = JSON.stringify(pkg);
  assert.ok(!/lazycodex/i.test(blob), "package.json must not reference lazycodex");
});
