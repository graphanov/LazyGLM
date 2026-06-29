// Shared LazyGLM runtime contracts.
//
// PR-A deliberately keeps these as type-only declarations. Runtime JavaScript is
// not imported from this file, and the TypeScript gate checks only `.ts` files.
// Follow-up PRs can adopt these contracts from JavaScript via selective JSDoc or
// convert modules to TypeScript once the noise budget is known.

export type Provider = "zai" | "nous" | "ollama" | "custom" | (string & {});

export type RoleName =
  | "default"
  | "worker"
  | "ultrabrain"
  | "planner"
  | "verifier"
  | "quick"
  | (string & {});

export type ReasoningEffort = "low" | "medium" | "high" | "max" | (string & {});

export interface ProviderCatalogConfig {
  base_url?: string;
  requires_key?: boolean;
  env_key?: string | null;
}

export interface ModelCatalogEntry {
  tier?: string;
  aliases?: Partial<Record<Provider, string>>;
  context?: number;
  context_window?: number;
  description?: string;
  notes?: string;
}

export interface RoleModelConfig {
  model?: string;
  reasoning_effort?: ReasoningEffort;
}

export interface ModelCatalog {
  default_provider?: Provider;
  current?: {
    model?: string;
    provider?: Provider;
    model_context_window?: number;
    model_reasoning_effort?: ReasoningEffort;
  };
  models?: Record<string, ModelCatalogEntry>;
  roles?: Record<RoleName, RoleModelConfig>;
  providers?: Partial<Record<Provider, ProviderCatalogConfig>>;
}

export interface ModelRouteOptions {
  provider?: Provider;
  model?: string;
  role?: RoleName;
}

export interface ResolvedModelRoute {
  model: string;
  modelId: string;
  provider: Provider;
  role: RoleName;
  reasoningEffort: ReasoningEffort;
  apiKey?: string | null;
}

export interface ProviderConfig {
  baseURL: string;
  apiKey: string | null;
  modelId: string;
  model: string;
  provider: Provider;
  role: RoleName;
  reasoningEffort: ReasoningEffort;
  timeout: number;
  maxRetries: number;
}

export interface EffectiveBundle {
  provider: Provider;
  model: string;
  modelId: string;
  role: RoleName;
  reasoningEffort: ReasoningEffort;
}

export interface RoutingSignal {
  source: "prompt_intake" | "tool_result" | "user_turn_complete";
  role?: RoleName;
  reason: string;
  hard?: boolean;
}

export interface RoutingDecision {
  source: "prompt_intake" | "tool_result" | "user_turn_complete";
  from: EffectiveBundle;
  to: EffectiveBundle;
  reason: string;
  direction: "escalate" | "deescalate";
  hard: boolean;
}

export interface ReasoningUsage {
  reasoning_tokens?: number;
}

export interface ChatUsage extends ReasoningUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type StreamDelta =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call_start"; index: number; id?: string | null; name?: string | null }
  | { type: "tool_call_args"; index: number; fragment: string }
  | { type: "done"; finish_reason: string | null };

export interface ToolCall {
  id: string;
  type?: "function";
  name?: string | null;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  name: string;
  result: string;
  error?: string | null;
}

export interface ToolDeadline {
  signal?: AbortSignal;
  throwIfExpired?: () => void;
  remainingMs?: () => number;
}

export interface ToolRuntimeContext {
  engine?: HookEngineContract;
  ctx?: unknown;
  log?: (record: Record<string, unknown>) => void | Promise<void>;
  deadline?: ToolDeadline;
  signal?: AbortSignal;
}

export interface ToolHandlerContext {
  cwd: string;
  runtime?: ToolRuntimeContext;
}

export type FinishToolResult = { __finish: true; summary: string };

export type ToolHandlerResult = string | FinishToolResult;

export type ToolHandler<Args extends object = Record<string, unknown>> = {
  handle(args: Args, ctx: ToolHandlerContext): ToolHandlerResult | Promise<ToolHandlerResult>;
}["handle"];

export interface ChatCompletion {
  content: string | null;
  reasoning?: string | null;
  tool_calls: ToolCall[] | null;
  raw?: unknown;
  usage?: ChatUsage | null;
}

export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: JsonSchema;
  };
}

export type PermissionMode = "auto" | "ask" | "yolo" | "read-only" | (string & {});

export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SubagentStop"
  | "PostCompact";

export interface HookMeta {
  sessionId: string;
  turnId: string;
  transcriptPath?: string | null;
  cwd: string;
  model: string;
  permissionMode?: PermissionMode;
}

export interface HookInput extends Record<string, unknown> {
  session_id: string;
  turn_id: string;
  transcript_path: string | null;
  cwd: string;
  hook_event_name: HookEventName;
  model: string;
  permission_mode: PermissionMode;
}

export type HookResult =
  | null
  | undefined
  | { decision: "block"; reason?: string }
  | { decision: "approve" }
  | { inject: string }
  | { feedback: string };

export interface HookPluginApi {
  cwd: string;
  signal?: AbortSignal;
  sessionId: string;
  log(message: string): void;
  readFile(relativePath: string): Promise<string | null>;
  readFileAbs(absolutePath: string): Promise<string | null>;
}

export interface HookPlugin {
  name: string;
  hooks?: Partial<Record<HookEventName, (input: HookInput, api: HookPluginApi) => HookResult | Promise<HookResult>>>;
}

export interface HookFireResult {
  blocks: string[];
  injects: string[];
  feedbacks: string[];
  results: Array<{ plugin: string; result: HookResult }>;
}

/**
 * Minimal structural contract for the hook engine runAgent consumes.
 * runAgent treats the `hooks` option as the engine itself: it calls
 * `register(...)`, reads `sessionId`, and calls `setMeta(...)` before firing
 * events. Exposing only `{ fire }` would typecheck but crash at startup with
 * `engine.setMeta is not a function`. Keep this aligned with src/hooks/engine.js.
 */
export interface HookEngineContract {
  sessionId: string;
  register(plugin: HookPlugin): void;
  setMeta(meta?: {
    model?: string;
    transcriptPath?: string | null;
    permissionMode?: PermissionMode;
  }): void;
  fire(
    event: HookEventName,
    fields?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<HookFireResult> | HookFireResult;
}

export interface SessionRecord {
  t: string;
  type: string;
  id?: string;
  model?: string | null;
  provider?: Provider | null;
  firstPrompt?: string | null;
  [key: string]: unknown;
}

export interface RunAgentOptions {
  task: string;
  cwd: string;
  model?: string;
  config?: ProviderConfig;
  plugins?: HookPlugin[];
  hooks?: HookEngineContract;
  maxTurns?: number;
  budget?: number;
  temperature?: number;
  systemPromptExtra?: string;
  role?: RoleName;
  reasoningBudget?: number;
  onEvent?: (event: Record<string, unknown>) => void;
  permissionMode?: PermissionMode;
  failOnToolBlock?: boolean;
  deadline?: { signal?: AbortSignal; throwIfExpired?: () => void };
  signal?: AbortSignal;
}

export type ToolCallStatus =
  | "ok"
  | "denied"
  | "error"
  | "finish"
  | "timeout"
  | (string & {});

export interface ToolExecutionRecord {
  name: string;
  turn: number;
  status: ToolCallStatus;
}

export interface RunAgentResult {
  sessionId: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  reasoningTokens: number;
  promptTokens: number;
  completionTokens: number;
  compactions: number;
  transcriptPath: string;
  finished: boolean;
  finishReason: string;
  finishSummary?: string | null;
  result?: string | null;
  toolCalls: ToolExecutionRecord[];
  filesWritten: string[];
  errorMessage?: string | null;
}
