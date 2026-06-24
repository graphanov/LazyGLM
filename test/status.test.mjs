// Unit tests for src/status.js — the on-demand `/status` renderer.
//
// Mirrors the purity contract of banner.test.mjs: renderStatus() must be a pure
// function (no process reads, no stdout writes), return a string, emit ANSI only
// under TTY, and stay a single zero-ANSI machine-readable line under non-TTY.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatus, ANSI_RE } from "../src/status.js";

const base = {
  sessionId: "sess_abc123",
  model: "glm-5.2",
  provider: "zai",
  role: "default",
  reasoningEffort: "high",
  cumulative: { prompt: 1234, completion: 5678, reasoning: 90 },
  lastTurn: { prompt: 100, completion: 200, reasoning: 10 },
  sessionElapsedMs: 133000,
  lastTurnMs: 4200,
};

const stripAnsi = (s) => s.replace(ANSI_RE, "");

test("TTY output contains ANSI accents", () => {
  const out = renderStatus({ ...base, isTTY: true });
  assert.match(out, /\x1b\[/, "TTY status should contain ANSI escape codes");
});

test("non-TTY output contains ZERO ANSI and is a single line", () => {
  const out = renderStatus({ ...base, isTTY: false });
  assert.doesNotMatch(out, /\x1b/, "non-TTY output must contain ZERO ANSI sequences");
  assert.equal(out.split("\n").filter(Boolean).length, 1, "non-TTY output is exactly one non-empty line");
  assert.doesNotMatch(out, /\n$/, "non-TTY output has no trailing newline");
});

test("TTY status line includes session id, model, provider, role/effort, tokens, credits", () => {
  const out = renderStatus({ ...base, isTTY: true });
  const plain = stripAnsi(out);
  assert.ok(plain.includes("sess_abc123"), "session id present");
  assert.ok(plain.includes("glm-5.2"), "model present");
  assert.ok(plain.includes("zai"), "provider present");
  assert.ok(/default\/high/.test(plain), "role/effort present as role/effort");
  assert.ok(plain.includes("credits: n/a"), "TTY credits show the unavailable state");
});

test("non-TTY status line is pipe-parseable key=value", () => {
  const out = renderStatus({ ...base, isTTY: false });
  // The machine-readable contract: leading label + key=value segments joined by " | ".
  assert.match(out, /^LazyGLM status \| /);
  const kv = Object.fromEntries(
    out
      .split(" | ")
      .slice(1)
      .map((seg) => seg.split("=")),
  );
  assert.equal(kv.session, "sess_abc123");
  assert.equal(kv.model, "glm-5.2");
  assert.equal(kv.provider, "zai");
  assert.equal(kv.role, "default");
  assert.equal(kv.effort, "high");
  assert.equal(kv.prompt, "1234");
  assert.equal(kv.completion, "5678");
  assert.equal(kv.reasoning, "90");
  assert.equal(kv.session_ms, "133000");
  assert.equal(kv.turn_ms, "4200");
  assert.equal(kv.last_prompt, "100");
  assert.equal(kv.last_completion, "200");
  assert.equal(kv.last_reasoning, "10");
  assert.equal(kv.credits, "unsupported", "non-TTY credits show the unsupported state");
});

test("credits: always n/a (TTY) / unsupported (non-TTY) — never estimated or faked", () => {
  const tty = renderStatus({ ...base, isTTY: true });
  assert.ok(stripAnsi(tty).includes("credits: n/a"), "TTY credits render n/a");
  const plain = renderStatus({ ...base, isTTY: false });
  assert.ok(plain.includes("credits=unsupported"), "non-TTY credits render unsupported");
  // No fake/estimated credit value leaks through in either mode.
  assert.doesNotMatch(stripAnsi(tty), /credits[:=]\s*\d/, "no numeric credit estimate in TTY");
  assert.doesNotMatch(plain, /credits=\d/, "no numeric credit estimate in non-TTY");
});

test("timing humanizes for TTY and is raw ms for non-TTY", () => {
  const tty = renderStatus({ ...base, isTTY: true });
  const plain = stripAnsi(tty);
  assert.ok(/turn 4\.2s/.test(plain), "TTY turn timing humanized (4.2s)");
  assert.ok(/session 2m13s/.test(plain), "TTY session timing humanized (2m13s)");
  const nontty = renderStatus({ ...base, isTTY: false });
  assert.ok(/turn_ms=4200/.test(nontty), "non-TTY turn_ms is raw ms");
  assert.ok(/session_ms=133000/.test(nontty), "non-TTY session_ms is raw ms");
});

test("lastTurn omitted (no turn completed yet) degrades cleanly", () => {
  const tty = renderStatus({ ...base, lastTurn: null, isTTY: true });
  assert.ok(stripAnsi(tty).includes("sess_abc123"), "still renders");
  const nontty = renderStatus({ ...base, lastTurn: null, isTTY: false });
  assert.doesNotMatch(nontty, /last_/, "non-TTY omits last_* keys when lastTurn is null");
  assert.match(nontty, /turn_ms=4200/, "turn_ms still present (timing captured independently of usage)");
});

test("unknown last-turn duration stays blank instead of rendering 0ms", () => {
  const tty = renderStatus({ ...base, lastTurnMs: null, isTTY: true });
  assert.ok(stripAnsi(tty).includes("turn —"), "TTY shows an unknown marker, not 0ms");
  const nontty = renderStatus({ ...base, lastTurnMs: null, isTTY: false });
  assert.match(nontty, /turn_ms=\s*(\||$)/, "non-TTY turn_ms is blank when no timed turn exists");
});

test("purity: defaults are safe (no crash, no ANSI) when called with empty opts", () => {
  const out = renderStatus({});
  assert.doesNotMatch(out, /\x1b/, "default isTTY:false => no ANSI");
  assert.match(out, /^LazyGLM status \| /, "default renders the machine-readable line");
  assert.equal(out.split("\n").filter(Boolean).length, 1, "single non-empty line");
  // Safe defaults for the unknown-state fields.
  assert.match(out, /session=\?/, "missing session id degrades to '?'");
  assert.match(out, /credits=unsupported/, "credits always declared");
});

test("purity: role/effort defaults when omitted", () => {
  const out = renderStatus({ sessionId: "x", isTTY: false });
  assert.match(out, /role=default/, "role defaults to 'default'");
  assert.match(out, /effort=high/, "effort defaults to 'high'");
});

test("public-safety: no /Users paths leak (status line carries no cwd)", () => {
  const tty = renderStatus({ ...base, isTTY: true });
  assert.ok(!tty.includes("/Users"), "TTY status never includes a /Users path");
  const plain = renderStatus({ ...base, isTTY: false });
  assert.ok(!plain.includes("/Users"), "non-TTY status never includes a /Users path");
});

test("token totals are cumulative prompt/completion/reasoning", () => {
  const tty = renderStatus({ ...base, isTTY: true });
  const plain = stripAnsi(tty);
  assert.ok(/1234↑/.test(plain), "cumulative prompt tokens render with up arrow");
  assert.ok(/5678↓/.test(plain), "cumulative completion tokens render with down arrow");
  assert.ok(/🧠 90/.test(plain), "cumulative reasoning tokens render with brain marker");
});
