// `lazyglm doctor` — installation + runtime health report.
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveProviderConfig, listModels } from "./agent/provider.js";
import { loadPlugins } from "./plugins/index.js";
import { loadSkills, listSkillNames } from "./skills/index.js";
import { loadUserConfig } from "./config.js";
import { parseMcpServers, mcpServersSummary } from "./mcp/config.js";
import { readJson } from "./util.js";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const execP = promisify(exec);

export async function doctor({ cwd } = {}) {
  const dir = cwd || process.cwd();
  const checks = [];
  const ok = (name, detail) => { checks.push({ name, status: "ok", detail }); };
  const warn = (name, detail) => { checks.push({ name, status: "warn", detail }); };
  const fail = (name, detail) => { checks.push({ name, status: "fail", detail }); };

  const catalog = await readJson(join(ROOT, "config", "model-catalog.json"), {});

  // resolve provider config (now async + routing-aware)
  let cfg;
  let providerError = null;
  try {
    cfg = await resolveProviderConfig({ role: "default" });
  } catch (e) {
    providerError = e.message;
    cfg = { baseURL: "?", provider: "?", modelId: catalog.current?.model || "glm-5.2", apiKey: "" };
  }

  // provider config resolved?
  if (providerError) {
    fail("provider", providerError.split("\n")[0]);
  } else {
    ok("provider", `${cfg.provider} -> ${cfg.baseURL} | model: ${cfg.modelId} (role: ${cfg.role})`);
  }

  // provider reachable + model available?
  if (!providerError) {
    let models = [];
    try {
      models = await listModels(cfg);
      ok("reachable", `${cfg.baseURL} reachable, ${models.length} model(s) listed`);
    } catch (e) {
      // ollama not running is a warn (not fail) — it's an optional local path
      if (cfg.provider === "ollama") {
        warn("reachable", `${cfg.baseURL} unreachable. Start Ollama: \`ollama serve\``);
      } else {
        fail("reachable", `${cfg.baseURL} unreachable: ${e.message}`);
      }
    }
    if (models.length) {
      const hasModel = models.some((m) => m === cfg.modelId || m.startsWith(cfg.modelId + ":") || m.replace(/:latest$/, "") === cfg.modelId || m.endsWith("/" + cfg.modelId));
      if (hasModel) ok("model", `configured model '${cfg.modelId}' is available at the provider`);
      else {
        const glmModels = models.filter((m) => /glm/i.test(m)).slice(0, 10);
        warn("model", `configured model '${cfg.modelId}' not listed. GLM models available: ${glmModels.join(", ") || "(none)"}`);
      }
    }
  }

  // if using ollama, show local daemon status
  if (cfg.provider === "ollama") {
    try {
      const { stdout } = await execP("ollama list 2>/dev/null", { timeout: 5000 });
      const localModels = stdout.split("\n").filter(Boolean).map((l) => l.split(/\s+/)[0]);
      ok("ollama", `daemon up, ${localModels.length} local model(s)${localModels.length ? ": " + localModels.slice(0, 6).join(", ") : ""}`);
    } catch {
      warn("ollama", "ollama CLI not responding (is `ollama serve` running?)");
    }
  }

  // project install state
  const lazyDir = join(dir, ".lazyglm");
  if (existsSync(lazyDir)) ok("install", `.lazyglm/ present in ${dir}`);
  else warn("install", `no .lazyglm/ in ${dir}. Run \`lazyglm install\` to initialize.`);
  if (existsSync(join(dir, "AGENTS.md"))) ok("agents", "AGENTS.md present");
  else warn("agents", "no AGENTS.md (rules plugin will run with defaults)");

  // plugins
  const plugins = loadPlugins();
  ok("plugins", `${plugins.length} loaded: ${plugins.map((p) => p.name).join(", ")}`);

  // skills
  await loadSkills();
  const skills = listSkillNames();
  ok("skills", `${skills.length} loaded: ${skills.join(", ") || "(none)"}`);

  // catalog + routing
  if (catalog.current) {
    const roleCount = Object.keys(catalog.roles || {}).length;
    const modelCount = Object.keys(catalog.models || {}).length;
    ok("catalog", `v${catalog.version} | ${modelCount} models, ${roleCount} routing roles | default: ${catalog.current.model} via ${catalog.current.provider}`);
  }

  // routing sanity: verify roles resolve to models
  if (catalog.roles) {
    const unresolved = [];
    for (const [role, entry] of Object.entries(catalog.roles)) {
      if (!catalog.models?.[entry.model]) unresolved.push(`${role}->${entry.model}`);
    }
    if (unresolved.length) warn("routing", `roles pointing to unknown models: ${unresolved.join(", ")}`);
    else ok("routing", `all ${Object.keys(catalog.roles).length} roles resolve to catalog models`);
  }

  // MCP server declarations (preflight: validated, NOT connected).
  // Tools/calls are not counted here — this only reports declaration health.
  try {
    const userCfg = await loadUserConfig();
    const mcp = parseMcpServers(userCfg);
    const summary = mcpServersSummary(mcp);
    if (mcp.errors.length) {
      warn("mcp", `${summary} — declarations validated, not connected`);
    } else if (mcp.count) {
      ok("mcp", `${summary} — declarations validated, not connected`);
    } else {
      ok("mcp", "no MCP servers declared");
    }
  } catch {
    warn("mcp", "could not read MCP server declarations");
  }

  return {
    cwd: dir,
    provider: cfg,
    checks,
    summary: `${checks.filter((c) => c.status === "ok").length}/${checks.length} ok, ${checks.filter((c) => c.status === "warn").length} warn, ${checks.filter((c) => c.status === "fail").length} fail`,
  };
}
