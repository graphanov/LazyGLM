# npm trusted publishing

LazyGLM publishes to npm through GitHub Actions trusted publishing. The repo-side workflow is `.github/workflows/publish-npm.yml`; it uses GitHub OIDC (`id-token: write`) and `npm publish --provenance`, with no long-lived `NPM_TOKEN` secret.

## One-time npm setup

The package already exists on npm, so trusted publishing can be configured on the package access page.

On npmjs.com, as a package owner, configure:

- Package: `lazyglm`
- Trusted publisher provider: GitHub Actions
- Owner / organization: `graphanov`
- Repository: `LazyGLM`
- Workflow filename: `publish-npm.yml`
- Environment: leave blank
- Action: `npm publish`

If the workflow fails with `E404 Not Found - PUT https://registry.npmjs.org/lazyglm`, the repo workflow reached npm but the npm-side trusted publisher is not configured or does not match these fields.

## Release publish flow

Publishing is a release gate, not a normal PR side effect.

From a clean `main` after the version bump has merged:

```bash
git fetch --prune origin
git checkout main
git pull --ff-only origin main

version="$(node -p "require('./package.json').version")"
npm view lazyglm version dist-tags --json
npm test
node bin/lazyglm.js --version
npm pack --dry-run

gh workflow run publish-npm.yml \
  --repo graphanov/LazyGLM \
  -f expected-version="$version" \
  -f npm-tag=latest
```

Watch the workflow:

```bash
gh run list --repo graphanov/LazyGLM --workflow publish-npm.yml --limit 3
gh run watch --repo graphanov/LazyGLM <run-id>
```

Then verify the public package:

```bash
npm view lazyglm version dist-tags provenance --json
npx --yes lazyglm@"$version" --version
```

Only after registry verification should the matching GitHub Release be created or updated as Latest.

## Workflow gates

The workflow validates before publishing:

- GitHub token has only `contents: read` plus OIDC `id-token: write`;
- Node 24 is used;
- npm is upgraded to a trusted-publishing-capable version;
- `npm test` passes;
- `node bin/lazyglm.js --version` works;
- `npm pack --dry-run` succeeds;
- `package.json` version matches the manual `expected-version` input;
- the exact package version is not already published.

## No token fallback by default

Do not add `NPM_TOKEN` as the primary path. If trusted publishing is blocked, fix the npm-side trusted publisher configuration. Manual passkey/device-flow publish is only a break-glass path for owner-approved releases.
