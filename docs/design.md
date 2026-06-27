# LazyGLM — Design Note

## Product shape

LazyGLM is a standalone coding-agent CLI for GLM models. The goal is simple:
make GLM feel first-class in the terminal instead of treating it as just another
OpenAI-compatible model behind a generic wrapper.

A user should be able to run `lazyglm`, choose or configure a GLM provider once,
and then work in an interactive agentic shell with tools, sessions, routing, and
verification loops.

## GLM target

GLM (General Language Model) is Z.ai/Zhipu AI's model family for reasoning,
coding, long-context, and agentic work. For the z.ai GLM Coding Plan, the
officially documented model set is:

- `glm-5.2` for complex reasoning and large-scale engineering work;
- `glm-5-turbo` for a faster high-end tier when the plan supports it;
- `glm-4.7` for daily development and routine tasks.

The default provider is z.ai's coding endpoint:

```text
https://api.z.ai/api/coding/paas/v4
```

The `/coding/` segment is required. The repo also supports Nous, local Ollama,
and custom OpenAI-compatible endpoints.

The GLM-specific runtime work should stay grounded in real model behavior:
`reasoning_content` streaming, reasoning-token usage, long-context coding, and
z.ai's preserved/interleaved thinking requirements. Do not market generic base
URL handling as a differentiator.

## Background inspiration

LazyGLM was inspired by lazycodex's idea of putting discipline around a coding
agent through hooks, skills, and verified-completion loops.

The implementation is different:

| Area | lazycodex | LazyGLM |
| --- | --- | --- |
| Runtime | Extends the OpenAI Codex CLI | Ships its own GLM agent runtime |
| Model stack | OpenAI/Codex-oriented | GLM-5.2 / GLM-5-Turbo / GLM-4.7 |
| Provider setup | Depends on the host CLI | Handles z.ai, Nous, Ollama, and custom endpoints |
| Hooks/skills | Plugin layer around an external runner | In-process hook engine and skill loader |
| Config | Host CLI config | `~/.lazyglm/config.json` plus project-local `.lazyglm/` |

The rewrite is clean-room: no source is copied. The useful idea is the discipline
layer; the runtime, provider handling, and CLI behavior are built for GLM.

## Why self-contained?

GLM does not have a single dominant dedicated coding-agent CLI equivalent to
Claude Code or Codex CLI. To make GLM feel native, LazyGLM needs to own the loop:

1. call the model;
2. stream text, reasoning output, and tool-call deltas;
3. run tools safely;
4. fire hooks;
5. compact context without losing the original task;
6. continue until the model calls `finish()` or the verification loop passes.

That makes `npx lazyglm run "task"` and `lazyglm` real end-to-end exercises of
LazyGLM itself, not smoke tests around another agent.

### Compaction handoff digest

`src/agent/context.js` compacts by pinning the original user task and replacing
the dropped transcript middle with a deterministic digest. The digest is plain
text and currently emits sections in this order when data exists:

1. `Files created`
2. `Files modified`
3. `Commands run`
4. `Errors encountered`
5. `Agent notes`
6. `Decisions & rationale`

`Decisions & rationale` is the lightweight handoff layer for decision-relevant
context. It is extracted without an extra model call by scanning only dropped
assistant text, never tool output or system messages. A sentence is retained
when it matches one of these cues:

- `decide` or `decided`;
- `chose`;
- `the plan is`, `the approach is`, or `the design is`;
- `rationale`;
- `going with ... because ...`.

Each retained decision is normalized to one line, truncated to 200 characters,
deduplicated during extraction, and stored on the `Context` instance. The store
keeps at most 12 decisions, so multi-compaction sessions retain prior rationale
without unbounded summary growth. Because the store lives outside the message
window, decisions from earlier compactions survive later transcript drops.

`PostCompact` hook injects are separate from decision retention. If a hook
returns inject text, the runtime inserts it immediately after the compaction
summary for the current context window. That injected system message is
one-shot: later compactions do not persist or re-digest it because the digest
does not scan system messages. Durable rationale should go through the
deterministic decisions path, not hook injects.

## Architecture

```text
bin/lazyglm.js            CLI entrypoint
src/cli.js                command dispatcher (run | chat/REPL | install | uninstall | doctor | models | skills | skill | hook)
src/config.js             global user config (~/.lazyglm/config.json, chmod 600; key never in process.env)
src/onboard.js            first-run onboarding (provider + key)
src/repl.js               interactive REPL (streaming + tools + hooks + sessions)
src/sessions.js           session persistence (JSONL under ~/.lazyglm/sessions/)
src/agent/
  provider.js             OpenAI-compatible GLM provider (z.ai / Nous / Ollama / custom)
  router.js               role -> model routing + provider-aware model IDs
  tools.js                read_file, write_file, patch_file, list_dir, grep, run_shell, finish
  runtime.js              one-shot tool-use loop: model -> tools -> hooks -> repeat until finish()
  context.js              message bookkeeping + task-preserving compaction
src/hooks/                hook engine + protocol schema
src/plugins/              discipline plugins
src/skills/               skill loader for `$command` invocations
src/installer.js          `lazyglm install`
src/doctor.js             provider/model/routing/plugin/skill health report
src/ulw.js                Ultrawork verified-completion loop
config/model-catalog.json GLM models, providers, roles, context windows, reasoning effort
```

## Hook protocol

A hook receives JSON on stdin:

```jsonc
{
  "session_id": "...",
  "turn_id": "...",
  "transcript_path": null,
  "cwd": "/abs/path",
  "hook_event_name": "PostToolUse",
  "model": "glm-4.7",
  "permission_mode": "auto",
  "tool_name": "write_file",
  "tool_input": {},
  "tool_response": "...",
  "tool_use_id": "..."
}
```

A hook may emit a decision on stdout:

```jsonc
{ "decision": "block", "reason": "comment-checker found issues in foo.js: ..." }
```

Empty stdout means pass-through. Timeouts are enforced per hook.

## Model catalog

`config/model-catalog.json` is the GLM routing map. It records:

- default provider (`zai`);
- current default model (`glm-5.2`);
- provider-specific model aliases;
- context windows;
- role mappings (`default`, `worker`, `planner`, `verifier`, `quick`);
- context windows from the official model docs;
- role mappings (`default`, `worker`, `planner`, `verifier`, `quick`).

The catalog is intentionally explicit because the GLM Coding Plan has meaningful
model choices: GLM-4.7 for daily/routine work, GLM-5.2 or GLM-5-Turbo for harder
engineering tasks.

## Provider abstraction

`src/agent/provider.js` speaks the OpenAI Chat Completions schema with tool
calling. It handles streaming, retry/backoff, tool-call deltas, reasoning output,
and reasoning-token accounting.

Provider config resolves in this order:

```text
CLI flags > env vars > ~/.lazyglm/config.json > catalog default
```

The persisted API key is passed directly into provider calls and is not copied
into `process.env`, so shell tools do not inherit it. That is useful engineering
hygiene, not the product pitch.
