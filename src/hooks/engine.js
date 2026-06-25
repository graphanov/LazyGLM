// Hook engine: registers plugins and fires lifecycle events. Collects
// decisions, context injections, and feedback from all subscribed plugins.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { abortReason, throwIfAborted, withAbort } from "../agent/deadline.js";
import { buildHookInput, isBlock } from "./schema.js";
import { nowIso, truncate } from "../util.js";

export class HookEngine {
  constructor({ cwd, log = () => {} } = {}) {
    this.cwd = cwd;
    this.log = log;
    this.plugins = [];
    this.sessionId = `sess_${Date.now().toString(36)}`;
    this.turnId = 0;
    this.transcriptPath = null;
    this.model = "";
    this.permissionMode = "auto";
  }

  register(plugin) {
    if (!plugin || !plugin.name) throw new Error("plugin missing name");
    this.plugins.push(plugin);
  }

  setMeta({ model, transcriptPath, permissionMode } = {}) {
    if (model) this.model = model;
    if (transcriptPath !== undefined) this.transcriptPath = transcriptPath;
    if (permissionMode) this.permissionMode = permissionMode;
  }

  nextTurn() {
    this.turnId += 1;
    return `${this.sessionId}-${this.turnId}`;
  }

  api({ signal } = {}) {
    const cwd = this.cwd;
    return {
      cwd,
      signal,
      sessionId: this.sessionId,
      log: (msg) => this.log(msg),
      readFile: async (rel) => {
        const abs = join(cwd, rel);
        if (!existsSync(abs)) return null;
        return readFile(abs, "utf8");
      },
      readFileAbs: async (abs) => {
        if (!existsSync(abs)) return null;
        return readFile(abs, "utf8");
      },
    };
  }

  /**
   * Fire an event. Returns aggregated results.
   * @returns {{ blocks: string[], injects: string[], feedbacks: string[], results: any[] }}
   */
  async fire(event, fields = {}, { signal } = {}) {
    throwIfAborted(signal);
    const meta = {
      sessionId: this.sessionId,
      turnId: this.nextTurn(),
      transcriptPath: this.transcriptPath,
      cwd: this.cwd,
      model: this.model,
      permissionMode: this.permissionMode,
    };
    const input = buildHookInput(event, fields, meta);
    const blocks = [];
    const injects = [];
    const feedbacks = [];
    const results = [];
    const api = this.api({ signal });

    for (const plugin of this.plugins) {
      throwIfAborted(signal);
      const handler = plugin.hooks?.[event];
      if (typeof handler !== "function") continue;
      let result;
      try {
        result = await withAbort(Promise.resolve().then(() => handler(input, api)), signal);
      } catch (err) {
        if (signal?.aborted) throw abortReason(signal, err);
        this.log(`[hook] ${plugin.name}.${event} threw: ${err?.message || err}`);
        continue;
      }
      results.push({ plugin: plugin.name, result });
      if (isBlock(result)) {
        blocks.push(`[${plugin.name}] ${result.reason || "blocked"}`);
      }
      if (result?.inject) injects.push(result.inject);
      if (result?.feedback) feedbacks.push(`[${plugin.name}] ${result.feedback}`);
    }

    return { blocks, injects, feedbacks, results };
  }
}

export function formatStatus(pluginName, event, msg) {
  return `(LazyGLM/${pluginName}) ${event}: ${truncate(msg, 200)}`;
}
