import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { main } from "../src/cli.js";
import { runAgent } from "../src/agent/runtime.js";

const ANSI_RE = /\x1b\[/;
const execFileAsync = promisify(execFile);

function makeConfig() {
  return {
    baseURL: "http://lazyglm-headless.test/v1",
    apiKey: "test-key",
    modelId: "glm-test",
    model: "glm-test",
    provider: "custom",
    role: "default",
    timeout: 5000,
    maxRetries: 0,
  };
}

function usage(prompt = 11, completion = 7, reasoning = 3) {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    completion_tokens_details: { reasoning_tokens: reasoning },
  };
}

function sseResponse(chunks, init = {}) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: init.status || 200,
    headers: { "content-type": "text/event-stream", ...(init.headers || {}) },
  });
}

function finishResponse(summary = "done", u = usage()) {
  return sseResponse([
    {
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: "call_finish", function: { name: "finish", arguments: JSON.stringify({ summary }) } }],
        },
      }],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: u },
  ]);
}

function toolResponse(name, args, u = usage()) {
  return sseResponse([
    {
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: `call_${name}`, function: { name, arguments: JSON.stringify(args) } }],
        },
      }],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: u },
  ]);
}

function textOnlyResponse(text = "hello", u = usage()) {
  return sseResponse([
    { choices: [{ delta: { content: text }, finish_reason: "stop" }] },
    { choices: [], usage: u },
  ]);
}

function retryAfterResponse(seconds = "30") {
  return new Response("busy", { status: 503, headers: { "retry-after": seconds } });
}

function installFetchSequence(responses) {
  const original = globalThis.fetch;
  const queue = [...responses];
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length ? queue.shift() : responses[responses.length - 1];
    return typeof next === "function" ? next(url, init, calls.length) : next;
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

async function withTempCwd(fn) {
  const cwd = await mkdtemp(join(tmpdir(), "lazyglm-headless-"));
  try {
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function captureMain(argv, { fetchResponses, env = {} } = {}) {
  const savedEnv = new Map();
  for (const name of ["LAZYGLM_PROVIDER", "LAZYGLM_BASE_URL", "LAZYGLM_API_KEY", "LAZYGLM_TIMEOUT", "LAZYGLM_MAX_RETRIES", ...Object.keys(env)]) {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  }
  process.env.LAZYGLM_BASE_URL = "http://lazyglm-headless.test/v1";
  delete process.env.LAZYGLM_PROVIDER;
  delete process.env.LAZYGLM_API_KEY;
  process.env.LAZYGLM_MAX_RETRIES = "0";
  Object.assign(process.env, env);

  const fetchStub = fetchResponses ? installFetchSequence(fetchResponses) : null;
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  let stdout = "";
  let stderr = "";
  process.stdout.write = function write(chunk, encoding, cb) {
    stdout += String(chunk);
    if (typeof encoding === "function") encoding();
    if (typeof cb === "function") cb();
    return true;
  };
  process.stderr.write = function write(chunk, encoding, cb) {
    stderr += String(chunk);
    if (typeof encoding === "function") encoding();
    if (typeof cb === "function") cb();
    return true;
  };
  try {
    const code = await main(argv);
    return { code, stdout, stderr, fetchCalls: fetchStub?.calls || [] };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    fetchStub?.restore();
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function parseSingleJson(stdout) {
  const lines = stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `expected exactly one JSON line, got ${lines.length}: ${stdout}`);
  return JSON.parse(lines[0]);
}

test("lazyglm run --output-format json emits exactly one structured object on success", async () => {
  await withTempCwd(async (cwd) => {
    const { code, stdout, stderr } = await captureMain([
      "run",
      "finish quickly",
      "--cwd",
      cwd,
      "--output-format",
      "json",
    ], { fetchResponses: [finishResponse("all done", usage(13, 8, 5))] });

    assert.equal(code, 0, stderr);
    assert.equal(stderr, "");
    assert.doesNotMatch(stdout, /🚀|💬|✶|FINISH/);
    const json = parseSingleJson(stdout);
    assert.equal(json.ok, true);
    assert.equal(json.result, "all done");
    assert.equal(json.finishReason, "finished");
    assert.deepEqual(json.toolCalls, [{ name: "finish", turn: 1, status: "finish" }]);
    assert.equal(json.cost.tokens, 21);
    assert.equal(json.cost.promptTokens, 13);
    assert.equal(json.cost.completionTokens, 8);
    assert.equal(json.cost.reasoningTokens, 5);
    assert.match(json.session.id, /^sess_/);
    assert.match(json.session.transcriptPath, /\.lazyglm\/sessions\/sess_/);
    assert.equal(json.session.turns, 1);
  });
});

test("startup/config error in JSON mode returns session:null and exit 1", async () => {
  await withTempCwd(async (cwd) => {
    const { code, stdout } = await captureMain([
      "run",
      "cannot start",
      "--cwd",
      cwd,
      "--output-format",
      "json",
    ], { env: { LAZYGLM_PROVIDER: "Help", LAZYGLM_BASE_URL: "" } });

    assert.equal(code, 1);
    const json = parseSingleJson(stdout);
    assert.equal(json.ok, false);
    assert.equal(json.finishReason, "error");
    assert.equal(json.session, null);
    assert.deepEqual(json.cost, { tokens: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0 });
    assert.match(json.error.message, /Unknown GLM provider/);
  });
});

test("invalid numeric run flags in JSON mode emit a structured usage error", async () => {
  await withTempCwd(async (cwd) => {
    const { code, stdout, fetchCalls } = await captureMain([
      "run",
      "bad flag",
      "--cwd",
      cwd,
      "--output-format",
      "json",
      "--max-turns",
    ], { fetchResponses: [finishResponse("should not run")] });

    assert.equal(code, 1);
    assert.equal(fetchCalls.length, 0);
    const json = parseSingleJson(stdout);
    assert.equal(json.ok, false);
    assert.equal(json.session, null);
    assert.match(json.error.message, /--max-turns requires a value/);
  });
});

test("max turns exceeded exits non-zero with max_turns", async () => {
  await withTempCwd(async (cwd) => {
    const { code, stdout } = await captureMain([
      "run",
      "do not finish",
      "--cwd",
      cwd,
      "--output-format",
      "json",
      "--max-turns",
      "1",
    ], { fetchResponses: [textOnlyResponse("I will describe instead")] });

    assert.equal(code, 2);
    const json = parseSingleJson(stdout);
    assert.equal(json.ok, false);
    assert.equal(json.finishReason, "max_turns");
    assert.equal(json.session.turns, 1);
  });
});

test("verify failure after finish exits non-zero with verify_failed", async () => {
  await withTempCwd(async (cwd) => {
    const { code, stdout } = await captureMain([
      "run",
      "finish then verify",
      "--cwd",
      cwd,
      "--output-format",
      "json",
      "--verify",
      "node -e \"process.exit(7)\"",
    ], { fetchResponses: [finishResponse("claimed done")] });

    assert.equal(code, 2);
    const json = parseSingleJson(stdout);
    assert.equal(json.ok, false);
    assert.equal(json.finishReason, "verify_failed");
    assert.equal(json.verification.pass, false);
    assert.match(json.verification.reason, /verify command failed/);
  });
});

test("whole-run timeout interrupts provider retry backoff", async () => {
  await withTempCwd(async (cwd) => {
    const started = Date.now();
    const { code, stdout } = await captureMain([
      "run",
      "hit retry-after",
      "--cwd",
      cwd,
      "--output-format",
      "json",
      "--timeout",
      "0.05",
    ], {
      env: { LAZYGLM_MAX_RETRIES: "4" },
      fetchResponses: [() => retryAfterResponse("30")],
    });
    const elapsed = Date.now() - started;

    assert.equal(code, 2);
    assert.ok(elapsed < 1500, `timeout should not wait for Retry-After; elapsed=${elapsed}ms`);
    const json = parseSingleJson(stdout);
    assert.equal(json.ok, false);
    assert.equal(json.finishReason, "timeout");
  });
});

test("whole-run timeout wins when stream read is canceled", async () => {
  await withTempCwd(async (cwd) => {
    const { code, stdout } = await captureMain([
      "run",
      "hang in stream",
      "--cwd",
      cwd,
      "--output-format",
      "json",
      "--timeout",
      "0.05",
      "--max-turns",
      "1",
    ], {
      fetchResponses: [() => new Response(new ReadableStream({}), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })],
    });

    assert.equal(code, 2);
    const json = parseSingleJson(stdout);
    assert.equal(json.ok, false);
    assert.equal(json.finishReason, "timeout");
  });
});

test("retry backoff sleep remains referenced while awaited", async () => {
  const deadlineModuleUrl = new URL("../src/agent/deadline.js", import.meta.url).href;
  const script = `import { abortableSleep } from ${JSON.stringify(deadlineModuleUrl)};\nawait abortableSleep(30);\nconsole.log("slept");`;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], { timeout: 1000 });

  assert.equal(stdout.trim(), "slept");
});

test("text output is ANSI-free when stdout is not a TTY", async () => {
  await withTempCwd(async (cwd) => {
    const { code, stdout } = await captureMain([
      "run",
      "finish in text mode",
      "--cwd",
      cwd,
      "--no-color",
    ], { fetchResponses: [finishResponse("text done")] });

    assert.equal(code, 0);
    assert.doesNotMatch(stdout, ANSI_RE);
    assert.match(stdout, /Run result/);
  });
});

test("headless failOnToolBlock denies PreToolUse without waiting for stdin", async () => {
  await withTempCwd(async (cwd) => {
    const fetchStub = installFetchSequence([toolResponse("run_shell", { command: "echo should-not-run" })]);
    try {
      const res = await runAgent({
        task: "run a denied command",
        cwd,
        config: makeConfig(),
        maxTurns: 2,
        failOnToolBlock: true,
        plugins: [{ name: "deny", hooks: { PreToolUse: async () => ({ decision: "block", reason: "not allowed" }) } }],
      });
      assert.equal(res.finished, false);
      assert.equal(res.finishReason, "tool_denied");
      assert.deepEqual(res.toolCalls, [{ name: "run_shell", turn: 1, status: "denied" }]);
    } finally {
      fetchStub.restore();
    }
  });
});

test("PostToolUse block on finish cancels success", async () => {
  await withTempCwd(async (cwd) => {
    const fetchStub = installFetchSequence([finishResponse("blocked finish")]);
    try {
      const res = await runAgent({
        task: "finish but get blocked",
        cwd,
        config: makeConfig(),
        maxTurns: 2,
        failOnToolBlock: true,
        plugins: [{ name: "post-deny", hooks: { PostToolUse: async () => ({ decision: "block", reason: "finish not accepted" }) } }],
      });
      assert.equal(res.finished, false);
      assert.equal(res.finishReason, "tool_denied");
      assert.deepEqual(res.toolCalls, [{ name: "finish", turn: 1, status: "denied" }]);
    } finally {
      fetchStub.restore();
    }
  });
});

test("recoverable tool semantic errors are observable but not fatal", async () => {
  await withTempCwd(async (cwd) => {
    const fetchStub = installFetchSequence([
      toolResponse("read_file", { path: "missing.txt" }),
      finishResponse("recovered after missing file"),
    ]);
    try {
      const res = await runAgent({
        task: "recover from a missing read",
        cwd,
        config: makeConfig(),
        maxTurns: 3,
      });
      assert.equal(res.finished, true);
      assert.equal(res.finishReason, "finished");
      assert.deepEqual(res.toolCalls, [
        { name: "read_file", turn: 1, status: "error" },
        { name: "finish", turn: 2, status: "finish" },
      ]);
    } finally {
      fetchStub.restore();
    }
  });
});

test("permissionMode yolo reaches hooks and can bypass a guard", async () => {
  await withTempCwd(async (cwd) => {
    const fetchStub = installFetchSequence([toolResponse("run_shell", { command: "echo ok" }), finishResponse("yolo finished")]);
    try {
      const res = await runAgent({
        task: "run a shell command in yolo",
        cwd,
        config: makeConfig(),
        maxTurns: 3,
        permissionMode: "yolo",
        failOnToolBlock: true,
        plugins: [{
          name: "guard",
          hooks: {
            PreToolUse: async (input) => (input.permission_mode === "yolo" ? undefined : { decision: "block", reason: "not yolo" }),
          },
        }],
      });
      assert.equal(res.finished, true);
      assert.equal(res.finishReason, "finished");
      assert.equal(res.toolCalls[0].status, "ok");
    } finally {
      fetchStub.restore();
    }
  });
});
