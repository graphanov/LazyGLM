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
  env_key?: string;
}

export interface ModelCatalogEntry {
  aliases?: Record<Provider, string>;
  context?: number;
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
    model_reasoning_effort?: ReasoningEffort;
  };
  models?: Record<string, ModelCatalogEntry>;
  roles?: Record<RoleName, RoleModelConfig>;
  providers?: Record<Provider, ProviderCatalogConfig>;
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
  timeout: number;
  maxRetries: number;
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
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  name: string;
  result: string;
  error?: string | null;
}

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
  hooks?: { fire(event: HookEventName, fields?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<HookFireResult> | HookFireResult };
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
