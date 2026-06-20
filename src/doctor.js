// `lazyglm doctor` — installation + runtime health report.
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveProviderConfig, listModels } from "./agent/provider.js";
import { loadPlugins, PLUGIN_BY_NAME } from "./plugins/index.js";
import { loadSkills, listSkillNames } from "./skills/index.js";
import { readJson, LAZYGLM_DIR } from "./util.js";

const execP = promisify(exec);

export async function doctor({ cwd } = {}) {
  const dir = cwd || process.cwd();
  const cfg = resolveProviderConfig();
  const lines = [];
  const checks = [];
  const ok = (name, detail) => { checks.push({ name, status: "ok", detail }); };
  const warn = (name, detail) => { checks.push({ name, status: "warn", detail }); };
  const fail = (name, detail) => { checks.push({ name, status: "fail", detail }); };

  // provider reachable?
  let models = [];
  try {
    models = await listModels(cfg);
    ok("provider", `${cfg.baseURL} reachable, ${models.length} model(s) listed`);
  } catch (e) {
    fail("provider", `${cfg.baseURL} unreachable: ${e.message}. Start Ollama: \`ollama serve\``);
  }

  // default model present?
  const catalog = await readJson(join(import.meta.dirname, "..", "config", "model-catalog.json"), {});
  const defaultModel = catalog.current?.model || "glm-4.7-flash";
  if (models.length) {
    const hasModel = models.some((m) => m === defaultModel || m.startsWith(defaultModel + ":") || m.replace(/:latest$/, "") === defaultModel);
    if (hasModel) ok("model", `default '${defaultModel}' is available`);
    else warn("model", `default '${defaultModel}' not found locally. Available: ${models.slice(0, 8).join(", ")}. Pull with: ollama pull ${defaultModel}`);
  } else {
    warn("model", `cannot verify '${defaultModel}' (provider unreachable). Try: ollama pull ${defaultModel}`);
  }

  // ollama daemon via CLI
  try {
    const { stdout } = await execP("ollama list 2>/dev/null", { timeout: 5000 });
    const localModels = stdout.split("\n").filter(Boolean).map((l) => l.split(/\s+/)[0]);
    ok("ollama", `daemon up, ${localModels.length} local model(s)${localModels.length ? ": " + localModels.slice(0, 6).join(", ") : ""}`);
  } catch {
    warn("ollama", "ollama CLI not responding (is `ollama serve` running?)");
  }

  // project install state
  const lazyDir = join(dir, ".lazyglm");
  if (existsSync(lazyDir)) {
    ok("install", `.lazyglm/ present in ${dir}`);
  } else {
    warn("install", `no .lazyglm/ in ${dir}. Run \`lazyglm install\` to initialize.`);
  }
  if (existsSync(join(dir, "AGENTS.md"))) ok("agents", "AGENTS.md present");
  else warn("agents", "no AGENTS.md (rules plugin will run with defaults)");

  // plugins
  const plugins = loadPlugins();
  ok("plugins", `${plugins.length} loaded: ${plugins.map((p) => p.name).join(", ")}`);

  // skills
  await loadSkills();
  const skills = listSkillNames();
  ok("skills", `${skills.length} loaded: ${skills.join(", ") || "(none)"}`);

  // catalog
  if (catalog.current) ok("catalog", `model-catalog v${catalog.version}, current=${catalog.current.model} (${catalog.current.model_context_window} ctx)`);

  return {
    cwd: dir,
    provider: cfg,
    defaultModel,
    checks,
    summary: `${checks.filter((c) => c.status === "ok").length}/${checks.length} ok, ${checks.filter((c) => c.status === "warn").length} warn, ${checks.filter((c) => c.status === "fail").length} fail`,
  };
}
