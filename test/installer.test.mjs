import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install, uninstall } from "../dist/installer.js";

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

// --- uninstall cleanup of install-created artifacts (issue #35) ---
// Each of these runs in its own isolated temp dir so install/uninstall
// ordering is not coupled across tests.

test("uninstall on pristine install removes AGENTS.md, .gitignore entry, reports accurately", async () => {
  const d = await mkdtemp(join(tmpdir(), "lazyglm-uninstall-pristine-"));
  try {
    await install({ cwd: d });
    // sanity: install created both artifacts
    assert.ok(existsSync(join(d, "AGENTS.md")));
    assert.ok(existsSync(join(d, ".gitignore")));

    const res = await uninstall({ cwd: d });

    // .lazyglm gone
    assert.ok(!existsSync(join(d, ".lazyglm")), ".lazyglm should be removed");
    // AGENTS.md gone (pristine template -> deleted)
    assert.ok(!existsSync(join(d, "AGENTS.md")), "pristine AGENTS.md should be removed");
    // .gitignore: install created it with only `.lazyglm/`, so after removal
    // it is empty and unlinked -> absent.
    assert.ok(!existsSync(join(d, ".gitignore")), "empty .gitignore should be removed");

    // metadata accuracy
    assert.ok(res.removed.includes(".lazyglm/"), "removed should list .lazyglm/");
    assert.ok(res.removed.includes("AGENTS.md"), "removed should list AGENTS.md");
    assert.ok(res.removed.includes(".gitignore (-.lazyglm/)"), "removed should list .gitignore edit");
    assert.deepEqual(res.preserved, [], "preserved should be empty on pristine install");
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("uninstall preserves pre-existing empty .gitignore file", async () => {
  const d = await mkdtemp(join(tmpdir(), "lazyglm-preexisting-empty-gitignore-"));
  try {
    await writeFile(join(d, ".gitignore"), "", "utf8");
    await install({ cwd: d });
    const cfg = JSON.parse(await readFile(join(d, ".lazyglm", "config.json"), "utf8"));
    assert.equal(cfg.gitignoreOwnedByLazyglm, true, "lazyglm owns the entry it added");
    assert.equal(cfg.gitignoreFileOwnedByLazyglm, false, "lazyglm must not claim a pre-existing empty .gitignore file");

    const res = await uninstall({ cwd: d });
    assert.ok(existsSync(join(d, ".gitignore")), "pre-existing empty .gitignore should survive");
    const gi = await readFile(join(d, ".gitignore"), "utf8");
    assert.equal(gi.trim(), "", "only the lazyglm entry should be removed from the placeholder file");
    assert.ok(res.removed.includes(".gitignore (-.lazyglm/)"), "removed should list the owned gitignore entry edit");
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("uninstall preserves customized AGENTS.md and reports it", async () => {
  const d = await mkdtemp(join(tmpdir(), "lazyglm-uninstall-custom-"));
  try {
    await install({ cwd: d });
    // user customizes AGENTS.md after install
    await writeFile(join(d, "AGENTS.md"), "# My custom agents file\n", "utf8");

    const res = await uninstall({ cwd: d });

    assert.ok(!existsSync(join(d, ".lazyglm")), ".lazyglm removed");
    assert.ok(existsSync(join(d, "AGENTS.md")), "customized AGENTS.md should be preserved");
    assert.ok(res.preserved.includes("AGENTS.md"), "preserved should list AGENTS.md");
    assert.ok(!res.removed.includes("AGENTS.md"), "removed should NOT list customized AGENTS.md");
    // .gitignore entry is still runtime state and removed regardless
    assert.ok(res.removed.includes(".gitignore (-.lazyglm/)"), ".gitignore edit still removed");
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("uninstall preserves pre-existing template AGENTS.md and reports it", async () => {
  const seed = await mkdtemp(join(tmpdir(), "lazyglm-agents-template-seed-"));
  const d = await mkdtemp(join(tmpdir(), "lazyglm-preexisting-agents-template-"));
  try {
    await install({ cwd: seed });
    const template = await readFile(join(seed, "AGENTS.md"), "utf8");
    await writeFile(join(d, "AGENTS.md"), template, "utf8");

    const installRes = await install({ cwd: d });
    assert.ok(!installRes.created.includes("AGENTS.md"), "install must not claim a pre-existing AGENTS.md");
    const cfg = JSON.parse(await readFile(join(d, ".lazyglm", "config.json"), "utf8"));
    assert.equal(cfg.agentsOwnedByLazyglm, false, "config must mark pre-existing AGENTS.md as not owned");

    const res = await uninstall({ cwd: d });
    assert.ok(existsSync(join(d, "AGENTS.md")), "pre-existing template AGENTS.md should be preserved");
    assert.ok(res.preserved.includes("AGENTS.md"), "preserved should list user-owned AGENTS.md");
    assert.ok(!res.removed.includes("AGENTS.md"), "removed should NOT list user-owned AGENTS.md");
  } finally {
    await rm(seed, { recursive: true, force: true });
    await rm(d, { recursive: true, force: true });
  }
});

test("uninstall removes only the .lazyglm/ gitignore line, preserves other entries", async () => {
  const d = await mkdtemp(join(tmpdir(), "lazyglm-uninstall-gitignore-"));
  try {
    await install({ cwd: d });
    // simulate a pre-existing .gitignore with other entries by rewriting it
    // to contain user lines + the lazyglm entry
    await writeFile(join(d, ".gitignore"), "node_modules/\n.lazyglm/\ndist/\n*.log\n", "utf8");

    const res = await uninstall({ cwd: d });

    assert.ok(existsSync(join(d, ".gitignore")), ".gitignore should survive with other entries");
    const gi = await readFile(join(d, ".gitignore"), "utf8");
    const lines = gi.split("\n");
    assert.ok(!lines.includes(".lazyglm/"), ".lazyglm/ line must be removed");
    assert.ok(lines.includes("node_modules/"), "node_modules/ must survive");
    assert.ok(lines.includes("dist/"), "dist/ must survive");
    assert.ok(lines.includes("*.log"), "*.log must survive");
    assert.ok(res.removed.includes(".gitignore (-.lazyglm/)"), "removed lists the gitignore edit");
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

// --- Codex P2 review thread on PR #36: preserve pre-existing .gitignore ignores ---
// If a project already had `.lazyglm/` in .gitignore before install ran, install
// must not treat that entry as its own; uninstall must leave it in place so
// install/uninstall is a safe round trip for user-owned ignore configuration.

test("install does not claim ownership of pre-existing .lazyglm/ gitignore entry", async () => {
  const d = await mkdtemp(join(tmpdir(), "lazyglm-preexist-gitignore-"));
  try {
    // project already ignored .lazyglm/ before lazyglm was installed
    await writeFile(join(d, ".gitignore"), "node_modules/\n.lazyglm/\n", "utf8");
    const res = await install({ cwd: d });
    // install should not report adding the entry
    assert.ok(
      !res.created.some((c) => c.includes(".gitignore")),
      "install must not report adding a pre-existing gitignore entry",
    );
    // config must record that lazyglm does NOT own the entry
    const cfg = JSON.parse(await readFile(join(d, ".lazyglm", "config.json"), "utf8"));
    assert.equal(cfg.gitignoreOwnedByLazyglm, false, "config must mark entry as not owned");
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("repeat install keeps ownership of lazyglm-created .gitignore entry", async () => {
  const d = await mkdtemp(join(tmpdir(), "lazyglm-repeat-install-gitignore-"));
  try {
    await install({ cwd: d });
    await install({ cwd: d });
    const cfg = JSON.parse(await readFile(join(d, ".lazyglm", "config.json"), "utf8"));
    assert.equal(cfg.gitignoreOwnedByLazyglm, true, "repeat install must preserve lazyglm ownership");

    const res = await uninstall({ cwd: d });
    assert.ok(!existsSync(join(d, ".gitignore")), "lazyglm-created .gitignore should still be removed after repeat install");
    assert.ok(res.removed.includes(".gitignore (-.lazyglm/)"), "removed should list the owned gitignore edit");
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("force install keeps ownership of lazyglm-created .gitignore entry", async () => {
  const d = await mkdtemp(join(tmpdir(), "lazyglm-force-install-gitignore-"));
  try {
    await install({ cwd: d });
    await install({ cwd: d, force: true });
    const cfg = JSON.parse(await readFile(join(d, ".lazyglm", "config.json"), "utf8"));
    assert.equal(cfg.gitignoreOwnedByLazyglm, true, "force install must preserve lazyglm ownership");

    const res = await uninstall({ cwd: d });
    assert.ok(!existsSync(join(d, ".gitignore")), "lazyglm-created .gitignore should still be removed after force install");
    assert.ok(res.removed.includes(".gitignore (-.lazyglm/)"), "removed should list the owned gitignore edit");
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("malformed config does not block force install or uninstall", async () => {
  const d = await mkdtemp(join(tmpdir(), "lazyglm-malformed-config-"));
  try {
    await install({ cwd: d });
    await writeFile(join(d, ".lazyglm", "config.json"), "{not json", "utf8");
    await install({ cwd: d });
    let cfg = JSON.parse(await readFile(join(d, ".lazyglm", "config.json"), "utf8"));
    assert.equal(cfg.model, "glm-5.2", "plain install should not turn malformed config into partial ownership-only config");
    assert.ok(cfg.provider?.base_url, "plain install should retain provider defaults when repairing malformed config");

    await writeFile(join(d, ".lazyglm", "config.json"), "null", "utf8");
    await install({ cwd: d });
    cfg = JSON.parse(await readFile(join(d, ".lazyglm", "config.json"), "utf8"));
    assert.equal(cfg.model, "glm-5.2", "plain install should repair non-object JSON config");
    assert.ok(cfg.provider?.base_url, "plain install should retain provider defaults for non-object JSON config");

    await writeFile(join(d, ".lazyglm", "config.json"), "[1,2,3]", "utf8");
    await install({ cwd: d, force: true });
    cfg = JSON.parse(await readFile(join(d, ".lazyglm", "config.json"), "utf8"));
    assert.equal(cfg.model, "glm-5.2", "force install should repair malformed config");

    await writeFile(join(d, ".lazyglm", "config.json"), "null", "utf8");
    const res = await uninstall({ cwd: d });
    assert.ok(!existsSync(join(d, ".lazyglm")), "malformed config must not block removing .lazyglm/");
    assert.ok(res.preserved.some((c) => c.includes("user-owned")), "corrupt ownership marker should fail closed and preserve gitignore entry");
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("install recognizes pre-existing CRLF .lazyglm/ gitignore entry", async () => {
  const d = await mkdtemp(join(tmpdir(), "lazyglm-crlf-preexist-"));
  try {
    await writeFile(join(d, ".gitignore"), "node_modules/\r\n.lazyglm/\r\n", "utf8");
    const res = await install({ cwd: d });
    assert.ok(!res.created.some((c) => c.includes(".gitignore")), "CRLF entry must not be duplicated or claimed");
    const gi = await readFile(join(d, ".gitignore"), "utf8");
    assert.equal((gi.match(/\.lazyglm\//g) || []).length, 1, "CRLF .lazyglm/ entry should appear exactly once");
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("uninstall removes owned CRLF .lazyglm/ gitignore entry", async () => {
  const d = await mkdtemp(join(tmpdir(), "lazyglm-crlf-owned-"));
  try {
    await install({ cwd: d });
    await writeFile(join(d, ".gitignore"), "node_modules/\r\n.lazyglm/\r\ndist/\r\n", "utf8");
    const res = await uninstall({ cwd: d });
    const gi = await readFile(join(d, ".gitignore"), "utf8");
    assert.ok(!gi.includes(".lazyglm/"), "owned CRLF .lazyglm/ entry must be removed");
    assert.ok(gi.includes("node_modules/"), "other entries must survive");
    assert.ok(gi.includes("dist/"), "other entries must survive");
    assert.ok(res.removed.includes(".gitignore (-.lazyglm/)"), "removed should list the owned CRLF gitignore edit");
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("uninstall preserves pre-existing .lazyglm/ gitignore entry and reports it", async () => {
  const d = await mkdtemp(join(tmpdir(), "lazyglm-uninstall-preexist-"));
  try {
    // project already ignored .lazyglm/ before install
    await writeFile(join(d, ".gitignore"), "node_modules/\n.lazyglm/\ndist/\n", "utf8");
    await install({ cwd: d });

    const res = await uninstall({ cwd: d });

    assert.ok(existsSync(join(d, ".gitignore")), ".gitignore must survive");
    const gi = await readFile(join(d, ".gitignore"), "utf8");
    const lines = gi.split("\n");
    assert.ok(lines.includes(".lazyglm/"), "user-owned .lazyglm/ entry must be preserved");
    assert.ok(lines.includes("node_modules/"), "node_modules/ must survive");
    assert.ok(lines.includes("dist/"), "dist/ must survive");
    assert.ok(
      !res.removed.includes(".gitignore (-.lazyglm/)"),
      "removed must NOT list the gitignore edit for user-owned entry",
    );
    assert.ok(
      res.preserved.some((c) => c.includes("user-owned")),
      "preserved must report the user-owned .lazyglm/ entry",
    );
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
