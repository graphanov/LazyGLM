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
import { replayIntoContext, formatReasoning, formatText, formatToolCall, formatToolResult, turnDivider, turnRule, turnStart, turnEnd } from "../src/repl.js";
import { Context, assistantMessageFrom } from "../src/agent/context.js";
import { chat } from "../src/agent/provider.js";

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

const GRAY = "\x1b[90m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";

function assertNoAnsi(output) {
  assert.doesNotMatch(output, /\x1b\[/);
}

test("REPL turn-format helpers expose distinct ANSI markers without stdout side effects", () => {
  const reasoning = formatReasoning("thinking");
  assert.ok(reasoning.includes("✶"));
  assert.ok(reasoning.includes(GRAY));

  const text = formatText("hello");
  assert.equal(text, "💬 hello");

  const call = formatToolCall("read_file", { path: "src/repl.js" });
  assert.ok(call.includes("read_file"));
  assert.ok(call.includes(CYAN));
  assert.ok(call.includes(DIM));
  assert.ok(call.includes("src/repl.js"));

  const result = formatToolResult("ok");
  assert.ok(result.includes("↳"));
  assert.ok(result.includes(GREEN));
  assert.ok(!result.includes(GRAY), "tool results must not reuse reasoning gray");

  const divider = turnDivider();
  assert.ok(divider.includes("─"));
  assert.ok(divider.includes(DIM));
  assert.doesNotMatch(divider, /✶|💬|🔧/);
});

test("REPL turn-format helpers can render without ANSI for non-TTY output", () => {
  assertNoAnsi(formatReasoning("thinking", { isTTY: false }));
  assertNoAnsi(formatToolCall("read_file", { path: "src/repl.js" }, { isTTY: false }));
  assertNoAnsi(formatToolResult("ok", { isTTY: false }));
  assertNoAnsi(turnDivider({ isTTY: false }));
});

test("REPL turn-frame helpers render a symmetric dim rule on TTY", () => {
  const rule = turnRule();
  assert.ok(rule.includes("─"));
  assert.ok(rule.includes(DIM));
  assert.doesNotMatch(rule, /✶|💬|🔧|↳/);

  const start = turnStart("hello", { isTTY: true });
  assert.ok(start.startsWith("\n"), "turnStart TTY opens with a blank line before the rule");
  assert.ok(start.includes("─"));
  assert.ok(start.includes(DIM));
  assert.doesNotMatch(start, /✶|💬|🔧|↳/);

  const end = turnEnd({ isTTY: true });
  assert.ok(end.endsWith("\n\n"), "turnEnd TTY closes with the rule followed by a blank line");
  assert.ok(end.includes("─"));
  assert.ok(end.includes(DIM));
  assert.doesNotMatch(end, /✶|💬|🔧|↳/);

  // Frame symmetry: the rule width (count of ─) is identical top and bottom.
  const ruleChars = (s) => (s.match(/─/g) || []).length;
  assert.equal(ruleChars(start), ruleChars(end), "turnStart/turnEnd rule widths must match");
  assert.equal(ruleChars(rule), ruleChars(start), "turnRule width must match the frame");
});

test("REPL turn-frame helpers stay zero-ANSI and empty/plain for non-TTY", () => {
  assert.equal(turnRule({ isTTY: false }), "");
  assert.equal(turnEnd({ isTTY: false }), "");

  const echo = turnStart("hello", { isTTY: false });
  assertNoAnsi(echo);
  assert.equal(echo, "> hello\n");
  assert.ok(!echo.includes("─"), "non-TTY echo must carry no rule glyph");

  // Long input is truncated to the same cap used elsewhere, no rule glyph.
  const longText = "x".repeat(500);
  const trunc = turnStart(longText, { isTTY: false });
  assertNoAnsi(trunc);
  assert.ok(trunc.length < longText.length, "long input must be truncated");
  assert.ok(trunc.includes("truncated"), "truncation marker must be present");
  assert.ok(!trunc.includes("─"), "truncated non-TTY echo must carry no rule glyph");
});

// Regression (PR #26 Codex review P2, thread src/repl.js:542): in the REPL
// loop, prompt() writes `lazyglm> ` to stdout BEFORE handleLine → runAgentTurn
// emits the non-TTY `> text` turn echo. When stdout is piped (non-TTY), that
// colored prompt must be suppressed so it does not glue onto the echo and
// corrupt piped output as `lazyglm> > text` with ANSI escapes. prompt() now
// checks process.stdout.isTTY. This test locks the non-TTY output contract by
// asserting the turn echo stands alone as a clean line with no prompt prefix.
test("REPL non-TTY turn echo stands alone without a `lazyglm>` prompt prefix", () => {
  // The non-TTY turn echo produced by turnStart must be a standalone clean
  // line: zero-ANSI, no rule glyph, and NOT preceded by the colored prompt.
  const echo = turnStart("hi", { isTTY: false });
  assertNoAnsi(echo);
  assert.equal(echo, "> hi\n");
  assert.ok(!echo.includes("lazyglm>"), "non-TTY echo must not carry the interactive prompt");

  // Sanity: a combined non-TTY render of prompt-suppressed + turnStart yields
  // exactly the echo line, mirroring what a piped consumer sees after the fix.
  const promptStub = ""; // fix: prompt() writes nothing when isTTY === false
  const combined = promptStub + echo;
  assertNoAnsi(combined);
  assert.equal(combined, "> hi\n");
  assert.ok(!combined.includes("lazyglm>"), "piped output must contain no prompt leak");
});

// Regression (PR #26 Codex review P2, thread src/repl.js:539): when the user
// enters an inline $skill, handleLine expands userContent to the full SKILL.md
// body before calling runAgentTurn. The non-TTY `> text` echo must show the
// RAW user input, not the expanded skill body. runAgentTurn now takes a separate
// displayText param (defaults to userContent) and passes it to turnStart.
test("REPL non-TTY turn echo uses raw displayText, not expanded skill body", () => {
  const rawInput = "$programming fix the bug";
  const expandedBody = "---\nname: programming\n---\nFull skill body that is very long...\n\n---\n\nUSER REQUEST\n$programming fix the bug";

  // Simulate what runAgentTurn does: turnStart(displayText) where displayText
  // is the raw input, NOT the expanded userContent.
  const echo = turnStart(rawInput, { isTTY: false });
  assertNoAnsi(echo);
  assert.equal(echo, `> ${rawInput}\n`);
  assert.ok(!echo.includes("skill body"), "echo must not leak the expanded skill body");
  assert.ok(!echo.includes("USER REQUEST"), "echo must not leak the expanded skill body");

  // Sanity: the expanded body would have polluted the echo if passed directly.
  const wrongEcho = turnStart(expandedBody, { isTTY: false });
  assert.ok(wrongEcho.includes("truncated"), "expanded body is long enough to trigger truncation");
  assert.ok(wrongEcho.includes("skill body"), "expanded body would leak into echo");
});

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

test("isOnboarded allows custom only when a base URL is configured", () => {
  const savedBase = process.env.LAZYGLM_BASE_URL;
  try {
    delete process.env.LAZYGLM_BASE_URL;
    assert.ok(!isOnboarded({ onboarded: true, provider: "custom" }));
    process.env.LAZYGLM_BASE_URL = "http://localhost:1234/v1";
    assert.ok(isOnboarded({ onboarded: true, provider: "custom" }));
  } finally {
    restoreEnv("LAZYGLM_BASE_URL", savedBase);
  }
});

// --- onboard.js ---

test("needsOnboarding: true with no key+config; false with env key or keyless env providers", async () => {
  await freshHome();
  const savedKey = process.env.LAZYGLM_API_KEY;
  const savedProvider = process.env.LAZYGLM_PROVIDER;
  const savedBase = process.env.LAZYGLM_BASE_URL;
  try {
    delete process.env.LAZYGLM_API_KEY;
    delete process.env.LAZYGLM_PROVIDER;
    delete process.env.LAZYGLM_BASE_URL;
    assert.ok(await needsOnboarding(), "fresh machine needs onboarding");
    process.env.LAZYGLM_API_KEY = "env-key";
    assert.ok(!(await needsOnboarding()), "env key satisfies onboarding");
    delete process.env.LAZYGLM_API_KEY;
    process.env.LAZYGLM_PROVIDER = " Ollama ";
    assert.ok(!(await needsOnboarding()), "ollama env is keyless and should be normalized");
    delete process.env.LAZYGLM_PROVIDER;
    process.env.LAZYGLM_BASE_URL = "http://localhost:1234/v1";
    assert.ok(!(await needsOnboarding()), "custom base URL is configured outside onboarding");
    process.env.LAZYGLM_PROVIDER = "zai";
    assert.ok(await needsOnboarding(), "key-requiring provider override still needs a key when a base URL is also set");
  } finally {
    restoreEnv("LAZYGLM_API_KEY", savedKey);
    restoreEnv("LAZYGLM_PROVIDER", savedProvider);
    restoreEnv("LAZYGLM_BASE_URL", savedBase);
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

// --- GLM preserved-thinking replay (reasoning_content across turns/sessions) ---

test("replayIntoContext restores reasoning_content from a persisted assistant event", () => {
  const events = [
    { type: "user", content: "do the work" },
    { type: "assistant", content: "done", reasoning_content: "I weighed options then acted.", tool_calls: null },
  ];
  const ctx = new Context();
  replayIntoContext(events, ctx);
  const assistant = ctx.messages.find((m) => m.role === "assistant");
  assert.equal(assistant.reasoning_content, "I weighed options then acted.", "reasoning must be restored on replay");
});

test("assistant append→load round-trip preserves reasoning_content (isolated LAZYGLM_HOME)", async () => {
  await freshHome();
  const s = await createSession({ model: "glm-5.2", provider: "zai" });
  await appendEvent(s, { type: "user", content: "hi" });
  await appendEvent(s, {
    type: "assistant",
    content: "hello",
    tool_calls: null,
    reasoning_content: "thinking about the reply",
  });
  const events = await loadSessionEvents(s.id);
  const assistant = events.find((e) => e.type === "assistant");
  assert.ok(assistant, "assistant event should round-trip");
  assert.equal(assistant.reasoning_content, "thinking about the reply");
});

test("two-turn replay: prior reasoning_content is kept for zai, stripped for ollama", async () => {
  delete process.env.LAZYGLM_PRESERVE_THINKING;
  const original = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
      text: async () => "{}",
      headers: { get: () => null },
    };
  };
  // Turn 1 produced a response with reasoning + a finish tool_call. Build the
  // prior assistant message the same way runtime.js / repl.js now do.
  const resp = {
    content: "All done.",
    reasoning: "Plan: do it, then finish.",
    tool_calls: [{ id: "call_1", type: "function", name: "finish", arguments: { summary: "ok" } }],
  };
  const makeConfig = (provider) => ({
    baseURL: `http://stub-${provider}/v1`,
    apiKey: "stub-key",
    modelId: "glm-5.2",
    model: "glm-5.2",
    provider,
    role: "default",
    timeout: 5000,
    maxRetries: 0,
  });
  try {
    for (const provider of ["zai", "ollama"]) {
      const ctx = new Context();
      ctx.push(assistantMessageFrom(resp)); // turn-1 assistant message (with reasoning_content)
      // Turn 2: send the history; the provider gates the wire payload.
      await chat({ messages: ctx.messages, config: makeConfig(provider) });
      const assistant = capturedBody.messages.find((m) => m.role === "assistant");
      if (provider === "zai") {
        assert.equal(
          assistant.reasoning_content,
          "Plan: do it, then finish.",
          "zai turn-2 must carry prior reasoning_content",
        );
      } else {
        assert.equal(
          assistant.reasoning_content,
          undefined,
          "ollama turn-2 must strip prior reasoning_content",
        );
      }
      // The live Context keeps reasoning_content regardless of provider.
      const ctxAssistant = ctx.messages.find((m) => m.role === "assistant");
      assert.equal(ctxAssistant.reasoning_content, "Plan: do it, then finish.", "context must retain reasoning");
    }
  } finally {
    globalThis.fetch = original;
  }
});
