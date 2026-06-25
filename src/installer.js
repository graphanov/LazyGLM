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

function isGitignoreEntry(line, entry) {
  return line.replace(/\r$/, "") === entry;
}

function gitignoreHasEntry(text, entry) {
  return text.split("\n").some((line) => isGitignoreEntry(line, entry));
}

function asConfig(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function configWithDefaults(config = {}) {
  config = asConfig(config);
  return {
    installedAt: config.installedAt || new Date().toISOString(),
    version: config.version || await readVersion(),
    provider: config.provider || { base_url: "https://api.z.ai/api/coding/paas/v4" },
    model: config.model || "glm-5.2",
    ...config,
  };
}

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
  const previousConfig = existsSync(configPath) ? asConfig(await readJson(configPath, {})) : {};
  if (force || !existsSync(configPath)) {
    await writeJson(configPath, await configWithDefaults({
      ...(previousConfig.gitignoreOwnedByLazyglm === true ? { gitignoreOwnedByLazyglm: true } : {}),
      ...(previousConfig.gitignoreFileOwnedByLazyglm === true ? { gitignoreFileOwnedByLazyglm: true } : {}),
      ...(previousConfig.agentsOwnedByLazyglm === true ? { agentsOwnedByLazyglm: true } : {}),
    }));
    created.push(".lazyglm/config.json");
  }
  const existingConfig = existsSync(configPath) ? asConfig(await readJson(configPath, {})) : previousConfig;

  // AGENTS.md template. Track whether install wrote it so uninstall never
  // deletes a user-owned file that merely happens to equal the default template.
  const agentsPath = join(dir, "AGENTS.md");
  let agentsOwnedByLazyglm = existingConfig.agentsOwnedByLazyglm === true;
  if (force || !existsSync(agentsPath)) {
    await writeFile(agentsPath, AGENTS_TEMPLATE, "utf8");
    created.push("AGENTS.md");
    agentsOwnedByLazyglm = true;
  }

  // gitignore for runtime state. Track whether WE added the `.lazyglm/` entry
  // so uninstall can avoid deleting user-owned ignore configuration. A project
  // may already have ignored `.lazyglm/` before install ran; in that case the
  // entry is not ours to remove and install/uninstall must be a safe round trip.
  const giPath = join(dir, ".gitignore");
  const entry = ".lazyglm/";
  let gi = "";
  const gitignoreFileExisted = existsSync(giPath);
  if (gitignoreFileExisted) gi = await readFile(giPath, "utf8");
  const alreadyIgnored = gitignoreHasEntry(gi, entry);
  let gitignoreOwnedByLazyglm = existingConfig.gitignoreOwnedByLazyglm === true;
  let gitignoreFileOwnedByLazyglm = existingConfig.gitignoreFileOwnedByLazyglm === true;
  if (!alreadyIgnored) {
    await writeFile(giPath, (gi ? gi.replace(/\n?$/, "\n") : "") + entry + "\n", "utf8");
    created.push(".gitignore (+.lazyglm/)");
    gitignoreOwnedByLazyglm = true;
    if (!gitignoreFileExisted) gitignoreFileOwnedByLazyglm = true;
  }

  // Persist ownership markers into config so uninstall knows whether it owns
  // files/entries. Preserve previous true markers across repeat installs; once
  // LazyGLM owns an artifact, a later idempotent install must not demote it to
  // user-owned merely because the file/line is already present. Always write a
  // full config shape so malformed existing config is repaired instead of
  // becoming a partial ownership-only file.
  if (existsSync(configPath)) {
    await writeJson(configPath, await configWithDefaults({
      ...existingConfig,
      agentsOwnedByLazyglm,
      gitignoreOwnedByLazyglm,
      gitignoreFileOwnedByLazyglm,
    }));
  }

  return { cwd: dir, created, git: gitInfo(dir), isProject: looksLikeProject(dir) };
}

export async function uninstall({ cwd } = {}) {
  const dir = cwd || process.cwd();
  const lazyDir = join(dir, ".lazyglm");
  const removed = [];
  const preserved = [];

  // Capture ownership BEFORE removing .lazyglm/, since config.json lives inside
  // that directory. install() records which artifacts it created; if a marker is
  // absent (older install, malformed config, or pre-existing user file), fail
  // closed and preserve user-facing files/entries.
  let ownsAgentsFile = false;
  let ownsGitignoreFile = false;
  let ownsGitignoreEntry = false;
  const configPath = join(lazyDir, "config.json");
  if (existsSync(configPath)) {
    const cfg = asConfig(await readJson(configPath, {}));
    ownsAgentsFile = cfg.agentsOwnedByLazyglm === true;
    ownsGitignoreFile = cfg.gitignoreFileOwnedByLazyglm === true;
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
    if (ownsAgentsFile && content === AGENTS_TEMPLATE) {
      await unlink(agentsPath);
      removed.push("AGENTS.md");
    } else {
      preserved.push("AGENTS.md");
    }
  }

  // .gitignore: remove the `.lazyglm/` entry ONLY if lazyglm install owned it.
  // Delete the .gitignore file itself only if LazyGLM also created the file;
  // otherwise preserve user-owned empty/placeholder .gitignore files.
  const giPath = join(dir, ".gitignore");
  const entry = ".lazyglm/";
  if (existsSync(giPath)) {
    const gi = await readFile(giPath, "utf8");
    const lines = gi.split("\n");
    const hasEntry = lines.some((line) => isGitignoreEntry(line, entry));
    if (ownsGitignoreEntry && hasEntry) {
      const filtered = lines.filter((l) => !isGitignoreEntry(l, entry));
      const result = filtered.join("\n");
      if (result.trim() === "" && ownsGitignoreFile) {
        await unlink(giPath);
      } else {
        await writeFile(giPath, result, "utf8");
      }
      removed.push(".gitignore (-.lazyglm/)");
    } else if (hasEntry) {
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
