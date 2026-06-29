// First-run onboarding. When `lazyglm` is launched with no API key anywhere
// (no env var, no persisted config, not ollama), prompt for provider + key and
// persist to ~/.lazyglm/config.json (chmod 600). Subsequent launches skip this.
//
// Input is drawn from a shared LineQueue (created by the REPL) so that piped /
// burst stdin is not lost between sequential prompts (a known readline race).
import { saveUserConfig, loadUserConfig, isOnboarded, normalizeProvider, isSupportedProvider, SUPPORTED_PROVIDERS } from "./config.js";
import { nowIso } from "./util.js";
import type { PersistedUserConfig, Provider } from "./types/index.js";

interface LineQueueLike {
  next(): Promise<string | null | undefined>;
}

interface OutputLike {
  write(text: string): unknown;
}

interface OnboardingOptions {
  queue?: LineQueueLike;
  output?: OutputLike;
}

/**
 * True when there is no usable key source and onboarding should run.
 * Env var, an onboarded config file, or ollama all satisfy "no onboarding".
 */
export async function needsOnboarding(): Promise<boolean> {
  if (process.env.LAZYGLM_API_KEY) return false;
  const envProvider = normalizeProvider(process.env.LAZYGLM_PROVIDER);
  const cfg = await loadUserConfig({ force: true });
  if (envProvider === "ollama") return false;
  if (isSupportedProvider(envProvider)) return !cfg?.api_key;
  if (process.env.LAZYGLM_BASE_URL) return false;
  return !isOnboarded(cfg);
}

/**
 * Run the interactive onboarding flow using a shared line queue. Writes
 * ~/.lazyglm/config.json (chmod 600) and returns the persisted config.
 * Throws if the user provides no key for a key-requiring provider.
 *
 * @param {object} opts - { queue, output }
 */
export async function runOnboarding({ queue, output }: OnboardingOptions = {}): Promise<PersistedUserConfig> {
  const out = output || process.stdout;
  const isTTY = !!process.stdin.isTTY;

  const ask = async (q: string): Promise<string> => {
    out.write(q);
    const line = await queue!.next();
    if (!isTTY) out.write((line || "") + "\n"); // echo for piped/recorded runs
    return (line || "").trim();
  };

  out.write("\n🚀 Welcome to LazyGLM — let's get you set up.\n");
  out.write("Defaults work for most people: z.ai + glm-5.2 (the high-end GLM coding model).\n\n");

  const providerHelp = () => {
    out.write("\nSupported providers:\n");
    out.write("  zai    z.ai coding endpoint (default; requires API key)\n");
    out.write("  nous   Nous Research inference API (requires API key)\n");
    out.write("  ollama local OpenAI-compatible Ollama endpoint (keyless)\n\n");
  };

  let provider: Provider;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const providerAns = await ask("Provider [zai] (zai|nous|ollama, or help): ");
    const normalized = normalizeProvider(providerAns || "zai");
    if (normalized === "help" || normalized === "?" || normalized === "h") {
      providerHelp();
      continue;
    }
    if (isSupportedProvider(normalized)) {
      provider = normalized;
      break;
    }
    out.write(`Unknown provider '${providerAns}'. Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}. Type 'help' for details.\n`);
  }

  let apiKey = "";
  if (provider !== "ollama") {
    const url = provider === "nous" ? "https://portal.nousresearch.com" : "https://z.ai";
    apiKey = await ask(`API key for ${provider} (get one at ${url}): `);
    if (!apiKey) {
      out.write("\nNo key entered. Re-run `lazyglm` to onboard, or export LAZYGLM_API_KEY.\n");
      throw new Error("onboarding cancelled: no API key provided");
    }
  }

  const modelAns = await ask("Default model [glm-5.2]: ");
  const model = modelAns || "glm-5.2";

  const config: PersistedUserConfig = { onboarded: true, provider, model, createdAt: nowIso() };
  if (provider !== "ollama") config.api_key = apiKey;
  const path = await saveUserConfig(config);
  out.write(`\n✅ Saved to ${path}\n`);
  out.write(`   provider: ${provider} | model: ${model}\n\n`);
  return config;
}
