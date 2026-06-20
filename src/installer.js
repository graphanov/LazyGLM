// `lazyglm install` — scaffolds .lazyglm/ in a project and writes an AGENTS.md
// template if absent. Clean-room analog of `npx lazycodex-ai install` (which
// bootstraps the OMO plugin into Codex); here the harness is self-contained,
// so install just initializes the per-project state.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { ensureDir, readJson, writeJson, gitInfo, looksLikeProject } from "./util.js";

const AGENTS_TEMPLATE = `# AGENTS.md

This project uses **LazyGLM** — a GLM-native agent harness. Agents working in
this repo should follow the rules below.

## Working rules

- Read before you write. Prefer targeted edits over full rewrites.
- Verify every change with a build or test before claiming success.
- Keep code clean: no placeholder TODOs, no narration comments, no AI-slop.
- Commit logical units of work with clear messages.

## Project layout

- \`src/\` — application source
- \`test/\` — tests (run with \`npm test\`)
- \`.lazyglm/\` — LazyGLM runtime state (sessions, telemetry, plans) — do not edit by hand

## Commands

- \`npm test\` — run the test suite
- \`npm run build\` — build (if applicable)

Add project-specific guidance below as the codebase grows.
`;

export async function install({ cwd, force = false } = {}) {
  const dir = cwd || process.cwd();
  const created = [];

  const lazyDir = join(dir, ".lazyglm");
  await ensureDir(lazyDir);
  created.push(".lazyglm/");
  for (const sub of ["rules", "plans", "sessions"]) {
    await ensureDir(join(lazyDir, sub));
    created.push(`.lazyglm/${sub}/`);
  }

  // per-project config (model from catalog default)
  const configPath = join(lazyDir, "config.json");
  if (force || !existsSync(configPath)) {
    await writeJson(configPath, {
      installedAt: new Date().toISOString(),
      version: await readVersion(),
      provider: { base_url: "https://api.z.ai/api/coding/paas/v4" },
      model: "glm-5.2",
    });
    created.push(".lazyglm/config.json");
  }

  // AGENTS.md template
  const agentsPath = join(dir, "AGENTS.md");
  if (force || !existsSync(agentsPath)) {
    await writeFile(agentsPath, AGENTS_TEMPLATE, "utf8");
    created.push("AGENTS.md");
  }

  // gitignore for runtime state
  const giPath = join(dir, ".gitignore");
  const entry = ".lazyglm/";
  let gi = "";
  if (existsSync(giPath)) gi = await readFile(giPath, "utf8");
  if (!gi.split("\n").includes(entry)) {
    await writeFile(giPath, (gi ? gi.replace(/\n?$/, "\n") : "") + entry + "\n", "utf8");
    created.push(".gitignore (+.lazyglm/)");
  }

  return { cwd: dir, created, git: gitInfo(dir), isProject: looksLikeProject(dir) };
}

export async function uninstall({ cwd } = {}) {
  const dir = cwd || process.cwd();
  const lazyDir = join(dir, ".lazyglm");
  if (existsSync(lazyDir)) {
    await rm(lazyDir, { recursive: true, force: true });
  }
  return { cwd: dir, removed: [".lazyglm/"] };
}

async function readVersion() {
  try {
    const pkg = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"));
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}
