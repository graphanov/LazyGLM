// GLM provider: speaks the OpenAI Chat Completions schema with tool calling.
//
// DEFAULT: the Nous Research inference API (https://inference-api.nousresearch.com/v1)
// serving z-ai/glm-5.2 — the frontier GLM model. Requires LAZYGLM_API_KEY.
//
// To use a different backend:
//   LAZYGLM_PROVIDER=ollama           local Ollama (keyless, http://localhost:11434/v1)
//   LAZYGLM_PROVIDER=zai              Zhipu z.ai (api.z.ai/api/paas/v4, key required)
//   LAZYGLM_PROVIDER=nous             explicit Nous (default)
//   LAZYGLM_BASE_URL=<url>            any custom OpenAI-compatible endpoint
//   LAZYGLM_API_KEY=<key>             bearer token (required for nous/zai/custom; ignored by ollama)
//   LAZYGLM_MODEL=<name>              override the catalog default model
//   LAZYGLM_TIMEOUT=<ms>              request timeout (default 600000)

import { pickModel, getProviderConfig, resolveProvider } from "./router.js";

const DEFAULT_TIMEOUT = 600_000;
const OLLAMA_BASE = "http://localhost:11434/v1";
const NOUS_BASE = "https://inference-api.nousresearch.com/v1";

/**
 * Resolve the full provider config: base_url, api_key, timeout, and the
 * provider-specific model ID. This is the single entry point the runtime uses.
 *
 * @param {object} options - { model?, provider?, role? }
 * @returns {Promise<{baseURL, apiKey, modelId, model, provider, role, timeout}>}
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
    baseURL = process.env.LAZYGLM_BASE_URL?.replace(/\/$/, "") || "https://api.z.ai/api/paas/v4";
    requiresKey = true;
  } else {
    // custom
    baseURL = (process.env.LAZYGLM_BASE_URL || "").replace(/\/$/, "");
    requiresKey = !!process.env.LAZYGLM_API_KEY;
  }

  const apiKey = process.env.LAZYGLM_API_KEY || (requiresKey ? "" : "ollama");
  const timeout = Number(process.env.LAZYGLM_TIMEOUT || DEFAULT_TIMEOUT);

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
  };
}

/**
 * Send a chat completion request to the GLM provider.
 * @param {object} opts
 * @param {string} opts.model     provider-specific model ID (e.g. z-ai/glm-5.2)
 * @param {Array}  opts.messages  OpenAI messages
 * @param {Array}  [opts.tools]   OpenAI function/tool specs
 * @param {number} [opts.temperature]
 * @param {object} [opts.config]  provider config (from resolveProviderConfig)
 * @returns {Promise<{content: string|null, tool_calls: Array|null, raw: object, usage: object|null}>}
 */
export async function chat({ model, messages, tools, temperature, config }) {
  const cfg = config || await resolveProviderConfig();
  const url = `${cfg.baseURL}/chat/completions`;
  const body = {
    model: model || cfg.modelId,
    messages,
    temperature: temperature ?? 0.6,
    stream: false,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeout);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const name = err?.name;
    if (name === "AbortError") {
      throw new Error(`GLM request timed out after ${cfg.timeout}ms (model=${body.model}). Is the model loaded / endpoint reachable?`);
    }
    const hint = cfg.provider === "ollama" ? "Is Ollama running? Try: ollama serve" : `Is ${cfg.baseURL} reachable?`;
    throw new Error(`GLM request failed: ${err?.message || err}. ${hint}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new Error(`GLM auth error ${res.status}: ${truncateBody(text, 400)}\nYour LAZYGLM_API_KEY may be invalid or out of funds. Check https://portal.nousresearch.com`);
    }
    throw new Error(`GLM provider error ${res.status}: ${truncateBody(text, 800)} (model=${body.model}, url=${url})`);
  }

  const data = await res.json();
  const choice = data?.choices?.[0];
  if (!choice) {
    throw new Error(`GLM provider returned no choices: ${JSON.stringify(data).slice(0, 500)}`);
  }
  const msg = choice.message || {};
  let toolCalls = null;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    toolCalls = msg.tool_calls.map((tc, i) => {
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
  return {
    content: typeof msg.content === "string" ? msg.content : null,
    tool_calls: toolCalls,
    raw: data,
    usage: data.usage || null,
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
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`list models failed: ${res.status}`);
  const data = await res.json();
  return (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
}
