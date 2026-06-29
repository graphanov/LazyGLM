// Global user config: ~/.lazyglm/config.json (persisted by onboarding).
//
// Holds provider + api_key + model so `lazyglm` works with ZERO env vars after
// the first run. Env vars still override the config file when present.
//
// SECURITY: the API key is NEVER placed in process.env. It is threaded
// explicitly through resolveProviderConfig -> chat()'s `config.apiKey`. This
// matters because run_shell inherits process.env — if the key lived in env,
// the GLM agent could exfiltrate it via `echo $LAZYGLM_API_KEY`. The config
// file (chmod 600) keeps the key out of the child-process environment.
import { readFile, writeFile, chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PersistedUserConfig, Provider } from "./types/index.js";

interface LoadUserConfigOptions {
  force?: boolean;
  throwOnError?: boolean;
}

function lazyglmHome(): string {
  return process.env.LAZYGLM_HOME || join(process.env.HOME || "/tmp", ".lazyglm");
}

export function configPath(): string {
  return join(lazyglmHome(), "config.json");
}

let _cache: PersistedUserConfig | undefined;

export const SUPPORTED_PROVIDERS = ["zai", "nous", "ollama"] as const;

export function normalizeProvider(provider: unknown): "" | Provider {
  const p = String(provider || "").trim().toLowerCase();
  if (!p) return "";
  if (p === "z.ai" || p === "zhipu" || p === "zhipuai") return "zai";
  return p as Provider;
}

export function isSupportedProvider(provider: unknown): boolean {
  const normalized = normalizeProvider(provider);
  return SUPPORTED_PROVIDERS.some((p) => p === normalized);
}

/**
 * Load the persisted user config. Cached after first read; pass {force:true}
 * to re-read from disk (e.g. after onboarding writes a new file in-process).
 * Returns {} when no config exists yet (fresh machine). LAZYGLM_HOME is read
 * live so tests can point it at a temp dir. By default, malformed/unreadable
 * config degrades to {}; pass {throwOnError:true} when callers need to surface
 * the config-file problem to the user.
 */
export async function loadUserConfig({ force = false, throwOnError = false }: LoadUserConfigOptions = {}): Promise<PersistedUserConfig> {
  if (_cache !== undefined && !force) return _cache;
  const path = configPath();
  if (!existsSync(path)) {
    _cache = {};
    return _cache;
  }
  try {
    const raw = await readFile(path, "utf8");
    _cache = raw.trim() ? (JSON.parse(raw) as PersistedUserConfig) : {};
  } catch (e: unknown) {
    _cache = {};
    if (throwOnError) throw e;
  }
  return _cache;
}

/**
 * Persist the user config to ~/.lazyglm/config.json with chmod 600 and refresh
 * the in-memory cache.
 */
export async function saveUserConfig(config: PersistedUserConfig): Promise<string> {
  await mkdir(lazyglmHome(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(config, null, 2) + "\n", "utf8");
  try {
    await chmod(configPath(), 0o600);
  } catch {
    // chmod best-effort (unsupported on some platforms / fs)
  }
  _cache = config;
  return configPath();
}

/**
 * A config is "onboarded" when it has a key for a key-requiring provider, or
 * when the provider is ollama (keyless).
 */
export function isOnboarded(config: PersistedUserConfig | null | undefined): boolean {
  if (!config || !config.onboarded) return false;
  const provider = normalizeProvider(config.provider || "zai");
  if (provider === "custom") return !!process.env.LAZYGLM_BASE_URL;
  if (!isSupportedProvider(provider)) return false;
  if (provider === "ollama") return true;
  return !!config.api_key;
}

/** Test helper: drop the in-memory cache so a fresh LAZYGLM_HOME takes effect. */
export function resetConfigCache(): void {
  _cache = undefined;
}
