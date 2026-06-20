// CLI dispatcher: lazyglm <command> [args]
import { resolve } from "node:path";
import { install, uninstall } from "./installer.js";
import { doctor } from "./doctor.js";
import { runAgent } from "./agent/runtime.js";
import { runUltrawork } from "./ulw.js";
import { loadPlugins } from "./plugins/index.js";
import { loadSkills, listSkillNames, getSkill, detectSkillInvocation } from "./skills/index.js";
import { resolveProviderConfig, listModels } from "./agent/provider.js";
import { readJson } from "./util.js";
import { HookEngine } from "./hooks/engine.js";
import { truncate } from "./util.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `LazyGLM — the GLM-native agent harness.

Usage:
  lazyglm install [--force]            Initialize .lazyglm/ + AGENTS.md in this project
  lazyglm uninstall                    Remove .lazyglm/ runtime state
  lazyglm doctor                       Health report (provider, model, plugins, skills)
  lazyglm models                       List available GLM models from the provider
  lazyglm run "<task>" [options]       Run the GLM agent on a task
    --model <name>                     GLM model (default: glm-5.2 via Nous API)
    --provider <nous|ollama|zai>       Backend (default: nous; ollama=keyless local)
    --role <role>                      Force a routing role (default|quick|planner|verifier|ultrabrain)
    --cwd <path>                       Working directory (default: .)
    --max-turns <n>                    Max agent turns (default 80)
    --ultrawork                        Verified-completion loop mode ($ulw-loop)
    --completion-promise "<text>"      What 'done' means (ultrawork)
    --verify "<command>"               Shell command that must exit 0 (ultrawork verify)
  lazyglm skills                       List installed skills
  lazyglm skill <name>                 Print a skill's content
  lazyglm hook <event>                 Fire a hook event from stdin JSON (bridge)
  lazyglm --version
  lazyglm help

Environment:
  LAZYGLM_API_KEY    bearer token (REQUIRED for nous/zai; get it at portal.nousresearch.com)
  LAZYGLM_PROVIDER   nous (default) | ollama (local, keyless) | zai
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

function printEvent(ev) {
  switch (ev.type) {
    case "start":
      console.log(`\n🚀 LazyGLM session ${ev.sessionId} | model: ${ev.model} | provider: ${ev.provider || "?"} | role: ${ev.role || "default"}`);
      console.log(`   cwd: ${ev.cwd}`);
      console.log(`   task: ${truncate(ev.task, 200)}\n`);
      break;
    case "assistant_text":
      if (ev.content?.trim()) console.log(`💬 ${truncate(ev.content, 1200)}`);
      break;
    case "tool_call": {
      const arg = ev.input ? truncate(ev.input, 160) : "";
      console.log(`🔧 ${ev.name}(${arg}) [turn ${ev.turn}]`);
      break;
    }
    case "tool_result":
      console.log(`   ↳ ${truncate(ev.result, 400)}`);
      break;
    case "blocked":
      console.log(`⛔ blocked ${ev.tool}: ${ev.reasons.join("; ")}`);
      break;
    case "finish":
      console.log(`\n✅ FINISH: ${truncate(ev.summary, 1500)}\n`);
      break;
    case "compact":
      console.log(`   (context compacted — #${ev.compactionCount})`);
      break;
    case "ultrawork_iteration":
      console.log(`\n🔁 ULTRAWORK iteration ${ev.iteration}/${ev.max}`);
      break;
    case "ultrawork_verify":
      console.log(`   verify: ${ev.pass ? "PASS ✅" : "FAIL ❌"} — ${truncate(ev.reason, 300)}`);
      break;
    case "error":
      console.error(`❌ error: ${ev.message}`);
      break;
    default:
      break;
  }
}

export async function main(argv) {
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(usage());
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    const pkg = await readJson(join(ROOT, "package.json"), {});
    console.log(`lazyglm ${pkg.version || "0.0.0"}`);
    return 0;
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
      console.log(`Provider: ${res.provider.baseURL} | default model: ${res.defaultModel}\n`);
      for (const c of res.checks) {
        const icon = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗";
        console.log(`  [${icon}] ${c.name}: ${c.detail}`);
      }
      console.log(`\n${res.summary}`);
      return res.checks.some((c) => c.status === "fail") ? 1 : 0;
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
      const ultrawork = !!flags.ultrawork || /\$ulw-loop\b/i.test(task);

      if (ultrawork) {
        const completionPromise = flags["completion-promise"] || "the task is fully implemented, builds cleanly, and passes verification.";
        const verifyCommand = flags.verify;
        const maxIterations = Number(flags["max-iterations"] || 3);
        const res = await runUltrawork({ task, cwd, model, role, completionPromise, verifyCommand, maxIterations, maxTurns, onEvent: printEvent });
        console.log(`\n--- Ultrawork result ---`);
        console.log(`verified: ${res.verified ? "YES ✅" : "NO ❌"} | iterations: ${res.iterations}`);
        if (res.verdict) console.log(`verdict: ${res.verdict.reason}`);
        return res.verified ? 0 : 2;
      }

      const res = await runAgent({ task, cwd, model, role, plugins: loadPlugins(), maxTurns, onEvent: printEvent });
      console.log(`\n--- Run result ---`);
      console.log(`finished: ${res.finished ? "YES ✅" : "NO (stopped)"} | turns: ${res.turns} | tokens in/out: ${res.tokensIn}/${res.tokensOut} | compactions: ${res.compactions}`);
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
