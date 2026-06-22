import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import startWorkContinuation from "../src/plugins/start-work-continuation.js";

async function withTempCwd(fn) {
  const cwd = await mkdtemp(join(tmpdir(), "lazyglm-start-work-"));
  try {
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function writeActivePlan(cwd, planPath, plan) {
  await mkdir(join(cwd, ".lazyglm"), { recursive: true });
  await mkdir(dirname(join(cwd, planPath)), { recursive: true });
  await writeFile(join(cwd, ".lazyglm", "active-plan.json"), JSON.stringify({ planPath }), "utf8");
  await writeFile(join(cwd, planPath), plan, "utf8");
}

async function stop(cwd, input = {}) {
  return startWorkContinuation.hooks.Stop(input, { cwd });
}

test("unfinished active plan feedback points to the interactive start-work REPL path", async () => {
  await withTempCwd(async (cwd) => {
    await writeActivePlan(cwd, "plans/current.md", [
      "# Current plan",
      "- [x] Inspect repo",
      "- [ ] Patch hook",
      "- [ ] Add tests",
      "",
    ].join("\n"));

    const res = await stop(cwd);

    assert.match(res.feedback, /interactive lazyglm REPL/);
    assert.match(res.feedback, /start lazyglm, then enter \$start-work/);
    assert.match(res.feedback, /plans\/current\.md/);
    assert.match(res.feedback, /1\/3 items done/);
    assert.match(res.feedback, /2 remaining/);
    assert.doesNotMatch(res.feedback, /lazyglm run/);
    assert.doesNotMatch(res.feedback, /--plan/);
  });
});

test("resume hint handles plan paths unsafe as unquoted shell commands", async () => {
  await withTempCwd(async (cwd) => {
    const planPath = "plans/unsafe path; $(touch nope).md";
    await writeActivePlan(cwd, planPath, "- [x] Done\n- [ ] Remaining\n");

    const res = await stop(cwd);

    assert.match(res.feedback, /unsafe path; \$\(touch nope\)\.md/);
    assert.match(res.feedback, /\$start-work/);
    assert.doesNotMatch(res.feedback, /lazyglm run/);
    assert.doesNotMatch(res.feedback, /--plan/);
  });
});

test("finished runs do not emit continuation feedback", async () => {
  await withTempCwd(async (cwd) => {
    await writeActivePlan(cwd, "plans/current.md", "- [ ] Remaining\n");

    const res = await stop(cwd, { finished: true });

    assert.equal(res, undefined);
  });
});

test("missing active-plan files do not emit continuation feedback", async () => {
  await withTempCwd(async (cwd) => {
    const res = await stop(cwd);

    assert.equal(res, undefined);
  });
});

test("missing referenced plan files do not emit continuation feedback", async () => {
  await withTempCwd(async (cwd) => {
    await mkdir(join(cwd, ".lazyglm"), { recursive: true });
    await writeFile(join(cwd, ".lazyglm", "active-plan.json"), JSON.stringify({ planPath: "plans/missing.md" }), "utf8");

    const res = await stop(cwd);

    assert.equal(res, undefined);
  });
});

test("corrupt active-plan JSON does not emit continuation feedback", async () => {
  await withTempCwd(async (cwd) => {
    await mkdir(join(cwd, ".lazyglm"), { recursive: true });
    await writeFile(join(cwd, ".lazyglm", "active-plan.json"), "not json", "utf8");

    const res = await stop(cwd);

    assert.equal(res, undefined);
  });
});

test("fully checked plans do not emit continuation feedback", async () => {
  await withTempCwd(async (cwd) => {
    await writeActivePlan(cwd, "plans/done.md", "- [x] One\n- [X] Two\n");

    const res = await stop(cwd);

    assert.equal(res, undefined);
  });
});
