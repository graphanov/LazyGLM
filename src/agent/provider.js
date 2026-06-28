// @ts-check

// GLM provider: speaks the OpenAI Chat Completions schema with tool calling.
//
// DEFAULT: the z.ai coding endpoint (https://api.z.ai/api/coding/paas/v4)
// serving glm-5.2 — the default high-end GLM coding model. Requires LAZYGLM_API_KEY (get a key
// with a z.ai coding plan). The /coding/ segment in the base URL is REQUIRED
// (/api/paas/v4 returns 401).
//
// To use a different backend:
//   LAZYGLM_PROVIDER=zai              z.ai (DEFAULT; api.z.ai/api/coding/paas/v4, key required)
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
import { SUPPORTED_PROVIDERS } from "../config.js";
import { thinkingControlForRequest, supportsReasoningEffort } from "./thinking.js";
import {
  abortableSleep,
  abortReason,
  composeAbortSignals,
  isDeadlineError,
  isRequestTimeoutError,
  requestTimeoutError,
  throwIfAborted,
  withAbort,
} from "./deadline.js";

/**
 * @typedef {import("../types/index.js").Provider} Provider
 * @typedef {import("../types/index.js").ReasoningEffort} ReasoningEffort
 * @typedef {import("../types/index.js").ProviderConfig} ProviderConfig
 * @typedef {import("../types/index.js").ModelRouteOptions} ModelRouteOptions
 * @typedef {import("../types/index.js").ChatCompletion} ChatCompletion
 * @typedef {import("../types/index.js").ChatUsage} ChatUsage
 * @typedef {import("../types/index.js").StreamDelta} StreamDelta
 * @typedef {import("../types/index.js").ToolCall} ToolCall
 * @typedef {import("../types/index.js").ToolSpec} ToolSpec
 *
 * @typedef {{ attempt: number, reason: string, delay: number }} RetryPayload
 * @typedef {{ timeout: number, maxRetries: number, onRetry?: (payload: RetryPayload) => void, signal?: AbortSignal }} RetryOptions
 * @typedef {{ role?: string, content?: string | null, reasoning_content?: string | null, name?: string, tool_call_id?: string, tool_calls?: unknown, [key: string]: unknown }} ChatMessage
 * @typedef {{ model?: string, messages: ChatMessage[], tools?: ToolSpec[], temperature?: number, config?: ProviderConfig, reasoningEffort?: ReasoningEffort, onDelta?: (delta: StreamDelta) => void, onRetry?: (payload: RetryPayload) => void, signal?: AbortSignal }} ChatOptions
 * @typedef {{ model?: string, messages: ChatMessage[], temperature: number, stream: boolean, tools?: ToolSpec[], tool_choice?: "auto", stream_options?: { include_usage: boolean }, thinking?: { type: "disabled" } | { type: "enabled", clear_thinking?: false }, reasoning_effort?: ReasoningEffort }} ChatRequestBody
 * @typedef {{ id?: string | null, name?: string | null }} ModelListEntry
 * @typedef {{ id?: string | null, function?: { name?: string | null, arguments?: string | null } | null, [key: string]: unknown }} OpenAIToolCall
 * @typedef {{ index?: number, id?: string | null, function?: { name?: string | null, arguments?: string | null } | null, [key: string]: unknown }} OpenAIStreamToolCallDelta
 * @typedef {{ content?: string | null, reasoning_content?: string | null, tool_calls?: OpenAIToolCall[] | OpenAIStreamToolCallDelta[] | null, [key: string]: unknown }} OpenAIMessage
 * @typedef {{ message?: OpenAIMessage | null, delta?: OpenAIMessage | null, finish_reason?: string | null, [key: string]: unknown }} OpenAIChoice
 * @typedef {{ choices?: OpenAIChoice[], usage?: ChatUsage | null, data?: ModelListEntry[], models?: ModelListEntry[], [key: string]: unknown }} OpenAIResponse
 * @typedef {{ id: string | null, name: string | null, args: string }} StreamToolCallAccumulator
 */

const DEFAULT_TIMEOUT = 600_000;
const DEFAULT_MAX_RETRIES = 4;
const OLLAMA_BASE = "http://localhost:11434/v1";
const NOUS_BASE = "https://inference-api.nousresearch.com/v1";

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * Resolve the full provider config: base_url, api_key, timeout, and the
 * provider-specific model ID. This is the single entry point the runtime uses.
 *
 * @param {ModelRouteOptions} [options] - { model?, provider?, role? }
 * @returns {Promise<ProviderConfig>}
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
  } else if (picked.provider === "custom") {
    baseURL = (process.env.LAZYGLM_BASE_URL || "").replace(/\/$/, "");
    // Custom OpenAI-compatible endpoints may be local/keyless (LM Studio, llama.cpp),
    // but still use LAZYGLM_API_KEY when the endpoint needs one.
    requiresKey = !!process.env.LAZYGLM_API_KEY;
  } else {
    throw new Error(
      `Unknown GLM provider '${picked.provider}'. Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}. ` +
      `Set LAZYGLM_PROVIDER to one of those, or set LAZYGLM_BASE_URL for a custom OpenAI-compatible endpoint. ` +
      `If this came from onboarding, edit or remove ~/.lazyglm/config.json and run \`lazyglm\` again.`,
    );
  }

  const apiKey = process.env.LAZYGLM_API_KEY || picked.apiKey || (requiresKey ? "" : "ollama");
  const timeout = Number(process.env.LAZYGLM_TIMEOUT || DEFAULT_TIMEOUT);
  const maxRetries = Number(process.env.LAZYGLM_MAX_RETRIES ?? DEFAULT_MAX_RETRIES);

  if (!baseURL) {
    throw new Error("Custom GLM provider requires LAZYGLM_BASE_URL to be set to an OpenAI-compatible endpoint.");
  }

  if (requiresKey && !apiKey) {
    throw new Error(
      `GLM provider '${picked.provider}' requires an API key. Run \`lazyglm\` to onboard (persists to ~/.lazyglm/config.json), or:\n` +
      `  export LAZYGLM_API_KEY=...\n` +
      `Get a key from https://z.ai (default) or https://portal.nousresearch.com (Nous).\n` +
      `Or use local Ollama: LAZYGLM_PROVIDER=ollama (run \`ollama serve\` first)`,
    );
  }

  return {
    baseURL,
    apiKey,
    modelId: picked.modelId,
    model: picked.model,
    provider: picked.provider,
    role: picked.role,
    reasoningEffort: picked.reasoningEffort,
    timeout,
    maxRetries,
  };
}

class ProviderHttpError extends Error {
  /**
   * @param {number} status
   * @param {string} body
   * @param {string} url
   */
  constructor(status, body, url) {
    super(`GLM provider error ${status}: ${truncateBody(body, 800)} (url=${url})`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

/**
 * fetch with exponential backoff retry on transient errors.
 * Retries on: network errors, 408/409/425/429/500/502/503/504.
 * Respects the Retry-After header on 429/503 when present.
 * Non-retryable statuses (4xx other than above) throw immediately.
 *
 * @param {string} url
 * @param {RequestInit} init  - fetch init (headers, body, signal)
 * @param {RetryOptions} opts  - { timeout, maxRetries, onRetry, signal }
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, init, { timeout, maxRetries, onRetry, signal }) {
  const baseDelay = 1000;
  const maxDelay = 30_000;
  const requestTimeoutMs = Math.max(1, Number(timeout) || DEFAULT_TIMEOUT);
  let attempt = 0;
  // We create a fresh AbortController per attempt so a timeout on attempt N
  // doesn't poison attempt N+1.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    throwIfAborted(signal);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(requestTimeoutError(requestTimeoutMs)), requestTimeoutMs);
    timer.unref?.();
    const combined = composeAbortSignals([init?.signal, signal, controller.signal]);
    let res;
    try {
      res = await fetch(url, { ...init, signal: combined.signal });
    } catch (err) {
      clearTimeout(timer);
      combined.cancel();
      const errName = errorName(err);
      const errText = errorMessage(err);
      if (isDeadlineError(err) || signal?.aborted) throw abortReason(signal, errorForAbort(err));
      if (isRequestTimeoutError(err) || errName === "AbortError") {
        // Per-request timeouts are retryable; the outer run deadline is not.
        if (attempt < maxRetries) {
          const delay = backoffDelay(baseDelay, maxDelay, attempt);
          onRetry?.({ attempt: attempt + 1, reason: `timeout after ${requestTimeoutMs}ms`, delay });
          await abortableSleep(delay, signal);
          attempt++;
          continue;
        }
        throw new Error(`GLM request timed out after ${requestTimeoutMs}ms. Is the model loaded / endpoint reachable?`);
      }
      // Network error (DNS, connection refused, ECONNRESET, etc.) — retryable.
      if (attempt < maxRetries) {
        const delay = backoffDelay(baseDelay, maxDelay, attempt);
        onRetry?.({ attempt: attempt + 1, reason: `network error: ${errText}`, delay });
        await abortableSleep(delay, signal);
        attempt++;
        continue;
      }
      const hint = /localhost|11434/.test(url) ? "Is Ollama running? Try: ollama serve" : `Is ${new URL(url).origin} reachable?`;
      throw new Error(`GLM request failed: ${errText}. ${hint}`);
    } finally {
      clearTimeout(timer);
      combined.cancel();
    }

    if (res.ok) return res;

    // Non-OK: decide retry vs fail.
    if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      const delay = retryAfter != null ? Math.min(retryAfter, maxDelay) : backoffDelay(baseDelay, maxDelay, attempt);
      onRetry?.({ attempt: attempt + 1, reason: `HTTP ${res.status}`, delay });
      // Drain the body so the connection can be reused, but do not outlive the run deadline.
      await readResponseText(res, signal).catch((err) => {
        if (isDeadlineError(err)) throw err;
        return "";
      });
      await abortableSleep(delay, signal);
      attempt++;
      continue;
    }

    // Non-retryable: surface a clear, actionable error.
    const text = await readResponseText(res, signal).catch((err) => {
      if (isDeadlineError(err)) throw err;
      return "";
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`GLM auth error ${res.status}: ${truncateBody(text, 400)}\nYour LAZYGLM_API_KEY may be invalid, blocked, or out of funds. Check https://portal.nousresearch.com (Nous) or https://z.ai (Zhipu).`);
    }
    throw new ProviderHttpError(res.status, text, url);
  }
}

/**
 * @param {unknown} err
 * @returns {Error | undefined}
 */
function errorForAbort(err) {
  return /** @type {Error | undefined} */ (err);
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorName(err) {
  return err && typeof err === "object" && "name" in err ? String(err.name) : "";
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  if (err && typeof err === "object" && "message" in err && err.message) return String(err.message);
  return String(err);
}

/**
 * @param {number} base
 * @param {number} max
 * @param {number} attempt
 * @returns {number}
 */
function backoffDelay(base, max, attempt) {
  const exp = Math.min(base * 2 ** attempt, max);
  // Full jitter: uniform random in [0, exp].
  return Math.floor(Math.random() * exp);
}

/**
 * @param {string | null} header
 * @returns {number | null}
 */
function parseRetryAfter(header) {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * @param {Response} res
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function readResponseText(res, signal) {
  throwIfAborted(signal);
  if (!res.body || typeof res.body.getReader !== "function") {
    if (typeof res.text === "function") return withAbort(res.text(), signal);
    return "";
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const onAbort = () => {
    try { reader.cancel(abortReason(signal)); } catch {}
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (err) {
    if (signal?.aborted) throw abortReason(signal, errorForAbort(err));
    throw err;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch {}
  }
}

/**
 * Whether a provider honors GLM preserved thinking (`reasoning_content` on an
 * assistant message echoed back across turns). z.ai's Coding Plan endpoint has
 * preserved thinking enabled by default and returns `reasoning_content` every
 * turn expecting it back verbatim. Other OpenAI-compatible backends (Nous,
 * Ollama, custom shims) may reject the unknown field, so we strip by default.
 *
 * Override with LAZYGLM_PRESERVE_THINKING=auto|on|off (see shouldPreserveThinking).
 *
 * @param {Provider | null | undefined} provider
 * @returns {boolean}
 */
export function supportsPreservedThinking(provider) {
  return provider === "zai";
}

/**
 * Resolve the preserved-thinking policy from env override or provider default.
 *   auto (default) → supportsPreservedThinking(provider)
 *   on             → always keep (force keep on unsupported providers / shims)
 *   off            → always strip (force strip on zai-compatible endpoints)
 *
 * @param {Provider | null | undefined} provider
 * @returns {boolean}
 */
export function shouldPreserveThinking(provider) {
  const override = (process.env.LAZYGLM_PRESERVE_THINKING || "auto").trim().toLowerCase();
  if (override === "on") return true;
  if (override === "off") return false;
  return supportsPreservedThinking(provider);
}

/**
 * Return a copy of `messages` with `reasoning_content` removed when the
 * provider should not receive it. The original array (the live Context) is
 * never mutated — reasoning is stored in context + session regardless of
 * provider, and only stripped from the outgoing wire payload.
 *
 * @param {ChatMessage[]} messages
 * @param {boolean} preserveThinking
 * @returns {ChatMessage[]}
 */
function messagesForProvider(messages, preserveThinking) {
  if (preserveThinking) return messages;
  return messages.map((m) => {
    if (!m.reasoning_content) return m;
    const { reasoning_content, ...rest } = m;
    return rest;
  });
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
 * @param {ChatOptions} opts
 * @returns {Promise<ChatCompletion>}
 */
export async function chat({ model, messages, tools, temperature, config, reasoningEffort, onDelta, onRetry, signal }) {
  const cfg = config || await resolveProviderConfig();
  const url = `${cfg.baseURL}/chat/completions`;
  const wantStream = typeof onDelta === "function";
  // GLM preserved thinking: z.ai expects reasoning_content echoed back; other
  // backends may reject it. Strip it from the outgoing payload unless this
  // provider honors it (or LAZYGLM_PRESERVE_THINKING forces keep). The live
  // Context keeps reasoning_content regardless — only the wire payload changes.
  const preserveThinking = shouldPreserveThinking(cfg.provider);
  const sendMessages = messagesForProvider(messages, preserveThinking);
  const requestEffort = reasoningEffort || cfg.reasoningEffort || "high";
  /** @type {ChatRequestBody} */
  const body = {
    model: model || cfg.modelId,
    messages: sendMessages,
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
  const thinking = thinkingControlForRequest({
    provider: cfg.provider,
    reasoningEffort: requestEffort,
    preserveThinking,
  });
  if (thinking) {
    body.thinking = thinking;
    // z.ai distinguishes thinking on/off (thinking.type) from the effort level
    // (top-level reasoning_effort). For enabled turns, send the advertised effort
    // on the wire so routing and /status match the actual request — but only for
    // models that support it (GLM-5.2+). Older models reject reasoning_effort,
    // and the 400 fallback would strip the entire thinking block, losing
    // turn-level thinking control for that model.
    if (thinking.type === "enabled" && supportsReasoningEffort(cfg.modelId)) body.reasoning_effort = requestEffort;
  }

  /**
   * @param {ChatRequestBody} requestBody
   * @returns {RequestInit}
   */
  const initForBody = (requestBody) => ({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  let res;
  try {
    res = await fetchWithRetry(url, initForBody(body), { timeout: cfg.timeout, maxRetries: cfg.maxRetries, onRetry, signal });
  } catch (err) {
    if (
      err instanceof ProviderHttpError &&
      err.status === 400 &&
      cfg.provider === "zai" &&
      body.thinking
    ) {
      const { thinking: _thinking, reasoning_effort: _effort, ...fallbackBody } = body;
      onRetry?.({
        attempt: 1,
        reason: "z.ai thinking control rejected with HTTP 400; retrying without thinking",
        delay: 0,
      });
      res = await fetchWithRetry(url, initForBody(fallbackBody), { timeout: cfg.timeout, maxRetries: cfg.maxRetries, onRetry, signal });
    } else {
      throw err;
    }
  }

  if (!wantStream) {
    const data = (!res.body && typeof res.json === "function")
      ? await withAbort(res.json(), signal)
      : JSON.parse(await readResponseText(res, signal));
    return parseCompletion(data);
  }

  // ---- Streaming path: parse SSE ----
  return parseSSEStream(res, /** @type {(delta: StreamDelta) => void} */ (onDelta), signal);
}

/**
 * Parse a non-streaming completion response into the unified shape.
 *
 * @param {unknown} data
 * @returns {ChatCompletion}
 */
function parseCompletion(data) {
  const completion = /** @type {OpenAIResponse} */ (data);
  const choice = completion?.choices?.[0];
  if (!choice) {
    throw new Error(`GLM provider returned no choices: ${JSON.stringify(data).slice(0, 500)}`);
  }
  const msg = choice.message || {};
  return {
    content: typeof msg.content === "string" ? msg.content : null,
    reasoning: typeof msg.reasoning_content === "string" ? msg.reasoning_content : null,
    tool_calls: normalizeToolCalls(msg.tool_calls),
    raw: data,
    usage: completion.usage || null,
  };
}

/**
 * @param {unknown} rawToolCalls
 * @returns {ToolCall[] | null}
 */
function normalizeToolCalls(rawToolCalls) {
  if (!Array.isArray(rawToolCalls) || !rawToolCalls.length) return null;
  return rawToolCalls.map((raw, i) => {
    const tc = /** @type {OpenAIToolCall} */ (raw);
    const fn = tc.function || {};
    /** @type {Record<string, unknown>} */
    let args = {};
    try {
      args = fn.arguments ? /** @type {Record<string, unknown>} */ (JSON.parse(fn.arguments)) : {};
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
 *
 * @param {Response} res
 * @param {(delta: StreamDelta) => void} onDelta
 * @param {AbortSignal} [signal]
 * @returns {Promise<ChatCompletion>}
 */
async function parseSSEStream(res, onDelta, signal) {
  const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    try { reader.cancel(abortReason(signal)); } catch {}
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  let content = "";
  let reasoning = "";
  /** @type {Map<number, StreamToolCallAccumulator>} */
  const toolCalls = new Map();
  /** @type {string | null} */
  let finishReason = null;
  /** @type {ChatUsage | null} */
  let usage = null;

  /** @param {string} line */
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) return; // blank or comment
    if (!trimmed.startsWith("data:")) return; // ignore event:/id: lines
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return;
    /** @type {OpenAIResponse} */
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
      for (const rawTc of delta.tool_calls) {
        const tc = /** @type {OpenAIStreamToolCallDelta} */ (rawTc);
        const idx = typeof tc.index === "number" ? tc.index : 0;
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
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
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
    if (signal?.aborted) throw abortReason(signal, errorForAbort(err));
    throw new Error(`GLM stream interrupted: ${errorMessage(err)}. Partial content may have been received (${content.length} chars).`);
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch {}
  }

  onDelta({ type: "done", finish_reason: finishReason });

  /** @type {ToolCall[]} */
  const calls = [];
  for (const [, tc] of [...toolCalls].sort((a, b) => a[0] - b[0])) {
    /** @type {Record<string, unknown>} */
    let args = {};
    try {
      args = tc.args ? /** @type {Record<string, unknown>} */ (JSON.parse(tc.args)) : {};
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

/**
 * @param {unknown} text
 * @param {number} max
 * @returns {string}
 */
function truncateBody(text, max) {
  const s = String(text ?? "");
  return s.length <= max ? s : s.slice(0, max) + "…";
}

/**
 * List models at the configured provider (for `doctor`).
 *
 * @param {ProviderConfig} [config]
 * @returns {Promise<string[]>}
 */
export async function listModels(config) {
  const cfg = config || await resolveProviderConfig();
  const url = `${cfg.baseURL}/models`;
  /** @type {Record<string, string>} */
  const headers = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const res = await fetchWithRetry(url, { headers }, { timeout: cfg.timeout, maxRetries: cfg.maxRetries });
  if (!res.ok) throw new Error(`list models failed: ${res.status}`);
  const data = /** @type {OpenAIResponse} */ (await res.json());
  return /** @type {string[]} */ ((data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean));
}
