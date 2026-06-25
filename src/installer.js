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
  const existingConfig = existsSync(configPath) ? await readJson(configPath).catch(() => ({})) : {};

  // AGENTS.md template
  const agentsPath = join(dir, "AGENTS.md");
  if (force || !existsSync(agentsPath)) {
    await writeFile(agentsPath, AGENTS_TEMPLATE, "utf8");
    created.push("AGENTS.md");
  }

  // gitignore for runtime state. Track whether WE added the `.lazyglm/` entry
  // so uninstall can avoid deleting user-owned ignore configuration. A project
  // may already have ignored `.lazyglm/` before install ran; in that case the
  // entry is not ours to remove and install/uninstall must be a safe round trip.
  const giPath = join(dir, ".gitignore");
  const entry = ".lazyglm/";
  let gi = "";
  if (existsSync(giPath)) gi = await readFile(giPath, "utf8");
  const alreadyIgnored = gi.split("\n").includes(entry);
  let gitignoreOwnedByLazyglm = existingConfig.gitignoreOwnedByLazyglm === true;
  if (!alreadyIgnored) {
    await writeFile(giPath, (gi ? gi.replace(/\n?$/, "\n") : "") + entry + "\n", "utf8");
    created.push(".gitignore (+.lazyglm/)");
    gitignoreOwnedByLazyglm = true;
  }

  // Persist ownership marker into config so uninstall knows whether it owns the
  // `.lazyglm/` gitignore line. Preserve a previous true marker across repeat
  // installs; once LazyGLM owns the entry, a later idempotent install must not
  // demote it to user-owned merely because the line is already present.
  if (existsSync(configPath)) {
    await writeJson(configPath, {
      ...existingConfig,
      gitignoreOwnedByLazyglm,
    });
  }

  return { cwd: dir, created, git: gitInfo(dir), isProject: looksLikeProject(dir) };
}

export async function uninstall({ cwd } = {}) {
  const dir = cwd || process.cwd();
  const lazyDir = join(dir, ".lazyglm");
  const removed = [];
  const preserved = [];

  // Capture gitignore ownership BEFORE removing .lazyglm/, since config.json
  // lives inside that directory. install() records whether it added the
  // `.lazyglm/` gitignore entry; if the marker is absent (older install or the
  // entry pre-existed), treat the entry as user-owned and preserve it.
  let ownsGitignoreEntry = false;
  const configPath = join(lazyDir, "config.json");
  if (existsSync(configPath)) {
    const cfg = await readJson(configPath).catch(() => ({}));
    ownsGitignoreEntry = cfg.gitignoreOwnedByLazyglm === true;
  }

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

  // .gitignore: remove the `.lazyglm/` entry ONLY if lazyglm install owned it.
  // If we own it and the file becomes empty/whitespace-only after removal,
  // delete the file too (install created it, so removing it is true round-trip
  // honesty). Otherwise preserve the entry and report it.
  const giPath = join(dir, ".gitignore");
  const entry = ".lazyglm/";
  if (existsSync(giPath)) {
    const gi = await readFile(giPath, "utf8");
    const lines = gi.split("\n");
    if (ownsGitignoreEntry && lines.includes(entry)) {
      const filtered = lines.filter((l) => l !== entry);
      const result = filtered.join("\n");
      if (result.trim() === "") {
        await unlink(giPath);
      } else {
        await writeFile(giPath, result, "utf8");
      }
      removed.push(".gitignore (-.lazyglm/)");
    } else if (lines.includes(entry)) {
      preserved.push(".gitignore (user-owned .lazyglm/ entry preserved)");
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
