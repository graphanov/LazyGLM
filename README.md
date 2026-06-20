<div align="center">

# LazyGLM

**The GLM-native agent harness for complex codebases.**
Project memory, planning, execution, and verified completion — driven by GLM models.

</div>

---

## What is this?

LazyGLM is a clean-room reimagining of the [lazycodex](https://github.com/code-yeongyu/lazycodex)
concept, retuned for **GLM models** instead of Codex models.

lazycodex packages the OmO agent harness as a plugin for the OpenAI **Codex CLI**,
routing to **gpt-5.x**. LazyGLM reproduces the same functionalities — a hook
lifecycle, discipline plugins, a skills system, a model catalog, sub-agent
roles, an installer, and a verified-completion loop — but drives **GLM** models
( glm-5.2 / glm-4.7 / glm-4.7-flash ) via a self-contained agent runtime. No
external coding-agent CLI required.

> Think "LazyVim for a GLM coding agent" — the harness is in the box.

See [`docs/design.md`](docs/design.md) for the full clean-room mapping.

## Install

LazyGLM runs against any OpenAI-compatible GLM endpoint. The default is a
**local Ollama** instance (keyless, private):

```bash
# 1. start Ollama and pull a GLM model
ollama serve &
ollama pull glm-4.7-flash

# 2. install lazyglm globally (or use npx)
npm install -g lazyglm     # once published
# or run from source:
node bin/lazyglm.js doctor
```

To target a hosted GLM endpoint instead:

```bash
export LAZYGLM_BASE_URL=https://api.z.ai/api/paas/v4
export LAZYGLM_API_KEY=your-key
export LAZYGLM_MODEL=glm-4.7
```

Initialize a project:

```bash
cd your-project
lazyglm install      # scaffolds .lazyglm/ + AGENTS.md
lazyglm doctor       # health report
```

## Use

```bash
# run the GLM agent on a task
lazyglm run "add a /health endpoint and a test for it"

# plan first, then execute
lazyglm run '$ulw-plan "refactor the auth module"'

# verified-completion loop (keeps going until objectively done)
lazyglm run "build a Minecraft clone in Three.js" \
  --ultrawork \
  --completion-promise="index.html loads, WASD + mouse look works, blocks break and place, no console errors" \
  --verify="node -e \"require('http').get('http://localhost:8080',r=>process.exit(r.statusCode===200?0:1))\""

# list / read skills
lazyglm skills
lazyglm skill ulw-loop
```

## What you get

| Feature | Description |
| --- | --- |
| 🤖 **GLM agent runtime** | Self-contained tool-use loop driving a GLM model (read/write/patch/grep/shell) |
| 🔀 **Hook lifecycle** | SessionStart, UserPromptSubmit, Pre/PostToolUse, Stop, PostCompact — the same events the original speaks |
| 🛡️ **Discipline plugins** | rules injection, comment-checker, executor-verify, start-work-continuation, telemetry (local-only) |
| 🔁 **Ultrawork loop** | `$ulw-loop` / `--ultrawork` verified-completion loop (run → verify → continue) |
| 📋 **Skills** | `$init-deep`, `$ulw-plan`, `$start-work`, `$ulw-loop`, `$review-work`, `$remove-ai-slops`, `$programming` |
| 🎯 **Model routing** | GLM catalog with roles: default/worker/quick/planner/verifier/ultrabrain |
| 🩺 **Doctor** | Provider + model + plugin + skill health report |

## Why GLM models, not Codex models

lazycodex pins `gpt-5.5`. LazyGLM's `config/model-catalog.json` pins GLM models
with the same shape: `current`, `roles`, context window, reasoning effort. The
default workhorse is `glm-4.7-flash` (fast, capable); `glm-5.2` is the
ultrabrain role for hard reasoning. Run `lazyglm models` to see what your
provider offers.

## Architecture

```
bin/lazyglm.js            CLI entrypoint
src/cli.js                command dispatcher
src/agent/                GLM provider, tools, runtime, context
src/hooks/                hook engine + protocol schema
src/plugins/              discipline + orchestration components
src/skills/               skill loader
src/installer.js          `lazyglm install`
src/doctor.js             health report
src/ulw.js                Ultrawork verified-completion loop
skills/                   markdown skills (GLM-tuned)
config/                   model-catalog.json + roles.json
test/                     node --test suites
```

## Test

```bash
npm test
```

## License

MIT
