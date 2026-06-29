// init-deep — suggests hierarchical project memory (AGENTS.md) when a project
// is non-trivial and lacks one. Invoked as a skill ($init-deep) to actually
// generate it; this hook just surfaces the suggestion at SessionStart.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import type { HookPlugin } from "../types/index.js";

async function projectFileCount(cwd: string): Promise<number> {
  let count = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      if (e.isDirectory()) await walk(join(dir, e.name), depth + 1);
      else count++;
    }
    if (count > 200) return;
  }
  await walk(cwd, 0);
  return count;
}

export default {
  name: "init-deep",
  hooks: {
    async SessionStart(_input, api) {
      if (existsSync(join(api.cwd, "AGENTS.md"))) return undefined;
      const count = await projectFileCount(api.cwd);
      if (count >= 8) {
        return {
          inject: `Tip: this project has ~${count} files but no AGENTS.md. Run \`lazyglm skill init-deep\` to generate hierarchical project memory that future sessions can use.`,
        };
      }
      return undefined;
    },
  },
} satisfies HookPlugin;
