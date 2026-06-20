// GLM provider: speaks the OpenAI Chat Completions schema with tool calling.
//
// DEFAULT: the Zhipu z.ai coding endpoint (https://api.z.ai/api/coding/paas/v4)
// serving glm-5.2 — the frontier GLM model. Requires LAZYGLM_API_KEY (get a key
// with a z.ai coding plan). The /coding/ segment in the base URL is REQUIRED
// (/api/paas/v4 returns 401).
//
// To use a different backend:
//   LAZYGLM_PROVIDER=zai              Zhipu z.ai (DEFAULT; api.z.ai/api/coding/paas/v4, key required)
//   LAZYGLM_PROVIDER=nous             Nous Research inference API (inference-api.nousresearch.com/v1)
//   LAZYGLM_PROVIDER=ollama           local Ollama (keyless, http://localhost:11434/v1)
//   LAZYGLM_BASE_URL=<url>            any custom OpenAI-compatible endpoint
//   LAZYGLM_API_KEY=<key>             bearer token (required for zai/nous/custom; ignored by ollama)
//   LAZYGLM_MODEL=<name>              override the catalog default model
//   LAZYGLM_TIMEOUT=<ms>              request timeout (default 600000)
//   LAZYGLM_MAX_RETRIES=<n>           max retries on transient errors (default 4)
//
// Hardened for 0.1.0:
//   - Streaming SSE (text + reasoning_content + tool_call deltas)
//   - Exponential-backoff retry on 429/5xx and network errors (respects Retry-After)
//   - Reasoning-token capture from usage for per-turn cost visibility

import { pickModel, getProviderConfig, resolveProvider } from "./router.js";

const DEFAULT_TIMEOUT = 600_000;
const DEFAULT_MAX_RETRIES = 4;
const OLLAMA_BASE = "http://localhost:11434/v1";
const NOUS_BASE = "https://inference-api.nousresearch.com/v1";

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * Resolve the full provider config: base_url, api_key, timeout, and the
 * provider-specific model ID. This is the single entry point the runtime uses.
 *
 * @param {object} options - { model?, provider?, role? }
 * @returns {Promise<{baseURL, apiKey, modelId, model, provider, role, timeout, maxRetries}>}
 */
export async function resolveProviderConfig(options = {}) {
  const role = options.role || "default";
  const picked = await pickModel(role, { model: options.model, provider: options.provider });

  // Determine base_url + requires_key for the picked provider
  let baseURL;
  let requiresKey = true;

  if (picked.provider === "ollama") {
    baseURL = process.env.LAZYGLM_BASE_URL?.replace(/\/$/, "") || OLLAMA_BASE;
    requiresKey = false;
  } else if (picked.provider === "nous") {
    baseURL = process.env.LAZYGLM_BASE_URL?.replace(/\/$/, "") || NOUS_BASE;
    requiresKey = true;
  } else if (picked.provider === "zai") {
    baseURL = process.env.LAZYGLM_BASE_URL?.replace(/\/$/, "") || "https://api.z.ai/api/coding/paas/v4";
    requiresKey = true;
  } else {
    // custom
    baseURL = (process.env.LAZYGLM_BASE_URL || "").replace(/\/$/, "");
    requiresKey = !!process.env.LAZYGLM_API_KEY;
  }

  const apiKey = process.env.LAZYGLM_API_KEY || (requiresKey ? "" : "ollama");
  const timeout = Number(process.env.LAZYGLM_TIMEOUT || DEFAULT_TIMEOUT);
  const maxRetries = Number(process.env.LAZYGLM_MAX_RETRIES ?? DEFAULT_MAX_RETRIES);

  if (requiresKey && !apiKey) {
    throw new Error(
      `GLM provider '${picked.provider}' requires LAZYGLM_API_KEY. Get a key from https://portal.nousresearch.com (Nous) or https://z.ai (Zhipu), then:\n` +
      `  export LAZYGLM_API_KEY=sk-...\n` +
      `Or use local Ollama instead: LAZYGLM_PROVIDER=ollama (run \`ollama serve\` first)`,
    );
  }

  return {
    baseURL,
    apiKey,
    modelId: picked.modelId,
    model: picked.model,
    provider: picked.provider,
    role: picked.role,
    timeout,
    maxRetries,
  };
}

/**
 * fetch with exponential backoff retry on transient errors.
 * Retries on: network errors, 408/409/425/429/500/502/503/504.
 * Respects the Retry-After header on 429/503 when present.
 * Non-retryable statuses (4xx other than above) throw immediately.
 *
 * @param {string} url
 * @param {object} init  - fetch init (headers, body, signal)
 * @param {object} opts  - { timeout, maxRetries, onRetry }
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, init, { timeout, maxRetries, onRetry }) {
  const baseDelay = 1000;
  const maxDelay = 30_000;
  let attempt = 0;
  // We create a fresh AbortController per attempt so a timeout on attempt N
  // doesn't poison attempt N+1.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let res;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      const name = err?.name;
      if (name === "AbortError") {
        // Timeouts are retryable (the server may just be slow / queueing).
        if (attempt < maxRetries) {
          const delay = backoffDelay(baseDelay, maxDelay, attempt);
          onRetry?.({ attempt: attempt + 1, reason: `timeout after ${timeout}ms`, delay });
          await sleep(delay);
          attempt++;
          continue;
        }
        throw new Error(`GLM request timed out after ${timeout}ms. Is the model loaded / endpoint reachable?`);
      }
      // Network error (DNS, connection refused, ECONNRESET, etc.) — retryable.
      if (attempt < maxRetries) {
        const delay = backoffDelay(baseDelay, maxDelay, attempt);
        onRetry?.({ attempt: attempt + 1, reason: `network error: ${err?.message || err}`, delay });
        await sleep(delay);
        attempt++;
        continue;
      }
      const hint = /localhost|11434/.test(url) ? "Is Ollama running? Try: ollama serve" : `Is ${new URL(url).origin} reachable?`;
      throw new Error(`GLM request failed: ${err?.message || err}. ${hint}`);
    }
    clearTimeout(timer);

    if (res.ok) return res;

    // Non-OK: decide retry vs fail.
    if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      const delay = retryAfter != null ? Math.min(retryAfter, maxDelay) : backoffDelay(baseDelay, maxDelay, attempt);
      onRetry?.({ attempt: attempt + 1, reason: `HTTP ${res.status}`, delay });
      // Drain the body so the connection can be reused.
      await res.text().catch(() => {});
      await sleep(delay);
      attempt++;
      continue;
    }

    // Non-retryable: surface a clear, actionable error.
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new Error(`GLM auth error ${res.status}: ${truncateBody(text, 400)}\nYour LAZYGLM_API_KEY may be invalid, blocked, or out of funds. Check https://portal.nousresearch.com (Nous) or https://z.ai (Zhipu).`);
    }
    throw new Error(`GLM provider error ${res.status}: ${truncateBody(text, 800)} (url=${url})`);
  }
}

function backoffDelay(base, max, attempt) {
  const exp = Math.min(base * 2 ** attempt, max);
  // Full jitter: uniform random in [0, exp].
  return Math.floor(Math.random() * exp);
}

function parseRetryAfter(header) {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Send a chat completion request to the GLM provider.
 *
 * When `onDelta` is provided, the request is streamed (stream: true) and
 * text/reasoning/tool_call deltas are emitted as they arrive:
 *   onDelta({ type: "text", text })
 *   onDelta({ type: "reasoning", text })
 *   onDelta({ type: "tool_call_start", index, id, name })
 *   onDelta({ type: "tool_call_args", index, fragment })
 *   onDelta({ type: "done", finish_reason })
 *
 * The resolved value is the same shape regardless of streaming, so the
 * runtime can treat both paths uniformly.
 *
 * @param {object} opts
 * @param {string} opts.model      provider-specific model ID (e.g. z-ai/glm-5.2)
 * @param {Array}  opts.messages   OpenAI messages
 * @param {Array}  [opts.tools]    OpenAI function/tool specs
 * @param {number} [opts.temperature]
 * @param {object} [opts.config]   provider config (from resolveProviderConfig)
 * @param {function} [opts.onDelta] streaming callback
 * @param {function} [opts.onRetry] retry callback
 * @returns {Promise<{content: string|null, reasoning: string|null, tool_calls: Array|null, raw: object, usage: object|null}>}
 */
export async function chat({ model, messages, tools, temperature, config, onDelta, onRetry }) {
  const cfg = config || await resolveProviderConfig();
  const url = `${cfg.baseURL}/chat/completions`;
  const wantStream = typeof onDelta === "function";
  const body = {
    model: model || cfg.modelId,
    messages,
    temperature: temperature ?? 0.6,
    stream: wantStream,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  if (wantStream) {
    // Ask for usage in the final stream chunk (OpenAI-compatible; z.ai & Ollama support it).
    body.stream_options = { include_usage: true };
  }

  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
  };

  const res = await fetchWithRetry(url, init, { timeout: cfg.timeout, maxRetries: cfg.maxRetries, onRetry });

  if (!wantStream) {
    const data = await res.json();
    return parseCompletion(data);
  }

  // ---- Streaming path: parse SSE ----
  return parseSSEStream(res, onDelta);
}

/**
 * Parse a non-streaming completion response into the unified shape.
 */
function parseCompletion(data) {
  const choice = data?.choices?.[0];
  if (!choice) {
    throw new Error(`GLM provider returned no choices: ${JSON.stringify(data).slice(0, 500)}`);
  }
  const msg = choice.message || {};
  return {
    content: typeof msg.content === "string" ? msg.content : null,
    reasoning: typeof msg.reasoning_content === "string" ? msg.reasoning_content : null,
    tool_calls: normalizeToolCalls(msg.tool_calls),
    raw: data,
    usage: data.usage || null,
  };
}

function normalizeToolCalls(rawToolCalls) {
  if (!Array.isArray(rawToolCalls) || !rawToolCalls.length) return null;
  return rawToolCalls.map((tc, i) => {
    const fn = tc.function || {};
    let args = {};
    try {
      args = fn.arguments ? JSON.parse(fn.arguments) : {};
    } catch {
      args = { _raw: fn.arguments };
    }
    return {
      id: tc.id || `call_${i}`,
      type: "function",
      name: fn.name,
      arguments: args,
    };
  });
}

/**
 * Parse an SSE streaming response from an OpenAI-compatible endpoint.
 * Emits delta events via onDelta and returns the unified completion shape.
 */
async function parseSSEStream(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let content = "";
  let reasoning = "";
  /** @type {Map<number, {id, name, args}>} */
  const toolCalls = new Map();
  let finishReason = null;
  let usage = null;

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) return; // blank or comment
    if (!trimmed.startsWith("data:")) return; // ignore event:/id: lines
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return; // malformed line — skip rather than abort the whole stream
    }
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      onDelta({ type: "text", text: delta.content });
    }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      onDelta({ type: "reasoning", text: delta.reasoning_content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const existing = toolCalls.get(idx) || { id: null, name: null, args: "" };
        if (tc.id) {
          existing.id = tc.id;
          onDelta({ type: "tool_call_start", index: idx, id: tc.id, name: tc.function?.name });
        }
        if (tc.function?.name) existing.name = tc.function.name;
        if (typeof tc.function?.arguments === "string") {
          existing.args += tc.function.arguments;
          onDelta({ type: "tool_call_args", index: idx, fragment: tc.function.arguments });
        }
        toolCalls.set(idx, existing);
      }
    }
  };

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleLine(line.replace(/\r$/, ""));
      }
    }
    // Flush any trailing line.
    if (buffer.trim()) handleLine(buffer.replace(/\r$/, ""));
  } catch (err) {
    throw new Error(`GLM stream interrupted: ${err?.message || err}. Partial content may have been received (${content.length} chars).`);
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  onDelta({ type: "done", finish_reason: finishReason });

  const calls = [];
  for (const [, tc] of [...toolCalls].sort((a, b) => a[0] - b[0])) {
    let args = {};
    try {
      args = tc.args ? JSON.parse(tc.args) : {};
    } catch {
      args = { _raw: tc.args };
    }
    calls.push({
      id: tc.id || `call_${calls.length}`,
      type: "function",
      name: tc.name,
      arguments: args,
    });
  }

  return {
    content: content || null,
    reasoning: reasoning || null,
    tool_calls: calls.length ? calls : null,
    raw: { choices: [{ finish_reason: finishReason }] },
    usage,
  };
}

function truncateBody(text, max) {
  const s = String(text ?? "");
  return s.length <= max ? s : s.slice(0, max) + "…";
}

/**
 * List models at the configured provider (for `doctor`).
 */
export async function listModels(config) {
  const cfg = config || await resolveProviderConfig();
  const url = `${cfg.baseURL}/models`;
  const headers = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const res = await fetchWithRetry(url, { headers }, { timeout: cfg.timeout, maxRetries: cfg.maxRetries });
  if (!res.ok) throw new Error(`list models failed: ${res.status}`);
  const data = await res.json();
  return (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
}
