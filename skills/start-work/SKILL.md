---
name: start-work
description: "Execute a plan checklist until every box is checked, with durable progress."
---

# start-work

## When to use
`$start-work [plan-name]` when a plan is ready. It executes the checklist and stops only when the plan is complete.

## Procedure
1. Load `plans/<slug>.md` (or `.lazyglm/active-plan.json`). Write the active-plan pointer.
2. For each unchecked `- [ ]` item, in order:
   - Read what you need, make the change, verify (build/test).
   - Mark it `- [x]` in the plan file (durable progress — survives restarts).
3. If a step fails verification, fix it before moving on.
4. When all items are checked, call `finish` and print **ORCHESTRATION COMPLETE**.

## Durability
Progress lives in the plan file itself. If the session ends early, the next `$start-work` resumes from the first unchecked item (the `start-work-continuation` hook surfaces this).
