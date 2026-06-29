/**
 * Shared classifier for tool result strings that should be treated as failed
 * tool executions by runtime and adaptive REPL routing.
 */
export function isToolErrorResult(resultStr: string | null | undefined): boolean {
  return (
    /^Error(?::| executing\b)/i.test(resultStr || "") ||
    /^Command exited\b/i.test(resultStr || "") ||
    /^Blocked by hook\b/i.test(resultStr || "") ||
    /\[hook feedback — address\]/i.test(resultStr || "")
  );
}
