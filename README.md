<div align="center">

# LazyGLM

**The GLM-native agent harness for complex codebases.**
Project memory, planning, execution, and verified completion — driven by GLM models.

</div>

---

## What is this?

LazyGLM is a clean-room reimagining of the [lazycodex](https://github.com/code-yeongyu/lazycodex)
concept, retuned for **GLM models** instead of Codex models.

lazycodex packages an agent harness as a plugin for the OpenAI Codex CLI, routing
to GPT-5.x. LazyGLM reproduces the same functionalities — a hook lifecycle,
discipline plugins, a skills system, model routing, sub-agent roles, an
installer, and a verified-completion loop — but drives **GLM** models via a
self-contained agent runtime. No external coding-agent CLI required.

> Think "LazyVim for a GLM coding agent" — the harness is in the box.

## Install

```bash
npm install -g lazyglm
```

Or run from source:

```bash
git clone https://github.com/graphanov/LazyGLM.git lazyglm && cd lazyglm
node bin/lazyglm.js doctor
```

## Configure

LazyGLM defaults to **Zhipu z.ai** serving **glm-5.2** (the frontier GLM model).
You need an API key (get one with a z.ai coding plan):

```bash
export LAZYGLM_API_KEY=***   # get one at z.ai
lazyglm doctor               # verify (LAZYGLM_PROVIDER=zai is the default)
```

> The z.ai base URL is `https://api.z.ai/api/coding/paas/v4` — the `/coding/`
> segment is required (`/api/paas/v4` returns 401).

### Backends

| Provider | Models | Key required | When to use |
| --- | --- | --- | --- |
| `zai` (default) | `glm-5.2`, `glm-5.1`, `glm-4.7`, … | yes | Frontier GLM-5.2 via z.ai (default) |
| `nous` | `z-ai/glm-5.2`, `z-ai/glm-4.7`, … | yes | GLM via the Nous Research inference API |
| `ollama` | local GLM models | no (keyless) | Fully local, private, offline |

```bash
# Nous Research inference API (alternative)
LAZYGLM_PROVIDER=nous LAZYGLM_API_KEY=*** lazyglm doctor

# local Ollama (keyless) — for offline/private use
ollama serve && ollama pull glm-4.7
LAZYGLM_PROVIDER=ollama lazyglm doctor

# or any OpenAI-compatible endpoint
LAZYGLM_BASE_URL=https://your-endpoint/v1 LAZYGLM_API_KEY=*** lazyglm doctor
```

## Model routing

LazyGLM does not blindly spend the frontier model on every step. It routes by
task role (configured in `config/model-catalog.json`):

| Role | Model | Used for |
| --- | --- | --- |
| `ultrabrain` | glm-5.2 | Hard reasoning, architecture, complex debugging |
| `default` | glm-5.2 | Routine coding work |
| `planner` | glm-5.2 | Decision-complete planning |
| `verifier` | glm-4.7 | Completion verification, review |
| `quick` | glm-4.7-flash | Small edits, listings, sub-agents |

Roles are auto-detected from the task, or forced with `--role`:

```bash
lazyglm run "build a todo app"                    # -> default (glm-5.2)
lazyglm run "list the files in src" --role quick  # -> glm-4.7-flash
lazyglm run "verify the tests pass"               # -> verifier (glm-4.7)
```

## Use

```bash
# initialize a project
cd your-project && lazyglm install

# run the GLM agent on a task
lazyglm run "add a /health endpoint and a test for it"

# plan first, then execute
lazyglm run '$ulw-plan "refactor the auth module"'

# verified-completion loop (keeps going until objectively done)
lazyglm run "build a Minecraft clone in Three.js" \
  --ultrawork \
  --completion-promise="index.html loads, WASD + mouse look works, blocks break and place" \
  --verify="node --check game.js"

# cap reasoning-token spend on your coding plan quota (GLM-native cost control)
lazyglm run "refactor the parser" --max-reasoning-tokens 20000
```

## What you get

| Feature | Description |
| --- | --- |
| 🤖 **GLM agent runtime** | Self-contained tool-use loop driving a GLM model (read/write/patch/grep/shell) |
| 🎯 **Model routing** | GLM-5.2 for hard tasks, glm-4.7-flash for quick ones — benchmark-driven, not random |
| 🌊 **Streaming** | Text + reasoning_content + tool-call deltas stream live — no silent hang during thinking |
| 🧠 **Reasoning budget** | `--max-reasoning-tokens` caps cumulative reasoning spend; per-turn reasoning tokens surfaced |
| 🔁 **Retry & backoff** | Exponential backoff (with jitter, respects Retry-After) on 429/5xx/network errors |
| 🗜️ **Task-preserving compaction** | Original task is pinned; dropped context is digested (files/commands/errors), not placeholdered |
| 🔀 **Hook lifecycle** | SessionStart, UserPromptSubmit, Pre/PostToolUse, Stop, PostCompact |
| 🛡️ **Discipline plugins** | rules, comment-checker, executor-verify, start-work-continuation, telemetry (local-only) |
| 🔁 **Ultrawork loop** | `--ultrawork` verified-completion loop (run → verify → continue) |
| 📋 **Skills** | `$init-deep`, `$ulw-plan`, `$start-work`, `$ulw-loop`, `$review-work`, `$remove-ai-slops`, `$programming` |
| 🩺 **Doctor** | Provider + model + routing + plugin + skill health report |

## Architecture

```
bin/lazyglm.js            CLI entrypoint
src/cli.js                command dispatcher
src/agent/
  provider.js             OpenAI-compatible GLM provider (streaming + retry/backoff; Nous/z.ai/Ollama/custom)
  router.js               role -> model routing + provider-aware model IDs
  tools.js                read_file, write_file, patch_file, list_dir, grep, run_shell, finish
  runtime.js              tool-use loop: model -> tools -> hooks -> repeat until finish()
  context.js              message bookkeeping + task-preserving compaction with work digest
src/hooks/                hook engine + protocol schema
src/plugins/              8 discipline + orchestration components
src/skills/               skill loader
src/installer.js          `lazyglm install`
src/doctor.js             health report
src/ulw.js                Ultrawork verified-completion loop
skills/                   markdown skills (GLM-tuned)
config/                   model-catalog.json + roles.json
test/                     49 passing tests (node --test)
```

## Test

```bash
npm test    # 49 tests
```

## License

MIT
