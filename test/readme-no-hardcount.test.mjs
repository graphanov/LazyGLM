import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const README = await readFile(join(ROOT, "README.md"), "utf8");

test("README does not hardcode a literal test count", () => {
  // Invariant: the README must never state "N tests" / "N passing tests".
  // That number is hand-typed and rots on every test-adding PR (it already
  // drifted 65 -> 77 in the repo). The live CI status badge at the top of the
  // README is the durable, zero-maintenance signal that actually matters.
  //
  // Scoped to <integer> + word so this does NOT false-flag phrases like
  // "node --test" or "npm test", which contain no leading count.
  const match = /#?\s*\d+\s+(passing\s+)?tests?\b/i.exec(README);
  assert.ok(
    !match,
    `README contains a hardcoded test count (forbidden — it rots): ${JSON.stringify(match && match[0])}`,
  );
});
