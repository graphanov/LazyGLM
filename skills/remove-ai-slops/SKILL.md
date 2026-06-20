---
name: remove-ai-slops
description: "Behavior-preserving cleanup of AI-looking code: slop comments, dead code, tautological tests."
---

# remove-ai-slops

## When to use
`$remove-ai-slops` after generating code, to strip the tells that mark it as machine-written without changing behavior.

## Targets
- **Narration comments** — "// here we set x" above `x = 1`. Remove.
- **Placeholder TODOs** — "// TODO: implement". Implement or remove.
- **Restate-the-code comments** — comments that duplicate the line below. Remove.
- **Dead code** — unused imports, unreachable branches, commented-out blocks. Remove.
- **Tautological tests** — `expect(add(2,2)).toBe(4)` is fine; `expect(true).toBe(true)` is not.
- **AI-isms** — "let's", "as an AI", "we will now", emoji in comments. Remove.

## Rule
Behavior-preserving only. After cleanup, the build/tests must still pass. Verify before finishing.
