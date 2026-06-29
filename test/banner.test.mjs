import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderBanner, WORDMARK } from "../dist/banner.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "dist", "banner.js");

const base = { model: "glm-5.2", provider: "zai", cwd: "/tmp/demo" };
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s) => s.replace(ANSI_RE, "");

test("wordmark: the ASCII LAZYGLM art lines render under TTY", () => {
  const out = renderBanner({ ...base, isTTY: true });
  for (const row of WORDMARK) {
    assert.ok(out.includes(row), `TTY banner should include wordmark row "${row}"`);
  }
});

test("wordmark: art lines are a fixed, professional-width block", () => {
  assert.ok(WORDMARK.length >= 4, "wordmark should be several rows tall");
  const widths = WORDMARK.map((r) => r.length);
  const w = widths[0];
  for (const x of widths) assert.equal(x, w, "every wordmark row must be the same width (fixed-width)");
  assert.ok(w >= 50 && w <= 72, `wordmark should be a larger CLI wordmark (got ${w})`);
});

test("TTY layout: wordmark, tagline, and panel align to one visible width", () => {
  const out = renderBanner({
    ...base,
    git: { isRepo: true, branch: "main", root: "/tmp/demo" },
    session: { id: "sess-abc123" },
    isTTY: true,
  });
  const lines = out.split("\n").map(stripAnsi).filter((line) => line.length > 0);
  const widths = lines.map((line) => line.length);
  const uniqueWidths = new Set(widths);
  assert.equal(uniqueWidths.size, 1, `all visible banner lines should align; got widths ${widths.join(",")}`);
  assert.equal(widths[0], WORDMARK[0].length, "panel and tagline should align with the wordmark width");
});

test("info tokens: panel contains the exact model, provider, and cwd passed in", () => {
  const out = renderBanner({ model: "glm-4.7-flash", provider: "ollama", cwd: "/srv/app", isTTY: true });
  assert.ok(out.includes("glm-4.7-flash"), "model token present");
  assert.ok(out.includes("ollama"), "provider token present");
  assert.ok(out.includes("/srv/app"), "cwd token present");
});

test("yolo: true renders the yolo line, false omits it", () => {
  const on = renderBanner({ ...base, yolo: true, isTTY: true });
  assert.match(on, /yolo mode/, "yolo:true should render the yolo line");
  const off = renderBanner({ ...base, yolo: false, isTTY: true });
  assert.doesNotMatch(off, /yolo mode/, "yolo:false should omit the yolo line");
});

test("TTY gradient: isTTY:true output contains ANSI escapes", () => {
  const out = renderBanner({ ...base, isTTY: true });
  assert.match(out, /\x1b\[/, "TTY banner should contain ANSI escape codes");
});

test("non-TTY: zero ANSI, a single machine-readable line", () => {
  const out = renderBanner({ model: "glm-5.2", provider: "zai", cwd: "/tmp/demo", isTTY: false });
  assert.doesNotMatch(out, /\x1b/, "non-TTY output must contain ZERO ANSI sequences");
  assert.equal(out, "LazyGLM | glm-5.2 | zai | /tmp/demo\n", "non-TTY collapses to one machine line");
  assert.equal(out.split("\n").filter(Boolean).length, 1, "non-TTY output is exactly one non-empty line");
});

test("tier: omitted tier keeps legacy non-TTY output byte-identical", () => {
  const out = renderBanner({ ...base, isTTY: false });
  assert.equal(out, "LazyGLM | glm-5.2 | zai | /tmp/demo\n");
});

test("tier: TTY banner shows active tier and catalog-derived guidance", () => {
  const out = renderBanner({
    ...base,
    tier: "high-end",
    tierReason: "Use this tier for long-horizon coding.",
    isTTY: true,
  });
  const plain = stripAnsi(out);
  assert.ok(plain.includes("tier     high-end"), "tier row present");
  assert.ok(plain.includes("guidance Use this tier for long-horizon coding."), "guidance row present");
});

test("tier: non-TTY banner appends pipe-parseable tier fields only when supplied", () => {
  const out = renderBanner({
    ...base,
    tier: "high-end",
    tierReason: "Use this tier for long-horizon coding.",
    isTTY: false,
  });
  assert.equal(
    out,
    "LazyGLM | glm-5.2 | zai | /tmp/demo | tier=high-end | guidance=Use this tier for long-horizon coding.\n",
  );
});

test("non-TTY: stays a clean single line even with git/session/yolo set", () => {
  const out = renderBanner({
    model: "glm-5.2",
    provider: "zai",
    cwd: "/tmp/demo",
    git: { isRepo: true, branch: "main", root: "/tmp/demo" },
    session: { id: "sess-xyz" },
    yolo: true,
    isTTY: false,
  });
  assert.doesNotMatch(out, /\x1b/);
  assert.equal(out.split("\n").filter(Boolean).length, 1, "no art / panel leaks into the non-TTY line");
});

test("git: branch renders when isRepo, absent when not a repo", () => {
  const withGit = renderBanner({ ...base, git: { isRepo: true, branch: "trunk-99", root: "/tmp/demo" }, isTTY: true });
  assert.ok(withGit.includes("trunk-99"), "branch should render when isRepo:true");
  assert.ok(withGit.includes("git "), "git label present when isRepo:true");

  const noGit = renderBanner({ ...base, git: { isRepo: false, branch: "", root: "" }, isTTY: true });
  assert.ok(!noGit.includes("trunk-99"), "branch must be absent when not a repo");
  assert.ok(!noGit.includes("git "), "no git label when not a repo");
});

test("session: id renders when a session is provided", () => {
  const withSession = renderBanner({ ...base, session: { id: "sess-abc123" }, isTTY: true });
  assert.ok(withSession.includes("sess-abc123"), "session id should render");
  const noSession = renderBanner({ ...base, isTTY: true });
  assert.ok(!noSession.includes("sess-abc123"), "no session id when session omitted");
});

test("slash hint line is present", () => {
  const out = renderBanner({ ...base, isTTY: true });
  assert.ok(out.includes("/help"), "slash hint references /help");
  assert.ok(out.includes("/ultrawork"), "slash hint references /ultrawork");
  assert.ok(out.includes("/skills"), "slash hint references /skills");
});

test("long cwd is trailing-truncated so the panel never wraps", () => {
  const long = "/tmp/" + "a".repeat(400);
  const out = renderBanner({ ...base, cwd: long, isTTY: true });
  assert.ok(out.includes("…"), "a very long cwd should be trailing-truncated in the panel");
});

test("public-safety: no hardcoded /Users paths leak beyond the passed cwd", () => {
  // Given a cwd with NO /Users prefix, the output must contain zero "/Users".
  const out = renderBanner({ ...base, cwd: "/tmp/demo", isTTY: true });
  assert.ok(!out.includes("/Users"), "no hardcoded /Users path should appear in the banner");
  const plain = renderBanner({ ...base, cwd: "/tmp/demo", isTTY: false });
  assert.ok(!plain.includes("/Users"), "no hardcoded /Users path in the non-TTY line either");
});

test("public-safety: banner module source has no emails, absolute home paths, or phone-like strings", async () => {
  // Generic PII guards (no owner identifiers are named here — embedding real
  // names in a public test would itself be a leak). The diff-level privacy scan
  // at PR time is the human-side gate for specific owner identifiers.
  const src = await readFile(SRC, "utf8");
  assert.doesNotMatch(src, /\/Users\//, "no absolute home paths in source");
  assert.doesNotMatch(src, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "no email addresses in source");
  assert.doesNotMatch(src, /\+\d{8,}|\b\d{3}[- ]?\d{6,}\b/, "no phone-number-like strings in source");
});

test("purity: defaults are safe (no crash, no ANSI) when called with empty opts", () => {
  const out = renderBanner({});
  assert.doesNotMatch(out, /\x1b/, "default isTTY:false => no ANSI");
  assert.match(out, /^LazyGLM \| /, "default renders the machine-readable line");
});
