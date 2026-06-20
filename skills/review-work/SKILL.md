---
name: review-work
description: "Multi-angle post-implementation review of a completed slice."
---

# review-work

## When to use
After a slice is implemented, before declaring done. `$review-work` checks it from several angles.

## Angles
1. **Correctness** — does it do what the task asked? Trace the behavior.
2. **Edge cases** — empty input, large input, failure paths.
3. **Tests** — are they meaningful (not tautological)? Do they pass?
4. **Cleanliness** — no AI-slop comments, no dead code, no leftover debug.
5. **Integration** — does it break existing behaviour? Run the full build/test.

## Output
A short verdict per angle (PASS/FAIL/NOTE) with file:line evidence for any FAIL. If any FAIL, do not call `finish` — fix first.
