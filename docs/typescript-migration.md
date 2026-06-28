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

#### PR-B1 — model router boundary

The first boundary rollout is intentionally limited to `src/agent/router.js`:

- `tsconfig.json` enables `allowJs` so selected JavaScript files can join the program.
- `checkJs` remains disabled globally.
- `include` adds only `src/agent/router.js` beside `src/**/*.ts`.
- `src/agent/router.js` uses file-level `// @ts-check` plus JSDoc contracts for the model catalog, route options, resolved route, provider config entry, and persisted config fields it reads.

The provider/runtime/tools boundary remains deferred. A local all-boundary smoke currently pulls transitive JavaScript errors from context/deadline/runtime/hooks code, so broad `@ts-check` would be noisy and out of scope for this slice. Future PRs should continue the same pattern: measure one boundary, annotate it narrowly, then add it to the configured typecheck surface only when clean.

#### PR-B2 — provider boundary

The second boundary rollout adds `src/agent/provider.js` to the configured typecheck surface:

- `checkJs` remains disabled globally.
- `include` adds only `src/agent/provider.js` beside the existing router boundary and TypeScript contract files.
- `src/agent/provider.js` uses file-level `// @ts-check`, shared contract imports for provider config, chat completions, stream deltas, tool calls, tool specs, and usage, plus local typedefs for OpenAI-compatible wire JSON.
- The provider boundary now checks `resolveProviderConfig`, `chat`, non-streaming completion normalization, SSE delta parsing, retry callback payloads, and model listing without changing provider behavior or adding a build step.
- The shared `ToolCall` contract admits the existing OpenAI-compatible `type: "function"` field returned by provider normalization.

The runtime/tools/hooks boundary remains deferred. This PR intentionally keeps package behavior unchanged: no `.js -> .ts` conversion, no `dist/`, no CLI shim changes, and no package version or publish-flow changes.

#### PR-B3 — runtime/tools boundary

The third boundary rollout adds the two remaining named core runtime boundary files, `src/agent/runtime.js` and `src/agent/tools.js`, to the configured typecheck surface:

- `checkJs` remains disabled globally.
- `include` adds only `src/agent/runtime.js` and `src/agent/tools.js` beside the existing router/provider boundary and TypeScript contract files.
- Both files use file-level `// @ts-check` plus JSDoc imports from `src/types/index.ts`.
- `src/agent/runtime.js` now checks `runAgent` inputs/results, hook-engine usage, tool execution records, token accounting, finish-tool narrowing, and error-message extraction.
- `src/agent/tools.js` now checks the OpenAI tool spec array, handler context, handler argument shapes, shell/grep error narrowing, and grep fallback helpers.

The measured pragma-on budget for this slice was 103 local type errors across runtime/tools. The fixes are JSDoc annotations, typed accumulators, zero-cost casts, and local narrowing helpers; no `@ts-ignore`, `.js -> .ts` conversion, build step, CLI shim change, package version change, or runtime behavior change is part of this rollout.

### Phase 1 — build pipeline infrastructure

The first migration phase adds the compiled package pipeline without converting runtime modules:

- `tsconfig.json` emits ESM output to `dist/`.
- `allowJs` stays enabled and `checkJs` stays disabled, so all current JavaScript runtime modules compile as-is.
- `npm run build` runs `tsc`; `npm test` runs the build first through `pretest`.
- `bin/lazyglm.js` stays as the published executable shim, but imports `dist/cli.js`.
- `package.json` ships `dist/` instead of `src/`.

This phase intentionally does not convert `.js` files to `.ts`, add a bundler, change CLI behavior, or touch version/publish flow. Follow-up phases can convert modules against a working package pipeline.

`dist/types/index.js` is expected output. The source file is type-only, so the emitted runtime file contains only `export {};`. It is harmless package dead weight for now and should not be treated as a failed exclude rule.

## Deferred decisions

These remain outside the Phase 1 build-pipeline work and the current boundary slices:

- enabling `checkJs` globally;
- converting provider/router/runtime/tools/hooks files to `.ts`;
- typechecking additional JavaScript boundaries beyond the current router/provider/runtime/tools surface;
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
