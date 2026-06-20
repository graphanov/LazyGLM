// executor-verify — Stop hook. When the agent calls finish, sanity-checks the
// finish summary: file paths it references must actually exist on disk.
// Surfaces missing files as feedback (a real signal, not a rubber stamp).
import { existsSync } from "node:fs";
import { resolvePath } from "../util.js";

const FILE_RE = /[\w./@-]+\.(js|mjs|cjs|ts|tsx|jsx|html|htm|css|scss|json|md|py|go|rs|java|c|cpp|h|hpp|rb|php|cs|swift|kt|glb|gltf|png|jpg|webp|svg|wasm|toml|yaml|yml|sh)/g;

export default {
  name: "executor-verify",
  hooks: {
    async Stop(input, api) {
      if (!input.finished) return undefined;
      const summary = typeof input.response === "string" ? input.response : "";
      if (!summary) return undefined;

      const candidates = [...new Set([...summary.matchAll(FILE_RE)].map((m) => m[0]))];
      const missing = [];
      for (const c of candidates.slice(0, 40)) {
        try {
          if (!existsSync(resolvePath(c, api.cwd))) missing.push(c);
        } catch {
          // path escapes root or otherwise unresolvable — skip
        }
      }
      if (missing.length) {
        return {
          feedback: `executor-verify: the finish summary references file(s) not found on disk: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ` (+${missing.length - 10} more)` : ""}. Create them, or correct the summary.`,
        };
      }
      return undefined;
    },
  },
};
