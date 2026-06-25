import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyFinish } from "../src/ulw.js";
import { createDeadline } from "../src/agent/deadline.js";

let cwd;
test.before(async () => { cwd = await mkdtemp(join(tmpdir(), "lazyglm-ulw-")); });
test.after(async () => { await rm(cwd, { recursive: true, force: true }); });

test("verifyFinish PASSES when written files exist + verify command exits 0", async () => {
  await writeFile(join(cwd, "game.js"), "console.log('hi');\n", "utf8");
  await writeFile(join(cwd, "index.html"), "<script src=game.js></script>three\n", "utf8");
  const v = await verifyFinish({
    summary: "Created game.js and index.html. Loads three@0.160.0/build/three.module.js and three/addons/controls/PointerLockControls.js.",
    cwd,
    filesWritten: ["game.js", "index.html"],
    verifyCommand: "node --check game.js && grep -qi three index.html",
  });
  assert.equal(v.pass, true, v.reason);
});

test("verifyFinish does NOT false-fail on CDN module specifiers in the summary", async () => {
  // Regression: the old regex extractor treated "three@0.160.0/build/three.module.js"
  // and "Three.js" as missing local files. The tracked-files approach must ignore them.
  await writeFile(join(cwd, "a.js"), "x\n", "utf8");
  const v = await verifyFinish({
    summary: "Loads Three.js r160 via importmap. Uses three@0.160.0/build/three.module.js and three/addons/controls/PointerLockControls.js. Created a.js.",
    cwd,
    filesWritten: ["a.js"],
  });
  assert.equal(v.pass, true, v.reason);
});

test("verifyFinish FAILS when a written file is missing", async () => {
  const v = await verifyFinish({
    summary: "Created gone.js.",
    cwd,
    filesWritten: ["gone.js"],
  });
  assert.equal(v.pass, false);
  assert.match(v.reason, /gone.js/);
});

test("verifyFinish FAILS when verify command exits non-zero", async () => {
  await writeFile(join(cwd, "b.js"), "x\n", "utf8");
  const v = await verifyFinish({
    summary: "Created b.js.",
    cwd,
    filesWritten: ["b.js"],
    verifyCommand: "node --check does-not-exist.js",
  });
  assert.equal(v.pass, false);
  assert.match(v.reason, /verify command failed/);
});

test("verifyFinish honors the whole-run deadline", async () => {
  const deadline = createDeadline(30);
  try {
    await assert.rejects(
      () => verifyFinish({
        summary: "slow verify",
        cwd,
        filesWritten: [],
        verifyCommand: "node -e \"setTimeout(() => {}, 1000)\"",
        deadline,
      }),
      /timed out/,
    );
  } finally {
    deadline.cancel();
  }
});
