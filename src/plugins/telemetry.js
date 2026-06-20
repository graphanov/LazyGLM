// telemetry — local-only, privacy-preserving. Records session lifecycle and
// token usage to .lazyglm/telemetry.jsonl. No external calls (the original
// used PostHog; the GLM port defaults to local-only by design).
import { join } from "node:path";
import { appendFile } from "node:fs/promises";
import { ensureDir, nowIso } from "../util.js";

export default {
  name: "telemetry",
  hooks: {
    async SessionStart(input, api) {
      const path = join(api.cwd, ".lazyglm", "telemetry.jsonl");
      await ensureDir(join(path, ".."));
      await appendFile(path, JSON.stringify({ t: nowIso(), event: "session_start", session_id: input.session_id, cwd: input.cwd, model: input.model }) + "\n");
      return undefined;
    },
    async Stop(input, api) {
      const path = join(api.cwd, ".lazyglm", "telemetry.jsonl");
      await appendFile(
        path,
        JSON.stringify({ t: nowIso(), event: "stop", session_id: input.session_id, finished: !!input.finished, response: typeof input.response === "string" ? input.response.slice(0, 300) : null }) + "\n",
      );
      return undefined;
    },
  },
};
