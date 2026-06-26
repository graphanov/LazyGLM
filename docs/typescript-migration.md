# TypeScript migration

LazyGLM launched as plain Node ESM JavaScript on purpose: v0.1 needed direct execution, a small package surface, no build step, and easy autonomous edits while the GLM-native agent loop was still changing quickly.

Now the runtime has stable contract-heavy boundaries where drift is expensive: provider/model routing, streaming deltas, tool-call schemas, hook events, session records, permission modes, and token/reasoning usage accounting. TypeScript should harden those contracts without turning the package into a big-bang rewrite.

## Migration shape

The migration is split into small PRs.

### PR-A — contracts and CI only

This PR adds the TypeScript contract spine and the CI gate without checking JavaScript yet:

- `src/types/index.ts` defines shared runtime contracts.
- `tsconfig.json` includes only `src/**/*.ts`.
- `npm run typecheck` runs `tsc --noEmit` against TypeScript files only.
- CI installs development dependencies and runs `npm run typecheck` before tests.

This intentionally avoids `// @ts-check`, `.js -> .ts` conversion, `dist/`, bundling, package `files` changes, and runtime imports from the type file.

Why: the contract PR should be mechanically safe and green before typechecking existing JavaScript. It creates a stable target for follow-up JSDoc or module-conversion PRs without mixing type declarations with annotation noise.

### PR-B — boundary rollout

A later PR should typecheck one runtime boundary at a time using the least noisy option for the file:

- selective JSDoc on the specific function or object being hardened;
- file-level `// @ts-check` only after local noise is measured;
- `// @ts-nocheck` or narrower typed regions when a file is not ready;
- `.js -> .ts` conversion only when packaging and import paths are explicitly planned.

Before wiring CI for any boundary rollout, run the local smoke first and record the noise budget:

```bash
npm run typecheck
```

If a boundary file is being opted into checking, run the same command locally after adding its JSDoc/pragma and before opening the PR. CI should confirm known-clean typechecking, not discover a large untriaged backlog.

## Deferred decisions

These are intentionally not part of PR-A:

- enabling `checkJs` globally;
- converting provider/router/runtime/tools/hooks files to `.ts`;
- adding a `dist/` build step;
- changing `bin/lazyglm.js`;
- changing `package.json` `files`, `bin`, `engines`, or version;
- changing runtime behavior, model routing, hook semantics, tool calls, REPL UX, sessions, or publishing flow.

## Package compatibility

`src/types/index.ts` is included under the existing `src` package allowlist. It is type-only and has no runtime imports, so `npx lazyglm`, global installs, and direct Node execution remain unchanged. If later PRs add compiled output, `npm pack --dry-run` must prove the shipped CLI and runtime files are still correct.

## Verification for PR-A

```bash
npm install --no-package-lock
npm run typecheck
npm test
node bin/lazyglm.js --version
npm pack --dry-run
```

The `--no-package-lock` flag is for local smoke in this repo, which currently has no lockfile. CI uses a clean ephemeral install before typechecking.
