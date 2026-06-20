# Pull request review process

LazyGLM uses a small repo-native PR process. The goal is review discipline without committing local planning systems, active/done plan folders, raw run logs, or private operating notes.

## Source of truth

- GitHub PRs are the public review surface.
- GitHub Actions `ci` is the required automated gate.
- Codex review is the required AI review gate for non-draft PRs.
- Human/owner approval remains the merge gate.
- Local development notes stay local and untracked.

## Local-only development notes

Use untracked/local locations for scratch plans, task lists, transcripts, model notes, or run evidence:

- `.lazyglm/` inside a working repo, already ignored;
- `/tmp/lazyglm-*` scratch folders;
- private notes outside the Git checkout.

Do not commit:

- active/done plan directories;
- local run packets or transcripts;
- API keys, environment files, private paths, emails, chat/account IDs, or screenshots/logs with secrets;
- internal operating-system notes that are not product documentation.

A PR body should summarize the user-facing change and verification. It should not become a dump of local planning state.

## Standard PR flow

1. Branch from current `origin/main`.
2. Make the scoped change.
3. Run local gates:
   ```bash
   npm test
   node bin/lazyglm.js --version
   npm pack --dry-run
   git diff --check
   ```
4. Open a PR against `main`.
5. Let GitHub Actions run the `ci` workflow.
6. Trigger Codex review if it did not auto-trigger:
   ```text
   @codex review
   ```
7. Inspect all Codex surfaces before calling the PR clean:
   - normal PR comments;
   - formal reviews;
   - inline pull-request review comments;
   - unresolved current review threads.
8. Fix valid findings, rerun local gates, push, and trigger Codex review again.
9. Merge only after CI is green, latest-head Codex review is clean or explicitly owner-waived, current unresolved review threads are zero, and the owner approves merge.

## Codex connector environment

If `@codex review` responds that an environment must be created for this repository, use a minimal Codex cloud environment:

- Repository: `graphanov/LazyGLM`
- Container image: universal
- Secrets: none by default
- Environment variables: none by default
- Internet after setup: off unless the review specifically needs external docs
- Setup script:
  ```bash
  set -e
  node --version
  npm --version
  npm test
  node bin/lazyglm.js --version
  npm pack --dry-run
  ```

Then return to the PR and comment `@codex review` once.

## Branch protection target

The intended `main` branch policy is:

- PRs required before merge;
- required status check: `ci` from GitHub Actions;
- no force pushes;
- no branch deletion;
- admins included;
- unresolved review conversations resolved before merge when GitHub exposes them as review threads.

GitHub branch protection cannot directly require a Codex issue comment. The enforceable part is `ci` plus review-thread/conversation resolution. The process requirement is that each PR receives Codex review unless the owner explicitly waives it.

## Release and publishing gate

A merged PR does not automatically authorize npm publish or GitHub Release changes. Use `docs/PUBLISHING.md` for the trusted-publishing workflow, and only dispatch publishing after an explicit release/version gate.
