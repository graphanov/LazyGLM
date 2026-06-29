// executor-verify — Stop hook. When the agent calls finish, sanity-checks that
// the files it actually wrote via tools still exist on disk. Uses the
// runtime-tracked files_written list (robust) rather than regex-guessing file
// paths from the finish prose (which falsely matched CDN module specifiers
// like "three@0.160.0/build/three.module.js").
import { existsSync } from "node:fs";
import { resolvePath } from "../util.js";
import type { HookPlugin } from "../types/index.js";

export default {
  name: "executor-verify",
  hooks: {
    async Stop(input, api) {
      if (!input.finished) return undefined;
      const written = Array.isArray(input.files_written)
        ? input.files_written.filter((file): file is string => typeof file === "string")
        : [];
      if (!written.length) return undefined;
      const missing = [];
      for (const rel of written) {
        try {
          if (!existsSync(resolvePath(rel, api.cwd))) missing.push(rel);
        } catch {
          // path escapes root or unresolvable — skip
        }
      }
      if (missing.length) {
        return {
          feedback: `executor-verify: files written during the run are now missing on disk: ${missing.join(", ")}.`,
        };
      }
      return undefined;
    },
  },
} satisfies HookPlugin;
