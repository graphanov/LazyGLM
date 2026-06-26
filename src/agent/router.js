// @ts-check

// Model router: maps a task role to a concrete (model, provider) pair using
// config/model-catalog.json. This is what makes "leverage GLM-5.2 for hard
// tasks, glm-4.7 for quick/routine ones" actually work — previously roles.json
// was a dead file nothing read.
import { readJson } from "../util.js";
import { loadUserConfig, normalizeProvider } from "../config.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * @typedef {import("../types/index.js").ModelCatalog} ModelCatalog
 * @typedef {import("../types/index.js").ModelRouteOptions} ModelRouteOptions
 * @typedef {import("../types/index.js").Provider} Provider
 * @typedef {import("../types/index.js").ProviderCatalogConfig} ProviderCatalogConfig
 * @typedef {import("../types/index.js").ResolvedModelRoute} ResolvedModelRoute
 * @typedef {import("../types/index.js").RoleModelConfig} RoleModelConfig
 * @typedef {import("../types/index.js").RoleName} RoleName
 *
 * @typedef {object} PersistedUserConfig
 * @property {Provider} [provider]
 * @property {string} [model]
 * @property {string} [api_key]
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CATALOG_PATH = join(ROOT, "config", "model-catalog.json");
const readModelCatalog = /** @type {(path: string, fallback: ModelCatalog) => Promise<ModelCatalog>} */ (
  /** @type {unknown} */ (readJson)
);

/** @type {ModelCatalog | null} */
let _catalog = null;

/** @returns {Promise<ModelCatalog>} */
async function loadCatalog() {
  if (_catalog) return _catalog;
  _catalog = await readModelCatalog(CATALOG_PATH, {});
  return _catalog;
}

/**
 * Resolve which provider to use. Priority (high → low):
 *   1. explicit options.provider
 *   2. LAZYGLM_PROVIDER env
 *   3. LAZYGLM_BASE_URL env (custom endpoint -> provider "custom")
 *   4. persisted user config (~/.lazyglm/config.json)
 *   5. catalog.default_provider (zai)
 *
 * @param {ModelRouteOptions} [options]
 * @param {ModelCatalog} [catalog]
 * @param {PersistedUserConfig} [userConfig]
 * @returns {Provider}
 */
export function resolveProvider(options = {}, catalog, userConfig = {}) {
  if (options.provider) return /** @type {Provider} */ (normalizeProvider(options.provider));
  if (process.env.LAZYGLM_PROVIDER) return /** @type {Provider} */ (normalizeProvider(process.env.LAZYGLM_PROVIDER));
  if (process.env.LAZYGLM_BASE_URL) return "custom";
  if (userConfig?.provider) return /** @type {Provider} */ (normalizeProvider(userConfig.provider));
  return catalog?.default_provider || "zai";
}

/**
 * Resolve a canonical model name (e.g. "glm-5.2") to the provider-specific ID
 * (e.g. "z-ai/glm-5.2" for nous, "glm-5.2" for ollama/zai).
 *
 * @param {string} model
 * @param {Provider} provider
 * @param {ModelCatalog} [catalog]
 * @returns {string}
 */
export function resolveModelId(model, provider, catalog) {
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
 * @param {RoleName} [role] - one of: default, worker, ultrabrain, planner, verifier, quick
 * @param {ModelRouteOptions} [options] - { provider?, model? } overrides
 * @param {PersistedUserConfig | null} [userConfig] - preloaded user config (loaded from disk if omitted)
 * @returns {Promise<ResolvedModelRoute>}
 */
export async function pickModel(role = "default", options = {}, userConfig = null) {
  const catalog = await loadCatalog();
  /** @type {PersistedUserConfig} */
  const uc = userConfig ?? (await loadUserConfig());
  const provider = resolveProvider(options, catalog, uc);

  // explicit --model wins, but still resolve to provider-specific ID.
  // The persisted config-file model is an override of the catalog default only
  // (role-specific models always win, so routing tiers are preserved).
  /** @type {RoleModelConfig} */
  const roleEntry = catalog.roles?.[role] || catalog.roles?.default || {};
  const canonical = options.model || roleEntry.model || uc?.model || catalog.current?.model || "glm-5.2";
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
 * @param {string | null | undefined} [task]
 * @param {ModelRouteOptions} [options]
 * @returns {RoleName}
 */
export function detectRole(task, options = {}) {
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
 * @param {Provider} provider
 * @returns {Promise<ProviderCatalogConfig>}
 */
export async function getProviderConfig(provider) {
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
