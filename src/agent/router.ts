// Model router: maps a task role to a concrete (model, provider) pair using
// config/model-catalog.json. This is what makes "leverage GLM-5.2 for hard
// tasks, glm-4.7 for quick/routine ones" actually work — previously roles.json
// was a dead file nothing read.
import { readJson } from "../util.js";
import { loadUserConfig, normalizeProvider } from "../config.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  ModelCatalog,
  ModelCatalogEntry,
  ModelRouteOptions,
  PersistedUserConfig,
  Provider,
  ProviderCatalogConfig,
  ResolvedModelRoute,
  RoleModelConfig,
  RoleName,
} from "../types/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CATALOG_PATH = join(ROOT, "config", "model-catalog.json");
// Conservative fallback for models NOT in the catalog (custom LAZYGLM_BASE_URL,
// Ollama, OpenAI-compatible shims). Many such models have small windows (4k/8k);
// a 200k fallback would suppress compaction until the provider rejects the
// request. Known catalog models still get their derived 80% window; users who
// know their custom model's capacity can set LAZYGLM_CONTEXT_BUDGET explicitly.
export const DEFAULT_CONTEXT_BUDGET = 24_000;
export const CONTEXT_BUDGET_FACTOR = 0.8;
const readModelCatalog = readJson as unknown as (path: string, fallback: ModelCatalog) => Promise<ModelCatalog>;

let _catalog: ModelCatalog | null = null;

export async function loadCatalog() {
  if (_catalog) return _catalog;
  _catalog = await readModelCatalog(CATALOG_PATH, {});
  return _catalog;
}

function parsePositiveInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const normalized = typeof value === "string" ? value.replace(/_/g, "") : value;
  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Resolve the active soft context budget in estimated tokens.
 *
 * The model catalog stores documented context windows by canonical model name
 * (`glm-5.2`). Provider aliases (`z-ai/glm-5.2`) are accepted defensively, but
 * callers should pass the canonical model when they have it. Token counting
 * still uses Context's rough char estimate; this resolver only sets the soft
 * budget from documented catalog capacity.
 *
 */
export function resolveContextBudget(
  model: string | null | undefined,
  catalog: ModelCatalog = {},
  env: Record<string, string | undefined> = process.env,
): number {
  const override = parsePositiveInteger(env?.LAZYGLM_CONTEXT_BUDGET);
  if (override) return override;

  const entry = findCatalogModelEntry(model, catalog);
  const contextWindow = parsePositiveInteger(entry?.context_window ?? entry?.context);
  if (!contextWindow) return DEFAULT_CONTEXT_BUDGET;
  return Math.floor(contextWindow * CONTEXT_BUDGET_FACTOR);
}

export function findCatalogModelEntry(model: string | null | undefined, catalog: ModelCatalog = {}): ModelCatalogEntry | null {
  if (!model) return null;
  const direct = catalog.models?.[model];
  if (direct) return direct;
  for (const entry of Object.values(catalog.models || {})) {
    const aliases = Object.values(entry?.aliases || {});
    if (aliases.includes(model)) return entry;
  }
  return null;
}

/**
 * Resolve which provider to use. Priority (high → low):
 *   1. explicit options.provider
 *   2. LAZYGLM_PROVIDER env
 *   3. LAZYGLM_BASE_URL env (custom endpoint -> provider "custom")
 *   4. persisted user config (~/.lazyglm/config.json)
 *   5. catalog.default_provider (zai)
 *
 */
export function resolveProvider(
  options: ModelRouteOptions = {},
  catalog?: ModelCatalog,
  userConfig: PersistedUserConfig = {},
): Provider {
  if (options.provider) return normalizeProvider(options.provider) as Provider;
  if (process.env.LAZYGLM_PROVIDER) return normalizeProvider(process.env.LAZYGLM_PROVIDER) as Provider;
  if (process.env.LAZYGLM_BASE_URL) return "custom";
  if (userConfig?.provider) return normalizeProvider(userConfig.provider) as Provider;
  return catalog?.default_provider || "zai";
}

/**
 * Resolve a canonical model name (e.g. "glm-5.2") to the provider-specific ID
 * (e.g. "z-ai/glm-5.2" for nous, "glm-5.2" for ollama/zai).
 *
 */
export function resolveModelId(model: string, provider: Provider, catalog?: ModelCatalog): string {
  const entry = catalog?.models?.[model];
  if (entry?.aliases?.[provider]) return entry.aliases[provider];
  // fallback: bare name
  return model;
}

/**
 * Pick a model for a given role. Returns { model, provider, modelId, role, reasoningEffort, apiKey }.
 *
 * `apiKey` is the persisted config-file key (if any) — surfaced here so
 * resolveProviderConfig can use it without a separate file read and WITHOUT
 * placing the key in process.env. Env vars still win at the provider layer.
 *
 */
export async function pickModel(
  role: RoleName = "default",
  options: ModelRouteOptions = {},
  userConfig: PersistedUserConfig | null = null,
): Promise<ResolvedModelRoute> {
  const catalog = await loadCatalog();
  const uc: PersistedUserConfig = userConfig ?? (await loadUserConfig());
  const provider = resolveProvider(options, catalog, uc);

  // Explicit --model wins, followed by LAZYGLM_MODEL. The persisted config-file
  // model is an override of the catalog default only (role-specific models
  // still win, so routing tiers are preserved).
  const roleEntry: RoleModelConfig = catalog.roles?.[role] || catalog.roles?.default || {};
  const canonical = options.model || process.env.LAZYGLM_MODEL || roleEntry.model || uc?.model || catalog.current?.model || "glm-5.2";
  const modelId = resolveModelId(canonical, provider, catalog);

  return {
    model: canonical,
    modelId,
    provider,
    role,
    reasoningEffort: roleEntry.reasoning_effort || catalog.current?.model_reasoning_effort || "high",
    apiKey: uc?.api_key || null,
  };
}

/**
 * Auto-detect the best role for a task. Ultrawork/hard tasks -> ultrabrain;
 * planning -> planner; verification -> verifier; simple/short -> quick; else default.
 *
 */
export function detectRole(task?: string | null, options: ModelRouteOptions = {}): RoleName {
  if (options.role) return options.role;
  const t = (task || "").toLowerCase().trim();
  if (/\$ulw-loop|--ultrawork|ultrawork/.test(t)) return "ultrabrain";
  if (/\$ulw-plan|plan|architect|design|refactor/.test(t)) return "planner";
  // verifier only when the task IS verification (starts with the verb), not when
  // it merely mentions tests/checks as part of a build task.
  if (/^(verify|review|audit|check|lint|inspect)\b/.test(t)) return "verifier";
  if (t.length < 80 && /^(list|show|read|find|grep|what|where)/.test(t)) return "quick";
  return "default";
}

/**
 * Get the provider config (base_url, requires_key) for a given provider.
 *
 */
export async function getProviderConfig(provider: Provider): Promise<ProviderCatalogConfig> {
  const catalog = await loadCatalog();
  const p = catalog.providers?.[provider];
  if (!p) {
    // custom provider via LAZYGLM_BASE_URL
    return {
      base_url: process.env.LAZYGLM_BASE_URL,
      requires_key: !!process.env.LAZYGLM_API_KEY,
      env_key: "LAZYGLM_API_KEY",
    };
  }
  return p;
}
