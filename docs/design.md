# LazyGLM — Clean-Room Design

## Origin

LazyGLM is a clean-room rewrite of the **lazycodex** concept
(https://github.com/code-yeongyu/lazycodex). lazycodex is a thin `npx`
installer that packages the **OmO (oh-my-openagent)** agent harness as a
plugin for the **OpenAI Codex CLI**, routing to **Codex models** (gpt-5.x).
Its functional pillars:

- a hook lifecycle wired into a coding agent (SessionStart, UserPromptSubmit,
  PreToolUse, PostToolUse, Stop, SubagentStop, PostCompact);
- plugin components that subscribe to those hooks: project-rules injection,
  comment-checker, LSP diagnostics, codegraph, telemetry, start-work
  continuation, executor-verify, and the Ultrawork verified-completion loop;
- a skills system invoked via `$command`;
- a model catalog pinning the model + reasoning effort;
- sub-agent roles (explorer, librarian, planner, verifier);
- an installer + doctor.

LazyGLM reproduces **the same functionalities**, retuned for **GLM models**
instead of Codex models.

## What changes in the clean room

| lazycodex (original)                     | lazyglm (this repo)                              |
|------------------------------------------|--------------------------------------------------|
| Runtime = OpenAI Codex CLI (external)    | Runtime = self-contained GLM agent loop (in-repo)|
| Models = gpt-5.5 / gpt-5.x (OpenAI)      | Models = glm-5.2 / glm-4.7 / glm-4.7-flash (Ollama / Z.ai) |
| Host = Codex hook protocol               | Host = in-process hook engine (same event names)  |
| Engine = OmO submodule (`src/`)          | Engine = `src/agent` (written from scratch)       |
| Config = `~/.codex/config.toml`          | Config = `.lazyglm/` per-project + `~/.lazyglm/`  |
| Telemetry = PostHog                      | Telemetry = local-only by default (privacy)       |
| TS monorepo + build step                 | Plain ESM JS, zero build step                     |

The rewrite is **clean-room**: no source is copied. The architecture is
re-derived from understanding the original's behaviour, then reimplemented.

## Why self-contained (not a Codex plugin)

lazycodex depends on the Codex CLI being the runner. GLM has no equivalent
ubiquitous coding-agent CLI, so a faithful GLM port must ship its own runner.
This makes lazyglm genuinely independent: `npx lazyglm run "task"` drives a
GLM model through a tool-use loop with the full hook lifecycle firing — no
external agent required. It also means the acceptance test ("build a
Minecraft clone **with** lazyglm") is a real end-to-end exercise of the
harness, not a smoke test.

## Architecture

```
bin/lazyglm.js            CLI entrypoint (install | doctor | run | hook | models | skill)
src/cli.js                command dispatcher
src/agent/
  provider.js             OpenAI-compatible GLM provider (default: Ollama /v1)
  tools.js                read_file, write_file, patch_file, list_dir, grep, run_shell, finish
  runtime.js              tool-use loop: model -> tools -> hooks -> repeat until finish()
  context.js              message bookkeeping + compaction
src/hooks/
  engine.js               fires events to subscribed plugins; collects decisions
  schema.js               hook input/output shapes (mirrors the Codex protocol)
src/plugins/              one file per component, each exports hook subscriptions
  rules.js, comment-checker.js, executor-verify.js,
  start-work-continuation.js, ulw-loop.js, ulw-plan.js,
  telemetry.js, init-deep.js
src/skills/index.js       loads skills/*.md, resolves $command invocations
src/installer.js          `lazyglm install` — scaffolds .lazyglm/ + AGENTS.md
src/doctor.js             health report (model, hooks, plugins, skills)
src/util.js               shared fs/git/path helpers
skills/                   markdown skills (GLM-tuned prompts)
config/
  model-catalog.json      GLM models + context windows + reasoning effort
  roles.json              sub-agent roles
test/                     node --test suites
```

## Hook protocol (mirrors Codex/OMO)

A hook receives JSON on stdin:
```jsonc
{
  "session_id": "...", "turn_id": "...", "transcript_path": null,
  "cwd": "/abs/path", "hook_event_name": "PostToolUse",
  "model": "glm-4.7-flash", "permission_mode": "auto",
  "tool_name": "write_file", "tool_input": {...}, "tool_response": "...",
  "tool_use_id": "..."
}
```
A hook may emit a decision on stdout:
```jsonc
{ "decision": "block", "reason": "comment-checker found issues in foo.js: ..." }
```
Empty stdout = pass-through. Timeouts are enforced per hook. This is the same
contract the original components speak, so behaviour transfers directly.

## Model catalog

`config/model-catalog.json` pins GLM models with the same shape the original
used for gpt-5.x: `current`, `roles` (default/verifier/worker), context window,
and reasoning effort. Default workhorse is `glm-4.7-flash` (fast, capable);
`glm-5.2` is the strong/ultrabrain role for hard reasoning.

## Provider abstraction

`src/agent/provider.js` speaks the OpenAI Chat Completions schema with tool
calling. It defaults to Ollama's OpenAI-compatible endpoint
(`http://localhost:11434/v1`, keyless) but accepts `LAZYGLM_BASE_URL` /
`LAZYGLM_API_KEY` to target Z.ai, OpenRouter, or any OpenAI-compatible host.
This keeps lazyglm GLM-native while remaining portable.
