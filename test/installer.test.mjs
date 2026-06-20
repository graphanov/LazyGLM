import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install, uninstall } from "../src/installer.js";

let cwd;
test.before(async () => { cwd = await mkdtemp(join(tmpdir(), "lazyglm-install-")); });
test.after(async () => { await rm(cwd, { recursive: true, force: true }); });

test("install creates .lazyglm dirs + config + AGENTS.md", async () => {
  const res = await install({ cwd });
  assert.ok(existsSync(join(cwd, ".lazyglm")));
  assert.ok(existsSync(join(cwd, ".lazyglm", "rules")));
  assert.ok(existsSync(join(cwd, ".lazyglm", "plans")));
  assert.ok(existsSync(join(cwd, ".lazyglm", "sessions")));
  assert.ok(existsSync(join(cwd, ".lazyglm", "config.json")));
  assert.ok(existsSync(join(cwd, "AGENTS.md")));
  assert.ok(res.created.includes("AGENTS.md"));
});

test("install is idempotent (does not overwrite without force)", async () => {
  await install({ cwd });
  const res2 = await install({ cwd });
  // AGENTS.md already exists -> not in created list second time
  const ag = res2.created.filter((c) => c.startsWith("AGENTS.md"));
  assert.equal(ag.length, 0);
});

test("install --force overwrites AGENTS.md", async () => {
  const res = await install({ cwd, force: true });
  assert.ok(res.created.some((c) => c.startsWith("AGENTS.md")));
});

test("uninstall removes .lazyglm", async () => {
  await uninstall({ cwd });
  assert.ok(!existsSync(join(cwd, ".lazyglm")));
});
