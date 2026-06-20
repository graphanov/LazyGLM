---
name: ulw-plan
description: "Write a decision-complete implementation plan to plans/<slug>.md before any product code."
---

# ulw-plan

## When to use
`$ulw-plan "<what to build>"` when the work needs decisions before implementation. It never writes product code.

## Procedure
1. Read the relevant parts of the codebase (entrypoints, the files the task touches).
2. Write `plans/<slug>.md` with a markdown checklist:
   - **Goal** — one sentence.
   - **Architecture** — 2-4 sentences + the files you will touch.
   - **Tasks** — `- [ ]` items, each a small verifiable step.
   - **Verification** — exact commands/conditions that prove done.
   - **Risks** — what could go wrong and the mitigation.
3. Do NOT write or modify product code. Only the plan file.
4. Call `finish` with the plan path and a one-line summary.

## Rule
A plan is decision-complete when a worker could execute it without making further design choices.
