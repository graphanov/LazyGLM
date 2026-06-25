// `lazyglm install` — scaffolds .lazyglm/ in a project and writes an AGENTS.md
// template if absent. Clean-room analog of `npx lazycodex-ai install` (which
// bootstraps the OMO plugin into Codex); here the harness is self-contained,
// so install just initializes the per-project state.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdir, writeFile, readFile, rm, unlink } from "node:fs/promises";
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
  const removed = [];
  const preserved = [];

  // Remove the .lazyglm/ runtime directory wholesale.
  if (existsSync(lazyDir)) {
    await rm(lazyDir, { recursive: true, force: true });
    removed.push(".lazyglm/");
  }

  // AGENTS.md: remove only if it still equals the install template verbatim.
  // If the user customized it, preserve it and report it as preserved.
  const agentsPath = join(dir, "AGENTS.md");
  if (existsSync(agentsPath)) {
    const content = await readFile(agentsPath, "utf8");
    if (content === AGENTS_TEMPLATE) {
      await unlink(agentsPath);
      removed.push("AGENTS.md");
    } else {
      preserved.push("AGENTS.md");
    }
  }

  // .gitignore: remove the lazyglm-owned `.lazyglm/` entry (purely runtime
  // state, never user content), preserving all other lines. If the file ends
  // up empty/whitespace-only after removal, delete it — that is true
  // round-trip honesty (install created it if it didn't exist).
  const giPath = join(dir, ".gitignore");
  const entry = ".lazyglm/";
  if (existsSync(giPath)) {
    const gi = await readFile(giPath, "utf8");
    const lines = gi.split("\n");
    if (lines.includes(entry)) {
      const filtered = lines.filter((l) => l !== entry);
      const result = filtered.join("\n");
      if (result.trim() === "") {
        await unlink(giPath);
      } else {
        await writeFile(giPath, result, "utf8");
      }
      removed.push(".gitignore (-.lazyglm/)");
    }
  }

  return { cwd: dir, removed, preserved };
}

async function readVersion() {
  try {
    const pkg = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"));
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}
