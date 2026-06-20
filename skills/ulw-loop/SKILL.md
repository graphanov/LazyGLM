---
name: ulw-loop
description: "Self-referential loop that runs until the task is Oracle-verified complete."
---

# ulw-loop

## When to use
`$ulw-loop "<task>" --completion-promise="<what done means>"` when the task should keep moving until the result is verified by evidence, not a hopeful status update.

## Contract
- The completion promise is an objective, checkable condition (e.g. "`npm test` passes and the server returns 200").
- The loop runs the agent, then independently verifies the claim (claimed files exist + optional `--verify` command passes).
- Only a verified PASS exits the loop. A failed verify feeds the failure back and continues.
- Bounded by `--max-iterations` (default 4) to prevent runaway.

## Procedure
1. State the completion promise explicitly.
2. Work in verifiable steps. Run builds/tests.
3. Call `finish` only with concrete evidence (passing output, existing files).
4. If the verifier rejects, read its reason and address the specific failure.

## No false finishes
A verbal "I'm done" with no passing verification is a protocol failure, not a finish.
