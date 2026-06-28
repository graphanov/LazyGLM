// @ts-check

// z.ai documents thinking mode as a first-class chat-completions control:
// https://docs.z.ai/guides/capabilities/thinking-mode
//
// LazyGLM's catalog currently exposes role-level reasoning effort, while z.ai's
// request shape is a binary turn-level toggle. This mapper intentionally keeps
// the first provider slice binary: low disables thinking; medium/high/max enable
// it. It does not add an "off" ReasoningEffort value.

/**
 * @typedef {import("../types/index.js").Provider} Provider
 * @typedef {import("../types/index.js").ReasoningEffort} ReasoningEffort
 * @typedef {{ type: "disabled" } | { type: "enabled", clear_thinking?: false }} ThinkingControl
 */

/**
 * Convert LazyGLM's active route effort into z.ai's request-level thinking
 * control. Other OpenAI-compatible providers never receive this z.ai-native
 * extension.
 *
 * @param {object} [options]
 * @param {Provider | null} [options.provider]
 * @param {ReasoningEffort | null} [options.reasoningEffort]
 * @param {boolean} [options.preserveThinking]
 * @returns {ThinkingControl | null}
 */
export function thinkingControlForRequest({ provider, reasoningEffort, preserveThinking = false } = {}) {
  if (provider !== "zai") return null;
  if (reasoningEffort === "low") return { type: "disabled" };
  const control = /** @type {{ type: "enabled", clear_thinking?: false }} */ ({ type: "enabled" });
  if (preserveThinking) control.clear_thinking = false;
  return control;
}
