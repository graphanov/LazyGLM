// rules — injects project context (AGENTS.md, .lazyglm/rules/*.md) into the
// agent's system prompt at SessionStart, with a light reminder at
// UserPromptSubmit. Clean-room rewrite of the OMO rules component.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { truncate } from "../util.js";
import type { HookPlugin } from "../types/index.js";

const MAX_AGENTS_CHARS = 8000;
const MAX_RULE_CHARS = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export default {
  name: "rules",
  hooks: {
    async SessionStart(_input, api) {
      const parts = [];

      const agentsPath = join(api.cwd, "AGENTS.md");
      if (existsSync(agentsPath)) {
        const text = await readFile(agentsPath, "utf8");
        parts.push(`# AGENTS.md (project rules)\n${truncate(text, MAX_AGENTS_CHARS)}`);
      }

      const rulesDir = join(api.cwd, ".lazyglm", "rules");
      if (existsSync(rulesDir)) {
        let files: string[] = [];
        try {
          files = (await readdir(rulesDir)).filter((f) => f.endsWith(".md")).sort();
        } catch {}
        for (const f of files) {
          const text = await readFile(join(rulesDir, f), "utf8");
          parts.push(`# project rule: ${f}\n${truncate(text, MAX_RULE_CHARS)}`);
        }
      }

      // Surface a project inventory line so the model knows the lay of the land.
      const pkgPath = join(api.cwd, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as unknown;
          const pkgRecord = isRecord(pkg) ? pkg : {};
          const scripts = isRecord(pkgRecord.scripts) ? pkgRecord.scripts : {};
          const dependencies = isRecord(pkgRecord.dependencies) ? pkgRecord.dependencies : {};
          const devDependencies = isRecord(pkgRecord.devDependencies) ? pkgRecord.devDependencies : {};
          const summary = [
            `name: ${typeof pkgRecord.name === "string" ? pkgRecord.name : "?"}`,
            `scripts: ${Object.keys(scripts).join(", ") || "(none)"}`,
            `deps: ${Object.keys({ ...dependencies, ...devDependencies }).slice(0, 20).join(", ") || "(none)"}`,
          ].join(" | ");
          parts.push(`# package.json\n${summary}`);
        } catch {}
      }

      if (!parts.length) {
        return { inject: "No AGENTS.md or .lazyglm/rules found in this project. Follow general good practice." };
      }
      return { inject: parts.join("\n\n---\n\n") };
    },

    async UserPromptSubmit(_input, api) {
      const agentsPath = join(api.cwd, "AGENTS.md");
      if (!existsSync(agentsPath)) return undefined;
      try {
        const st = await stat(agentsPath);
        return { inject: `Reminder: an AGENTS.md (project rules) is in effect (modified ${st.mtime.toISOString().slice(0, 10)}). Follow it.` };
      } catch {
        return undefined;
      }
    },
  },
} satisfies HookPlugin;
