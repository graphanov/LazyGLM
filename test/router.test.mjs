import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickModel, detectRole, resolveModelId } from "../src/agent/router.js";
import { resolveProviderConfig } from "../src/agent/provider.js";
import { resetConfigCache } from "../src/config.js";

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("pickModel resolves ultrabrain role to glm-5.2 via nous", async () => {
  const m = await pickModel("ultrabrain", { provider: "nous" });
  assert.equal(m.model, "glm-5.2");
  assert.equal(m.provider, "nous");
  assert.equal(m.modelId, "z-ai/glm-5.2");
  assert.equal(m.role, "ultrabrain");
});

test("pickModel resolves quick role to a lower-tier model", async () => {
  const m = await pickModel("quick", { provider: "nous" });
  assert.notEqual(m.model, "glm-5.2", "quick role should not use the high-end model");
  assert.equal(m.provider, "nous");
  // nous uses the z-ai/ prefix
  assert.ok(m.modelId.startsWith("z-ai/"), `nous modelId should be z-ai/-prefixed, got ${m.modelId}`);
});

test("pickModel with provider=ollama resolves to bare model IDs (no z-ai/ prefix)", async () => {
  const m = await pickModel("default", { provider: "ollama" });
  assert.equal(m.provider, "ollama");
  assert.equal(m.modelId, "glm-5.2"); // ollama alias has no prefix
  assert.ok(!m.modelId.includes("/"), `ollama modelId should have no slash, got ${m.modelId}`);
});

test("pickModel honors explicit --model override", async () => {
  const m = await pickModel("default", { model: "glm-4.7", provider: "nous" });
  assert.equal(m.model, "glm-4.7");
  assert.equal(m.modelId, "z-ai/glm-4.7");
});

test("detectRole picks ultrabrain for ultrawork tasks", () => {
  assert.equal(detectRole("build a game $ulw-loop --ultrawork"), "ultrabrain");
});

test("detectRole picks planner for plan/architecture tasks", () => {
  assert.equal(detectRole("$ulw-plan refactor the auth module"), "planner");
  assert.equal(detectRole("design the system architecture"), "planner");
});

test("detectRole picks verifier for review/test tasks", () => {
  assert.equal(detectRole("verify the build passes"), "verifier");
  assert.equal(detectRole("review this code"), "verifier");
});

test("detectRole picks quick for short lookup tasks", () => {
  assert.equal(detectRole("list files in src"), "quick");
  assert.equal(detectRole("find the config"), "quick");
});

test("detectRole defaults to 'default' for general coding", () => {
  assert.equal(detectRole("add a health check endpoint with tests"), "default");
});

test("detectRole honors explicit role override", () => {
  assert.equal(detectRole("anything", { role: "verifier" }), "verifier");
});

test("resolveModelId falls back to bare name for unknown providers", () => {
  const catalog = { models: { "glm-5.2": { aliases: { nous: "z-ai/glm-5.2" } } } };
  assert.equal(resolveModelId("glm-5.2", "custom", catalog), "glm-5.2");
});

test("resolveProviderConfig rejects an unknown explicit provider before fetch", async () => {
  const savedProvider = process.env.LAZYGLM_PROVIDER;
  const savedBase = process.env.LAZYGLM_BASE_URL;
  const savedKey = process.env.LAZYGLM_API_KEY;
  try {
    delete process.env.LAZYGLM_PROVIDER;
    delete process.env.LAZYGLM_BASE_URL;
    delete process.env.LAZYGLM_API_KEY;
    await assert.rejects(
      () => resolveProviderConfig({ provider: "Help", role: "default" }),
      /Unknown GLM provider 'help'/,
    );
  } finally {
    restoreEnv("LAZYGLM_PROVIDER", savedProvider);
    restoreEnv("LAZYGLM_BASE_URL", savedBase);
    restoreEnv("LAZYGLM_API_KEY", savedKey);
  }
});

test("resolveProviderConfig accepts a keyless custom base URL", async () => {
  const savedProvider = process.env.LAZYGLM_PROVIDER;
  const savedBase = process.env.LAZYGLM_BASE_URL;
  const savedKey = process.env.LAZYGLM_API_KEY;
  const savedHome = process.env.LAZYGLM_HOME;
  const home = await mkdtemp(join(tmpdir(), "lazyglm-router-"));
  try {
    process.env.LAZYGLM_HOME = home;
    resetConfigCache();
    delete process.env.LAZYGLM_PROVIDER;
    delete process.env.LAZYGLM_API_KEY;
    process.env.LAZYGLM_BASE_URL = "http://localhost:1234/v1/";
    const cfg = await resolveProviderConfig({ role: "default" });
    assert.equal(cfg.provider, "custom");
    assert.equal(cfg.baseURL, "http://localhost:1234/v1");
    assert.equal(cfg.apiKey, "ollama");
  } finally {
    restoreEnv("LAZYGLM_PROVIDER", savedProvider);
    restoreEnv("LAZYGLM_BASE_URL", savedBase);
    restoreEnv("LAZYGLM_API_KEY", savedKey);
    restoreEnv("LAZYGLM_HOME", savedHome);
    resetConfigCache();
    await rm(home, { recursive: true, force: true });
  }
});
