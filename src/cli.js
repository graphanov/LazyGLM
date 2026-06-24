// CLI dispatcher: lazyglm <command> [args]
import { resolve } from "node:path";
import { install, uninstall } from "./installer.js";
import { doctor } from "./doctor.js";
import { checkUpdate, selfUpdate, describeUpdate } from "./update.js";
import { runAgent } from "./agent/runtime.js";
import { runUltrawork } from "./ulw.js";
import { loadPlugins } from "./plugins/index.js";
import { loadSkills, listSkillNames, getSkill, detectSkillInvocation } from "./skills/index.js";
import { resolveProviderConfig, listModels } from "./agent/provider.js";
import { readJson } from "./util.js";
import { HookEngine } from "./hooks/engine.js";
import { createRunEventPrinter } from "./cli-output.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `LazyGLM — the GLM-native agent harness.

Usage:
  lazyglm [chat] [options]             Launch the interactive REPL (default; self-sustained)
    --continue                         Resume the most recent session
    --yolo                             Bypass all permission gates (auto everywhere)
    --model <name>                     GLM model (default: glm-5.2 via z.ai)
    --provider <zai|nous|ollama>       Backend (default: zai; ollama=keyless local)
  lazyglm run "<task>" [options]       Run the GLM agent on a task (one-shot, non-interactive)
  lazyglm install [--force]            Initialize .lazyglm/ + AGENTS.md in this project
  lazyglm uninstall                    Remove .lazyglm/ runtime state
  lazyglm doctor                       Health report (provider, model, plugins, skills)
  lazyglm update [--check] [--force]   Check for / install a newer LazyGLM release
  lazyglm models                       List available GLM models from the provider
  lazyglm run "<task>" [options]       Run the GLM agent on a task
    --model <name>                     GLM model (default: glm-5.2 via z.ai)
    --provider <zai|nous|ollama>       Backend (default: zai; ollama=keyless local)
    --role <role>                      Force a routing role (default|quick|planner|verifier|ultrabrain)
    --cwd <path>                       Working directory (default: .)
    --max-turns <n>                    Max agent turns (default 80)
    --max-reasoning-tokens <n>         Soft cap on cumulative reasoning tokens (0=unlimited)
    --ultrawork                        Verified-completion loop mode ($ulw-loop)
    --completion-promise "<text>"      What 'done' means (ultrawork)
    --verify "<command>"               Shell command that must exit 0 (ultrawork verify)
  lazyglm skills                       List installed skills
  lazyglm skill <name>                 Print a skill's content
  lazyglm hook <event>                 Fire a hook event from stdin JSON (bridge)
  lazyglm --version
  lazyglm help

Environment:
  LAZYGLM_API_KEY    bearer token (REQUIRED for zai/nous; get it at z.ai)
  LAZYGLM_PROVIDER   zai (default) | nous | ollama (local, keyless)
  LAZYGLM_BASE_URL   override the endpoint for any OpenAI-compatible host
  LAZYGLM_MODEL      override the catalog default model
`;
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else { flags[key] = next; i++; }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

export async function main(argv) {
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(usage());
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    const pkg = await readJson(join(ROOT, "package.json"), {});
    console.log(`lazyglm ${pkg.version || "0.0.0"}`);
    return 0;
  }

  // Interactive REPL: `lazyglm`, `lazyglm chat`, or leading REPL flags
  // (e.g. `lazyglm --yolo`, `lazyglm --continue --model glm-4.7`).
  // `lazyglm run "..."` stays the one-shot non-interactive path.
  if (!cmd || cmd === "chat" || (cmd.startsWith("--") && !["--version", "--help", "-v", "-h"].includes(cmd))) {
    const { flags } = parseFlags(cmd === "chat" ? rest : argv);
    const { launchREPL } = await import("./repl.js");
    return launchREPL({
      cwd: flags.cwd ? resolve(flags.cwd) : process.cwd(),
      flags: { continue: !!flags.continue, yolo: !!flags.yolo, model: flags.model, provider: flags.provider },
    });
  }

  switch (cmd) {
    case "install": {
      const { flags } = parseFlags(rest);
      const res = await install({ cwd: flags.cwd ? resolve(flags.cwd) : process.cwd(), force: !!flags.force });
      console.log(`LazyGLM installed in ${res.cwd}`);
      for (const c of res.created) console.log(`  + ${c}`);
      if (!res.git.isRepo) console.log("  (not a git repo — `git init` recommended)");
      console.log("\nNext: `lazyglm doctor` to verify the GLM provider, then `lazyglm run \"<task>\"`.");
      return 0;
    }
    case "uninstall": {
      const { flags } = parseFlags(rest);
      const res = await uninstall({ cwd: flags.cwd ? resolve(flags.cwd) : process.cwd() });
      console.log(`Removed from ${res.cwd}:`);
      for (const r of res.removed) console.log(`  - ${r}`);
      return 0;
    }
    case "doctor": {
      const { flags } = parseFlags(rest);
      const res = await doctor({ cwd: flags.cwd ? resolve(flags.cwd) : process.cwd() });
      console.log(`LazyGLM doctor — ${res.cwd}`);
      console.log(`Provider: ${res.provider.baseURL} | default model: ${res.provider.modelId}\n`);
      for (const c of res.checks) {
        const icon = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗";
        console.log(`  [${icon}] ${c.name}: ${c.detail}`);
      }
      console.log(`\n${res.summary}`);
      return res.checks.some((c) => c.status === "fail") ? 1 : 0;
    }
    case "update": {
      const { flags } = parseFlags(rest);
      if (flags.check) {
        const res = await checkUpdate();
        console.log(describeUpdate(res));
        return res.exitCode;
      }
      const res = await selfUpdate({ force: !!flags.force });
      return res.exitCode;
    }
    case "models": {
      try {
        const cfg = await resolveProviderConfig({ role: "default" });
        const models = await listModels(cfg);
        console.log(`Models at ${cfg.baseURL} (${cfg.provider}, ${models.length}):`);
        for (const m of models) console.log(`  ${m}`);
      } catch (e) {
        console.error(`Cannot list models: ${e.message}`);
        return 1;
      }
      return 0;
    }
    case "skills": {
      await loadSkills();
      const names = listSkillNames();
      console.log(`Skills (${names.length}):`);
      for (const n of names) console.log(`  $${n}`);
      return 0;
    }
    case "skill": {
      const name = rest[0];
      if (!name) { console.error("usage: lazyglm skill <name>"); return 1; }
      await loadSkills();
      const s = getSkill(name);
      if (!s) { console.error(`unknown skill: ${name}`); return 1; }
      console.log(s.body);
      return 0;
    }
    case "hook": {
      // bridge: read stdin JSON, fire one event with all plugins
      const event = rest[0];
      const data = await readStdin();
      let input;
      try { input = JSON.parse(data); } catch { input = {}; }
      const cwd = input.cwd ? resolve(input.cwd) : process.cwd();
      const engine = new HookEngine({ cwd });
      for (const p of loadPlugins()) engine.register(p);
      engine.setMeta({ model: input.model || "glm-4.7-flash" });
      // synthesize a single-fire: bypass fire's turn bookkeeping by calling handlers directly
      const api = engine.api();
      const out = [];
      for (const plugin of engine.plugins) {
        const handler = plugin.hooks?.[event];
        if (typeof handler !== "function") continue;
        try {
          const result = await handler({ ...input, hook_event_name: event, session_id: engine.sessionId, cwd }, api);
          if (result) out.push({ plugin: plugin.name, ...result });
        } catch (e) {
          out.push({ plugin: plugin.name, error: e.message });
        }
      }
      const block = out.find((o) => o.decision === "block");
      if (block) {
        process.stdout.write(JSON.stringify({ decision: "block", reason: block.reason }) + "\n");
      } else if (out.length) {
        process.stdout.write(JSON.stringify({ results: out }) + "\n");
      }
      return 0;
    }
    case "run": {
      const { flags, positional } = parseFlags(rest);
      const task = positional.join(" ").trim() || flags.task;
      if (!task) { console.error("usage: lazyglm run \"<task>\""); return 1; }
      const cwd = flags.cwd ? resolve(flags.cwd) : process.cwd();
      const model = flags.model;
      const role = flags.role;
      const maxTurns = Number(flags["max-turns"] || 80);
      const reasoningBudget = Number(flags["max-reasoning-tokens"] || 0);
      const ultrawork = !!flags.ultrawork || /\$ulw-loop\b/i.test(task);
      const printEvent = createRunEventPrinter({ stdout: process.stdout, stderr: process.stderr, isTTY: process.stdout.isTTY === true });

      if (ultrawork) {
        const completionPromise = flags["completion-promise"] || "the task is fully implemented, builds cleanly, and passes verification.";
        const verifyCommand = flags.verify;
        const maxIterations = Number(flags["max-iterations"] || 3);
        const res = await runUltrawork({ task, cwd, model, role, completionPromise, verifyCommand, maxIterations, maxTurns, reasoningBudget, onEvent: printEvent });
        console.log(`\n--- Ultrawork result ---`);
        console.log(`verified: ${res.verified ? "YES ✅" : "NO ❌"} | iterations: ${res.iterations}`);
        if (res.verdict) console.log(`verdict: ${res.verdict.reason}`);
        return res.verified ? 0 : 2;
      }

      const res = await runAgent({ task, cwd, model, role, plugins: loadPlugins(), maxTurns, reasoningBudget, onEvent: printEvent });
      console.log(`\n--- Run result ---`);
      console.log(`finished: ${res.finished ? "YES ✅" : "NO (stopped)"} | turns: ${res.turns} | tokens in/out: ${res.promptTokens || res.tokensIn}/${res.completionTokens || res.tokensOut}${res.reasoningTokens ? ` | 🧠 reasoning: ${res.reasoningTokens}` : ""} | compactions: ${res.compactions}`);
      console.log(`transcript: ${res.transcriptPath}`);
      return res.finished ? 0 : 2;
    }
    default:
      console.error(`unknown command: ${cmd}\n\n${usage()}`);
      return 1;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    // if no stdin (tty), resolve empty immediately
    if (process.stdin.isTTY) resolve("");
  });
}
