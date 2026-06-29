// z.ai documents thinking mode as a first-class chat-completions control:
// https://docs.z.ai/guides/capabilities/thinking-mode
//
// LazyGLM's catalog currently exposes role-level reasoning effort, while z.ai's
// request shape is a binary turn-level toggle. This mapper intentionally keeps
// the first provider slice binary: low disables thinking; medium/high/max enable
// it. It does not add an "off" ReasoningEffort value.

import type { Provider, ReasoningEffort } from "../types/index.js";

export type ThinkingControl = { type: "disabled" } | { type: "enabled"; clear_thinking?: false };

interface ThinkingControlOptions {
  provider?: Provider | null;
  reasoningEffort?: ReasoningEffort | null;
  preserveThinking?: boolean;
}

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
export function thinkingControlForRequest({
  provider,
  reasoningEffort,
  preserveThinking = false,
}: ThinkingControlOptions = {}): ThinkingControl | null {
  if (provider !== "zai") return null;
  if (reasoningEffort === "low") return { type: "disabled" };
  const control: ThinkingControl = { type: "enabled" };
  if (preserveThinking) control.clear_thinking = false;
  return control;
}

// z.ai documents reasoning_effort as supported by GLM-5.2 and above only:
// https://docs.z.ai/guides/capabilities/thinking#core-parameters
// Older models (glm-4.7, glm-4.7-flash) reject the field, triggering a 400
// whose fallback drops the entire thinking block — losing turn-level thinking.
// Extract the numeric major.minor from a canonical model name (e.g. "glm-5.2",
// "glm-4.7-flash") and compare against the 5.2 floor.
const REASONING_EFFORT_FLOOR = [5, 2];

/**
 * Whether a given model supports z.ai's top-level `reasoning_effort` field.
 * Returns false for any non-matching name so the field is only sent when the
 * active model is GLM-5.2 or above.
 *
 * @param {string} modelId - canonical model name (e.g. "glm-5.2", "glm-4.7")
 * @returns {boolean}
 */
export function supportsReasoningEffort(modelId: string | null | undefined): boolean {
  const match = String(modelId || "").match(/(\d+)\.(\d+)/);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major !== REASONING_EFFORT_FLOOR[0]) return major > REASONING_EFFORT_FLOOR[0];
  return minor >= REASONING_EFFORT_FLOOR[1];
}
