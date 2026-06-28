import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HookEngine } from "../src/hooks/engine.js";
import { discoverScaffold, formatHandoffInject, readHandoffText } from "../src/scaffold/handoff.js";
import scaffoldHandoff from "../src/plugins/scaffold-handoff.js";

async function withTempCwd(fn) {
  const cwd = await mkdtemp(join(tmpdir(), "lazyglm-scaffold-"));
  try {
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function write(cwd, rel, content) {
  await mkdir(dirname(join(cwd, rel)), { recursive: true });
  await writeFile(join(cwd, rel), content, "utf8");
}

test("absent Open Scaffold records are a no-op by default", async () => {
  await withTempCwd(async (cwd) => {
    assert.deepEqual(discoverScaffold(cwd), { present: false, sources: [] });

    const res = await scaffoldHandoff.hooks.SessionStart({}, { cwd, log: () => {} });

    assert.equal(res, undefined);
  });
});

test("SessionStart injects bounded Open Scaffold handoff text when .osc handoff exists", async () => {
  await withTempCwd(async (cwd) => {
    await write(cwd, ".osc/handoff.md", "Decision: keep the compaction digest as fallback.\n");

    const engine = new HookEngine({ cwd });
    engine.register(scaffoldHandoff);
    const res = await engine.fire("SessionStart", {});

    assert.equal(res.injects.length, 1);
    assert.match(res.injects[0], /OPEN SCAFFOLD HANDOFF CONTEXT/);
    assert.match(res.injects[0], /Source: \.osc\/handoff\.md/);
    assert.match(res.injects[0], /optional repo-native handoff context, not verified truth/);
    assert.match(res.injects[0], /Decision: keep the compaction digest as fallback\./);
  });
});

test("MISSION.md is used as fallback when no precomputed handoff exists", async () => {
  await withTempCwd(async (cwd) => {
    await write(cwd, "MISSION.md", "# Mission\nRecover context from repo-native records.\n");

    const handoff = await readHandoffText(cwd);

    assert.equal(handoff.source, "MISSION.md");
    assert.match(handoff.text, /Recover context/);
  });
});

test(".osc handoff has precedence over MISSION.md", async () => {
  await withTempCwd(async (cwd) => {
    await write(cwd, ".osc/handoff.md", "Preferred scaffold packet\n");
    await write(cwd, "MISSION.md", "Fallback mission text\n");

    const handoff = await readHandoffText(cwd);

    assert.equal(handoff.source, ".osc/handoff.md");
    assert.match(handoff.text, /Preferred scaffold packet/);
    assert.doesNotMatch(handoff.text, /Fallback mission text/);
  });
});

test("present but empty scaffold records emit a diagnostic and do not inject", async () => {
  await withTempCwd(async (cwd) => {
    const logs = [];
    await mkdir(join(cwd, ".osc"), { recursive: true });

    const res = await scaffoldHandoff.hooks.SessionStart({}, {
      cwd,
      log: (msg) => logs.push(msg),
    });

    assert.equal(res, undefined);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /records present/);
    assert.match(logs[0], /no readable handoff text/);
  });
});

test("empty .osc handoff falls through to non-empty MISSION.md", async () => {
  await withTempCwd(async (cwd) => {
    await write(cwd, ".osc/handoff.md", "   \n");
    await write(cwd, "MISSION.md", "Mission fallback survives an empty packet.\n");

    const handoff = await readHandoffText(cwd);

    assert.equal(handoff.source, "MISSION.md");
    assert.match(handoff.text, /Mission fallback/);
  });
});

test("unreadable .osc handoff falls through to readable MISSION.md", async () => {
  await withTempCwd(async (cwd) => {
    // .osc/handoff.md as a directory is unreadable via readFile → should skip.
    await mkdir(join(cwd, ".osc", "handoff.md"), { recursive: true });
    await write(cwd, "MISSION.md", "Fallback survives an unreadable packet.\n");

    const handoff = await readHandoffText(cwd);

    assert.equal(handoff.source, "MISSION.md");
    assert.match(handoff.text, /Fallback survives an unreadable packet/);
  });
});

test("osc binary availability is not required for file-based handoff injection", async () => {
  await withTempCwd(async (cwd) => {
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = "";
      await write(cwd, ".osc/handoff.md", "Precomputed packet only.\n");

      const res = await scaffoldHandoff.hooks.SessionStart({}, { cwd, log: () => {} });

      assert.match(res.inject, /Precomputed packet only/);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });
});

test("handoff text is budgeted with a truncation marker", async () => {
  await withTempCwd(async (cwd) => {
    await write(cwd, ".osc/handoff.md", "x".repeat(80));

    const handoff = await readHandoffText(cwd, { maxChars: 20 });
    const inject = formatHandoffInject(handoff);

    assert.equal(handoff.truncated, true);
    assert.ok(handoff.text.startsWith("x".repeat(20)));
    assert.match(handoff.text, /truncated 60 chars/);
    assert.match(inject, /Open Scaffold handoff truncated before injection/);
  });
});
