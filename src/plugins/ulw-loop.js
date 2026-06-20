// ulw-loop — Ultrawork verified-completion loop. Detects the `$ulw-loop`
// trigger (or --completion-promise) on UserPromptSubmit and enforces the
// contract: keep working until the completion promise is objectively met and
// verified, not merely claimed. The loop orchestration lives in src/ulw.js;
// this plugin surfaces the contract to the model and records iterations.
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, nowIso } from "../util.js";

export const ultraworkState = new Map(); // sessionId -> { completionPromise, iterations }

function parseCompletionPromise(prompt) {
  const m = prompt.match(/--completion-promise=(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (m) return m[1] || m[2] || m[3];
  // also accept "completion promise: ..."
  const m2 = prompt.match(/completion promise\s*[:=]\s*(.+)/i);
  if (m2) return m2[1].trim().slice(0, 500);
  return null;
}

export function isUltrawork(prompt) {
  return /\$ulw-loop\b|--ultrawork\b/i.test(prompt || "");
}

export default {
  name: "ulw-loop",
  hooks: {
    async UserPromptSubmit(input, api) {
      const prompt = input.prompt || "";
      if (!isUltrawork(prompt)) return undefined;
      const promise = parseCompletionPromise(prompt) || "the task is fully implemented, builds cleanly, and passes verification.";
      ultraworkState.set(input.session_id, { completionPromise: promise, iterations: 0 });
      const path = join(api.cwd, ".lazyglm", "telemetry.jsonl");
      try {
        await ensureDir(join(path, ".."));
        await appendFile(path, JSON.stringify({ t: nowIso(), event: "ultrawork_start", session_id: input.session_id, completionPromise: promise }) + "\n");
      } catch {}
      return {
        inject: `ULTRAWORK MODE is active. Completion promise: "${promise}". You must keep working — reading, editing, running builds/tests — until this promise is objectively met. Do not call finish until you can point to concrete evidence (passing build/test output, files that exist). Verbal claims without verification are not acceptable.`,
      };
    },
    async Stop(input, api) {
      const st = ultraworkState.get(input.session_id);
      if (!st) return undefined;
      st.iterations += 1;
      if (!input.finished) {
        return { feedback: `ultrawork: you stopped without calling finish. The completion promise is not yet met: "${st.completionPromise}". Continue working.` };
      }
      return undefined;
    },
  },
};
