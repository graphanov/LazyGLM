// GLM provider: speaks the OpenAI Chat Completions schema with tool calling.
// Defaults to Ollama's OpenAI-compatible endpoint (keyless, local). Any
// OpenAI-compatible host (Z.ai, OpenRouter, OpenAI) works via env vars.
//
//   LAZYGLM_BASE_URL  e.g. http://localhost:11434/v1   (default)
//   LAZYGLM_API_KEY   bearer token (Ollama ignores it; others require it)
//   LAZYGLM_MODEL     override the catalog default model
//   LAZYGLM_TIMEOUT   request timeout in ms (default 600000 = 10m for long reasoning)

const DEFAULT_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_TIMEOUT = 600_000;

export function resolveProviderConfig(options = {}) {
  const baseURL = (options.baseURL || process.env.LAZYGLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  const apiKey = options.apiKey || process.env.LAZYGLM_API_KEY || "ollama";
  const model = options.model || process.env.LAZYGLM_MODEL;
  const timeout = Number(options.timeout || process.env.LAZYGLM_TIMEOUT || DEFAULT_TIMEOUT);
  return { baseURL, apiKey, model, timeout };
}

/**
 * Send a chat completion request to the GLM provider.
 * @param {object} opts
 * @param {string} opts.model
 * @param {Array}  opts.messages  OpenAI messages
 * @param {Array}  [opts.tools]   OpenAI function/tool specs
 * @param {number} [opts.temperature]
 * @param {object} [opts.config]  provider config (from resolveProviderConfig)
 * @returns {Promise<{content: string|null, tool_calls: Array|null, raw: object}>}
 */
export async function chat({ model, messages, tools, temperature, config }) {
  const cfg = config || resolveProviderConfig();
  const url = `${cfg.baseURL}/chat/completions`;
  const body = {
    model,
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
      throw new Error(`GLM request timed out after ${cfg.timeout}ms (model=${model}). Is the model loaded?`);
    }
    throw new Error(`GLM request failed: ${err?.message || err}. base=${cfg.baseURL}. Is Ollama running? Try: ollama serve`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GLM provider error ${res.status}: ${truncateBody(text, 800)} (model=${model}, url=${url})`);
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
 * Probe the provider: list models (for `doctor`).
 */
export async function listModels(config) {
  const cfg = config || resolveProviderConfig();
  const url = `${cfg.baseURL}/models`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!res.ok) throw new Error(`list models failed: ${res.status}`);
  const data = await res.json();
  return (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
}
