// Hook input/output shapes — mirrors the Codex/OMO hook protocol so the
// original component behaviours transfer directly.
import type { HookEventName, HookInput, HookMeta, HookResult } from "../types/index.js";

export const HOOK_EVENTS: HookEventName[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "PostCompact",
];

// Build a canonical hook input object. Callers pass the event-specific fields;
// the engine fills session/cwd/model metadata.
export function buildHookInput(event: HookEventName, fields: Record<string, unknown>, meta: HookMeta): HookInput {
  return {
    session_id: meta.sessionId,
    turn_id: meta.turnId,
    transcript_path: meta.transcriptPath ?? null,
    cwd: meta.cwd,
    hook_event_name: event,
    model: meta.model,
    permission_mode: meta.permissionMode ?? "auto",
    ...fields,
  };
}

// A hook handler may return:
//   undefined / null           -> pass-through
//   { decision: "block", reason } -> block (PreToolUse skips tool; PostToolUse feeds back)
//   { decision: "approve" }       -> explicit approve (no-op for now)
//   { inject: "text" }            -> inject context into the system prompt / message
//   { feedback: "text" }          -> surface a non-blocking note to the model
export function isBlock(result: HookResult): result is { decision: "block"; reason?: string } {
  return Boolean(result && "decision" in result && result.decision === "block");
}

// Parse a JSON hook output string (for the `lazyglm hook <event>` CLI bridge,
// which speaks the same stdin/stdout JSON contract as the original).
export function parseHookOutput(text: string): HookResult {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text) as HookResult;
  } catch {
    return null;
  }
}

export function serializeHookOutput(obj: HookResult): string {
  if (!obj) return "";
  return JSON.stringify(obj);
}
