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

### Phase 1 — build pipeline infrastructure

The first migration phase adds the compiled package pipeline without converting runtime modules:

- `tsconfig.json` emits ESM output to `dist/`.
- `allowJs` stays enabled and `checkJs` stays disabled, so all current JavaScript runtime modules compile as-is.
- `npm run build` runs `tsc`; `npm test` runs the build first through `pretest`.
- `bin/lazyglm.js` stays as the published executable shim, but imports `dist/cli.js`.
- `package.json` ships `dist/` instead of `src/`.

This phase intentionally does not convert `.js` files to `.ts`, add a bundler, change CLI behavior, or touch version/publish flow. Follow-up phases can convert modules against a working package pipeline.

`dist/types/index.js` is expected output. The source file is type-only, so the emitted runtime file contains only `export {};`. It is harmless package dead weight for now and should not be treated as a failed exclude rule.

### Phase 2 — agent boundary TypeScript modules

The second migration phase converts the contract-heavy agent boundary modules to TypeScript while preserving NodeNext `.js` import specifiers in source:

- `src/agent/provider.ts`
- `src/agent/router.ts`
- `src/agent/runtime.ts`
- `src/agent/tools.ts`
- `src/agent/tool-errors.ts`
- `src/agent/adaptive-router.ts`

These modules now consume shared contracts from `src/types/index.ts` directly. Provider wire JSON remains module-private typed data, and out-of-scope support modules (`context.js`, `deadline.js`, `thinking.js`) remain JavaScript compiled by the Phase 1 `allowJs` pipeline.

Tests that exercise converted boundaries import from `dist/` after `npm run build`, matching the package runtime boundary used by `bin/lazyglm.js`.

## Deferred decisions

These remain outside the Phase 1/2 work:

- enabling `checkJs` globally;
- converting agent support, hooks, config, MCP, plugin, installer, CLI, REPL, or test files to `.ts`;
- typechecking additional JavaScript boundaries beyond the current converted agent boundary surface;
- source maps for compiled stack traces;
- changing `package.json` `engines` or version;
- changing runtime behavior, model routing, hook semantics, tool calls, REPL UX, sessions, or publishing flow.

## Package compatibility

The npm package now runs through the compiled `dist/` output while keeping the executable path stable at `bin/lazyglm.js`. `npx lazyglm` and global installs still use the same bin name, and source checkouts must run `npm run build` before invoking `node bin/lazyglm.js ...`.

Because `dist/` is gitignored but listed in `package.json` `files`, `npm pack --dry-run` must prove the shipped CLI and runtime files are still correct.

## Verification

```bash
npm install --no-package-lock
npm run build
npm run typecheck
npm test
node bin/lazyglm.js --version
npm pack --dry-run
```

The `--no-package-lock` flag is for local smoke in this repo, which currently has no lockfile. CI uses a clean ephemeral install before typechecking.
