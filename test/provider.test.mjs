// Unit tests for GLM preserved-thinking replay: provider support matrix and
// the chat() wire-payload gating (keep reasoning_content for zai, strip for
// others, honor LAZYGLM_PRESERVE_THINKING). No network — fetch is stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chat, supportsPreservedThinking } from "../dist/agent/provider.js";

// A provider response the runtime/REPL would receive. We only assert on the
// outgoing *request body* (the wire payload), so the response content is minimal.
const STUB_RESPONSE = { choices: [{ message: { content: "ok" } }] };

function makeConfig(provider, overrides = {}) {
  return {
    baseURL: `http://stub-${provider}/v1`,
    apiKey: "stub-key",
    modelId: "glm-5.2",
    model: "glm-5.2",
    provider,
    role: "default",
    reasoningEffort: "high",
    timeout: 5000,
    maxRetries: 0,
    ...overrides,
  };
}

/** Messages with a prior assistant turn that carried preserved thinking. */
function historyWithReasoning() {
  return [
    { role: "system", content: "sys" },
    { role: "user", content: "do the thing" },
    { role: "assistant", content: "done", reasoning_content: "I considered X then Y." },
  ];
}

function responseForSpec(spec) {
  if (spec && typeof spec === "object" && "status" in spec) {
    const status = spec.status;
    const body = spec.body ?? { error: "stub" };
    const text = spec.text ?? JSON.stringify(body);
    return {
      ok: spec.ok ?? status < 400,
      status,
      json: async () => body,
      text: async () => text,
      headers: { get: () => null },
    };
  }
  const body = spec || STUB_RESPONSE;
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  };
}

function installFetchStub(responses = [STUB_RESPONSE]) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const spec = responses[Math.min(calls.length - 1, responses.length - 1)];
    return responseForSpec(spec);
  };
  const sentBody = (index = calls.length - 1) => {
    assert.ok(calls.length, "fetch was never called");
    return JSON.parse(calls[index].init.body);
  };
  return {
    sentBody,
    sentBodies() {
      return calls.map((_, i) => sentBody(i));
    },
    callCount() {
      return calls.length;
    },
    // Returns the messages array sent in the request body.
    sentMessages() {
      return sentBody().messages;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// --- supportsPreservedThinking ---

test("supportsPreservedThinking: true only for zai", () => {
  assert.equal(supportsPreservedThinking("zai"), true);
  assert.equal(supportsPreservedThinking("ollama"), false);
  assert.equal(supportsPreservedThinking("nous"), false);
  assert.equal(supportsPreservedThinking("custom"), false);
  assert.equal(supportsPreservedThinking(undefined), false);
});

// --- chat() keep/strip by provider (auto, the default) ---

test("chat() keeps reasoning_content on the outgoing message for zai", async () => {
  delete process.env.LAZYGLM_PRESERVE_THINKING;
  const stub = installFetchStub();
  try {
    await chat({ messages: historyWithReasoning(), config: makeConfig("zai") });
    const sent = stub.sentMessages();
    const assistant = sent.find((m) => m.role === "assistant");
    assert.equal(assistant.reasoning_content, "I considered X then Y.", "zai should receive reasoning_content");
  } finally {
    stub.restore();
  }
});

test("chat() sends z.ai thinking enabled with reasoning_effort for high effort", async () => {
  delete process.env.LAZYGLM_PRESERVE_THINKING;
  const stub = installFetchStub();
  try {
    await chat({ messages: historyWithReasoning(), config: makeConfig("zai", { reasoningEffort: "high" }) });
    assert.deepEqual(stub.sentBody().thinking, { type: "enabled", clear_thinking: false });
    assert.equal(stub.sentBody().reasoning_effort, "high");
  } finally {
    stub.restore();
  }
});

test("chat() sends reasoning_effort matching the configured effort for zai", async () => {
  for (const effort of ["medium", "high", "max"]) {
    delete process.env.LAZYGLM_PRESERVE_THINKING;
    const stub = installFetchStub();
    try {
      await chat({ messages: historyWithReasoning(), config: makeConfig("zai", { reasoningEffort: effort }) });
      assert.equal(stub.sentBody().reasoning_effort, effort, `wire should carry ${effort}`);
      assert.deepEqual(stub.sentBody().thinking, { type: "enabled", clear_thinking: false });
    } finally {
      stub.restore();
    }
  }
});

test("chat() sends z.ai thinking disabled and no reasoning_effort for low effort", async () => {
  delete process.env.LAZYGLM_PRESERVE_THINKING;
  const stub = installFetchStub();
  try {
    await chat({ messages: historyWithReasoning(), config: makeConfig("zai", { role: "quick", reasoningEffort: "low" }) });
    assert.deepEqual(stub.sentBody().thinking, { type: "disabled" });
    assert.equal(stub.sentBody().reasoning_effort, undefined);
  } finally {
    stub.restore();
  }
});

test("chat() strips reasoning_content for ollama / nous / custom", async () => {
  delete process.env.LAZYGLM_PRESERVE_THINKING;
  for (const provider of ["ollama", "nous", "custom"]) {
    const stub = installFetchStub();
    try {
      await chat({ messages: historyWithReasoning(), config: makeConfig(provider) });
      const sent = stub.sentMessages();
      const assistant = sent.find((m) => m.role === "assistant");
      assert.equal(
        assistant.reasoning_content,
        undefined,
        `${provider} should not receive reasoning_content`,
      );
      // content must survive the strip (only reasoning_content is removed)
      assert.equal(assistant.content, "done", `${provider} content must survive strip`);
      assert.equal(stub.sentBody().thinking, undefined, `${provider} should not receive z.ai thinking control`);
    } finally {
      stub.restore();
    }
  }
});

test("chat() does not mutate the caller's messages array when stripping", async () => {
  delete process.env.LAZYGLM_PRESERVE_THINKING;
  const messages = historyWithReasoning();
  const before = JSON.parse(JSON.stringify(messages));
  const stub = installFetchStub();
  try {
    await chat({ messages, config: makeConfig("ollama") });
    assert.deepEqual(messages, before, "the live Context messages must keep reasoning_content");
  } finally {
    stub.restore();
  }
});

test("chat() retries once without z.ai thinking control after HTTP 400", async () => {
  delete process.env.LAZYGLM_PRESERVE_THINKING;
  const stub = installFetchStub([
    { status: 400, text: "unsupported thinking field" },
    STUB_RESPONSE,
  ]);
  const retries = [];
  try {
    await chat({
      messages: historyWithReasoning(),
      config: makeConfig("zai", { reasoningEffort: "high" }),
      onRetry: (payload) => retries.push(payload),
    });
    assert.equal(stub.callCount(), 2);
    const [first, second] = stub.sentBodies();
    assert.deepEqual(first.thinking, { type: "enabled", clear_thinking: false });
    assert.equal(first.reasoning_effort, "high");
    assert.equal(second.thinking, undefined);
    assert.equal(second.reasoning_effort, undefined);
    assert.equal(retries.length, 1);
    assert.match(retries[0].reason, /thinking control rejected with HTTP 400/);
  } finally {
    stub.restore();
  }
});

// --- LAZYGLM_PRESERVE_THINKING overrides ---

test("LAZYGLM_PRESERVE_THINKING=on forces keep on an unsupported provider (ollama)", async () => {
  const saved = process.env.LAZYGLM_PRESERVE_THINKING;
  process.env.LAZYGLM_PRESERVE_THINKING = "on";
  const stub = installFetchStub();
  try {
    await chat({ messages: historyWithReasoning(), config: makeConfig("ollama") });
    const sent = stub.sentMessages();
    const assistant = sent.find((m) => m.role === "assistant");
    assert.equal(assistant.reasoning_content, "I considered X then Y.", "override=on must force keep on ollama");
  } finally {
    stub.restore();
    restoreEnv("LAZYGLM_PRESERVE_THINKING", saved);
  }
});

test("LAZYGLM_PRESERVE_THINKING=off forces strip on zai", async () => {
  const saved = process.env.LAZYGLM_PRESERVE_THINKING;
  process.env.LAZYGLM_PRESERVE_THINKING = "off";
  const stub = installFetchStub();
  try {
    await chat({ messages: historyWithReasoning(), config: makeConfig("zai") });
    const sent = stub.sentMessages();
    const assistant = sent.find((m) => m.role === "assistant");
    assert.equal(assistant.reasoning_content, undefined, "override=off must force strip on zai");
  } finally {
    stub.restore();
    restoreEnv("LAZYGLM_PRESERVE_THINKING", saved);
  }
});

// --- reasoning_effort gated by model support (GLM-5.2+) ---

test("chat() omits reasoning_effort for glm-4.7 even when thinking is enabled", async () => {
  delete process.env.LAZYGLM_PRESERVE_THINKING;
  const stub = installFetchStub();
  try {
    await chat({
      messages: historyWithReasoning(),
      config: makeConfig("zai", { modelId: "glm-4.7", model: "glm-4.7", reasoningEffort: "high" }),
    });
    // thinking should still be sent (verifier/quick roles get turn-level toggle)
    assert.deepEqual(stub.sentBody().thinking, { type: "enabled", clear_thinking: false });
    // but reasoning_effort must NOT be sent — glm-4.7 rejects it
    assert.equal(stub.sentBody().reasoning_effort, undefined);
  } finally {
    stub.restore();
  }
});

test("chat() sends reasoning_effort for glm-5.2 when thinking is enabled", async () => {
  delete process.env.LAZYGLM_PRESERVE_THINKING;
  const stub = installFetchStub();
  try {
    await chat({
      messages: historyWithReasoning(),
      config: makeConfig("zai", { modelId: "glm-5.2", model: "glm-5.2", reasoningEffort: "high" }),
    });
    assert.deepEqual(stub.sentBody().thinking, { type: "enabled", clear_thinking: false });
    assert.equal(stub.sentBody().reasoning_effort, "high");
  } finally {
    stub.restore();
  }
});
