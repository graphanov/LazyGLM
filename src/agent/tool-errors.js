// @ts-check

/**
 * Shared classifier for tool result strings that should be treated as failed
 * tool executions by runtime and adaptive REPL routing.
 *
 * @param {string | null | undefined} resultStr
 * @returns {boolean}
 */
export function isToolErrorResult(resultStr) {
  return /^Error(?::| executing\b)/i.test(resultStr || "") || /^Command exited\b/i.test(resultStr || "");
}
