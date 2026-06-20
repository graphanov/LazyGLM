---
name: init-deep
description: "Generate hierarchical project memory (AGENTS.md) so future GLM sessions have landmarks before they edit."
---

# init-deep

## When to use
Run `$init-deep` when a project is too large to explain from memory, or when its shape has changed. It produces hierarchical `AGENTS.md` context that the `rules` plugin injects into every later session.

## Procedure
1. Walk the project tree (skip `node_modules`, `.git`, build output).
2. Score each directory by file count + presence of entrypoints (`index.*`, `main.*`, `package.json`, `Cargo.toml`, etc.).
3. For high-score directories, write a local `AGENTS.md` describing: purpose, key files, conventions, gotchas.
4. Write/update the root `AGENTS.md` with a top-level map linking to the local guides.
5. Keep entries terse — landmarks, not essays. Future agents need orientation, not narration.

## Output
- Root `AGENTS.md` with a directory map.
- Local `AGENTS.md` files near complex directories.

Call `finish` with the list of files written.
