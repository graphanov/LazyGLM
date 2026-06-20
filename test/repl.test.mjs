// Unit tests for the v0.1.1 self-sustained layer: global user config,
// onboarding, and session persistence. No GLM API calls — all local state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserConfig, saveUserConfig, isOnboarded, resetConfigCache } from "../src/config.js";
import { needsOnboarding, runOnboarding } from "../src/onboard.js";
import { createSession, appendEvent, listSessions, loadSessionEvents } from "../src/sessions.js";

const homes = [];
async function freshHome() {
  const h = await mkdtemp(join(tmpdir(), "lazyglm-th-"));
  homes.push(h);
  process.env.LAZYGLM_HOME = h;
  resetConfigCache();
  return h;
}
function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test.after(async () => {
  await Promise.all(homes.map((h) => rm(h, { recursive: true, force: true })));
});

// --- config.js ---

test("loadUserConfig returns {} when no config exists", async () => {
  await freshHome();
  assert.deepEqual(await loadUserConfig(), {});
});

test("saveUserConfig writes JSON with chmod 600 and updates the cache", async () => {
  await freshHome();
  await saveUserConfig({ onboarded: true, provider: "zai", api_key: "k", model: "glm-5.2" });
  const path = join(process.env.LAZYGLM_HOME, "config.json");
  assert.ok(existsSync(path));
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600, `config should be chmod 600, got ${mode.toString(8)}`);
  const cfg = await loadUserConfig({ force: true });
  assert.equal(cfg.provider, "zai");
  assert.equal(cfg.api_key, "k");
});

test("isOnboarded: true for valid providers only", () => {
  assert.ok(isOnboarded({ onboarded: true, provider: "zai", api_key: "k" }));
  assert.ok(isOnboarded({ onboarded: true, provider: "Z.AI", api_key: "k" }));
  assert.ok(!isOnboarded({ onboarded: true, provider: "zai" }));
  assert.ok(!isOnboarded({ provider: "zai", api_key: "k" })); // not flagged onboarded
  assert.ok(isOnboarded({ onboarded: true, provider: "ollama" }));
  assert.ok(!isOnboarded({ onboarded: true, provider: "Help", api_key: "k" }), "unknown providers must not count as onboarded");
});

// --- onboard.js ---

test("needsOnboarding: true with no key+config; false with env key or ollama env", async () => {
  await freshHome();
  const savedKey = process.env.LAZYGLM_API_KEY;
  const savedProvider = process.env.LAZYGLM_PROVIDER;
  try {
    delete process.env.LAZYGLM_API_KEY;
    delete process.env.LAZYGLM_PROVIDER;
    assert.ok(await needsOnboarding(), "fresh machine needs onboarding");
    process.env.LAZYGLM_API_KEY = "env-key";
    assert.ok(!(await needsOnboarding()), "env key satisfies onboarding");
    delete process.env.LAZYGLM_API_KEY;
    process.env.LAZYGLM_PROVIDER = " Ollama ";
    assert.ok(!(await needsOnboarding()), "ollama env is keyless and should be normalized");
  } finally {
    if (savedKey === undefined) delete process.env.LAZYGLM_API_KEY;
    else process.env.LAZYGLM_API_KEY = savedKey;
    if (savedProvider === undefined) delete process.env.LAZYGLM_PROVIDER;
    else process.env.LAZYGLM_PROVIDER = savedProvider;
  }
});

test("needsOnboarding repairs an invalid persisted provider", async () => {
  await freshHome();
  const savedKey = process.env.LAZYGLM_API_KEY;
  const savedProvider = process.env.LAZYGLM_PROVIDER;
  try {
    delete process.env.LAZYGLM_API_KEY;
    delete process.env.LAZYGLM_PROVIDER;
    await saveUserConfig({ onboarded: true, provider: "Help", api_key: "k", model: "glm-5.2" });
    assert.ok(await needsOnboarding(), "invalid provider config should re-run onboarding instead of reaching fetch");
  } finally {
    restoreEnv("LAZYGLM_API_KEY", savedKey);
    restoreEnv("LAZYGLM_PROVIDER", savedProvider);
  }
});

test("needsOnboarding honors a valid provider env override with a saved key", async () => {
  await freshHome();
  const savedKey = process.env.LAZYGLM_API_KEY;
  const savedProvider = process.env.LAZYGLM_PROVIDER;
  try {
    delete process.env.LAZYGLM_API_KEY;
    process.env.LAZYGLM_PROVIDER = " z.ai ";
    await saveUserConfig({ onboarded: true, provider: "Help", api_key: "k", model: "glm-5.2" });
    assert.ok(!(await needsOnboarding()), "valid env provider plus saved key should override a stale persisted provider");
  } finally {
    restoreEnv("LAZYGLM_API_KEY", savedKey);
    restoreEnv("LAZYGLM_PROVIDER", savedProvider);
  }
});

test("runOnboarding writes config from queue inputs (zai)", async () => {
  await freshHome();
  const lines = ["zai", "my-key", "glm-5.2"];
  let i = 0;
  const queue = { next: () => Promise.resolve(lines[i++]) };
  const cfg = await runOnboarding({ queue, output: { write: () => {} } });
  assert.equal(cfg.provider, "zai");
  assert.equal(cfg.api_key, "my-key");
  assert.equal(cfg.model, "glm-5.2");
  const loaded = await loadUserConfig({ force: true });
  assert.equal(loaded.api_key, "my-key");
  assert.equal(loaded.onboarded, true);
  assert.ok(isOnboarded(loaded));
});

test("runOnboarding with ollama needs no key", async () => {
  await freshHome();
  const lines = ["ollama", "glm-4.7"];
  let i = 0;
  const queue = { next: () => Promise.resolve(lines[i++]) };
  const cfg = await runOnboarding({ queue, output: { write: () => {} } });
  assert.equal(cfg.provider, "ollama");
  assert.ok(!cfg.api_key);
  assert.ok(isOnboarded(cfg));
});

test("runOnboarding rejects help/invalid provider answers and saves the next valid provider", async () => {
  await freshHome();
  const writes = [];
  const lines = ["Help", "bogus", "z.ai", "my-key", "glm-5.2"];
  let i = 0;
  const queue = { next: () => Promise.resolve(lines[i++]) };
  const cfg = await runOnboarding({ queue, output: { write: (s) => writes.push(s) } });
  assert.equal(cfg.provider, "zai");
  assert.equal(cfg.api_key, "my-key");
  assert.match(writes.join(""), /Supported providers/);
  assert.match(writes.join(""), /Unknown provider 'bogus'/);
});

test("runOnboarding throws when no key provided for zai", async () => {
  await freshHome();
  const lines = ["zai", ""];
  let i = 0;
  const queue = { next: () => Promise.resolve(lines[i++]) };
  await assert.rejects(() => runOnboarding({ queue, output: { write: () => {} } }), /no API key/);
});

// --- sessions.js ---

test("createSession writes a header; appendEvent + loadSessionEvents round-trip", async () => {
  await freshHome();
  const s = await createSession({ model: "glm-5.2", provider: "zai", firstPrompt: "hi" });
  assert.ok(s.id.startsWith("sess_"));
  assert.ok(existsSync(s.path));
  await appendEvent(s, { type: "user", content: "hi" });
  await appendEvent(s, { type: "assistant", content: "hello", tool_calls: null });
  const events = await loadSessionEvents(s.id);
  assert.ok(events.length >= 3);
  assert.equal(events[0].type, "session");
  assert.equal(events[0].firstPrompt, "hi");
  assert.equal(events[1].type, "user");
  assert.equal(events[1].content, "hi");
});

test("listSessions returns sessions most-recent first", async () => {
  await freshHome();
  const a = await createSession({ model: "glm-5.2", provider: "zai" });
  await new Promise((r) => setTimeout(r, 40));
  const b = await createSession({ model: "glm-5.2", provider: "zai" });
  const list = await listSessions();
  assert.ok(list.length >= 2);
  assert.equal(list[0].id, b.id, "most recent session should be first");
});

test("loadSessionEvents returns null for an unknown id", async () => {
  await freshHome();
  assert.equal(await loadSessionEvents("does-not-exist"), null);
});
