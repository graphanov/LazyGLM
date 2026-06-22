import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSemver, checkUpdate } from "../src/update.js";

// --- compareSemver: pure x.y.z comparison across patch/minor/major deltas ---

test("compareSemver returns -1 when behind (patch delta 1.0.0 vs 1.0.1)", () => {
  assert.equal(compareSemver("1.0.0", "1.0.1"), -1);
});

test("compareSemver returns 1 when ahead (minor delta 1.1.0 vs 1.0.5)", () => {
  assert.equal(compareSemver("1.1.0", "1.0.5"), 1);
});

test("compareSemver returns 1 when ahead (major delta 2.0.0 vs 1.9.9)", () => {
  assert.equal(compareSemver("2.0.0", "1.9.9"), 1);
});

test("compareSemver returns 0 on equal versions", () => {
  assert.equal(compareSemver("0.1.3", "0.1.3"), 0);
});

test("compareSemver treats missing components as 0", () => {
  assert.equal(compareSemver("1.0", "1.0.0"), 0);
  assert.equal(compareSemver("1", "1.0.0"), 0);
  assert.equal(compareSemver("2", "1.9.9"), 1);
});

// --- checkUpdate with injected seams: no network, deterministic local ---

const readLocal = async () => "0.1.3";

test("checkUpdate: newer remote -> behind, exit 1", async () => {
  const res = await checkUpdate({ fetchRemote: async () => "0.2.0", readLocal });
  assert.equal(res.status, "behind");
  assert.equal(res.exitCode, 1);
  assert.equal(res.local, "0.1.3");
  assert.equal(res.remote, "0.2.0");
});

test("checkUpdate: older remote -> ahead, exit 0", async () => {
  const res = await checkUpdate({ fetchRemote: async () => "0.1.0", readLocal });
  assert.equal(res.status, "ahead");
  assert.equal(res.exitCode, 0);
});

test("checkUpdate: same remote -> equal, exit 0", async () => {
  const res = await checkUpdate({ fetchRemote: async () => "0.1.3", readLocal });
  assert.equal(res.status, "equal");
  assert.equal(res.exitCode, 0);
});

test("checkUpdate: fetcher throws -> error, exit 2", async () => {
  const res = await checkUpdate({
    fetchRemote: async () => { throw new Error("registry down"); },
    readLocal,
  });
  assert.equal(res.status, "error");
  assert.equal(res.exitCode, 2);
  assert.match(res.detail, /registry down/);
});
