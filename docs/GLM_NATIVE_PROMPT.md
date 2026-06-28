# GLM-Native Prompt Rationale

LazyGLM now prepends a GLM-native operating block to both the one-shot runtime
and the interactive REPL prompt. The block is intentionally additive: it keeps
the existing LazyGLM working rules/persona, then gives the model GLM-specific
context about the active catalog tier, context window, `reasoning_content`, and
tool-loop expectations.

## z.ai References

- GLM-5.2 model docs: https://docs.z.ai/guides/llm/glm-5.2
  - Used for the prompt emphasis on long-horizon coding, project-scale context,
    engineering-standards adherence, 1M context, and 128K maximum output.
- Thinking Mode docs: https://docs.z.ai/guides/capabilities/thinking-mode
  - Used for `reasoning_content`, interleaved thinking, preserved thinking, and
    the need to keep reasoning continuity across tool turns when the runtime
    supplies it.
- GLM Coding Plan Quick Start: https://docs.z.ai/devpack/quick-start
  - Used for Coding Plan-specific endpoint/protocol framing and the fact that
    Coding Plan setup is a coding-tool experience rather than a generic chat
    endpoint.
- Tool Integration URL from issue #44:
  https://docs.z.ai/guides/capabilities/tool/others
  - Checked during implementation, but this URL was unavailable from the docs
    fetcher. This PR therefore avoids unsupported claims about that page and
    relies only on the reachable GLM-5.2, Thinking Mode, and Coding Plan pages.

## Prompt Shape

The shared prompt builder in `src/prompt.js` creates:

1. `GLM-NATIVE OPERATING CONTRACT`
2. Existing one-shot working rules or REPL persona
3. Environment block
4. Hook-injected project context
5. Optional caller-supplied runtime extra text

The new top block tells the model:

- it is running as LazyGLM on GLM, not as a generic assistant;
- which model and catalog tier are active;
- what the catalog says about the model tier and intended tradeoff;
- to use GLM's long-horizon coding strengths for project context, engineering
  constraints, staged execution, and verification;
- to preserve `reasoning_content` continuity when the runtime provides it;
- to inspect with tools, reason over results, and continue with small verified
  steps.

## Catalog Coupling

Tier guidance is derived from `config/model-catalog.json` through the active
model's `tier`, `context_window`, and `description`. The prompt does not carry a
parallel model list. Unknown custom models degrade to a generic GLM-native block
without invented tier guidance.

## CLI Surfaces

The REPL banner and `/status` now accept optional `tier` and `tierReason`
fields:

- callers that omit tier data keep the previous output shape;
- REPL startup shows active tier and guidance when the catalog has an entry;
- `/status` shows active tier and guidance alongside existing token telemetry,
  including reasoning spend.

## Deferred Scope

This foundational slice does not implement onboarding education or
`lazyglm doctor` GLM-native configuration checks. Those are separate issue #44
acceptance criteria with different user-flow and diagnostic test surfaces.
