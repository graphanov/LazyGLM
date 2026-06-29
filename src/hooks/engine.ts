// Hook engine: registers plugins and fires lifecycle events. Collects
// decisions, context injections, and feedback from all subscribed plugins.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { abortReason, throwIfAborted, withAbort } from "../agent/deadline.js";
import { buildHookInput, isBlock } from "./schema.js";
import { truncate } from "../util.js";
import type {
  HookEngineContract,
  HookEventName,
  HookFireResult,
  HookMeta,
  HookPlugin,
  HookPluginApi,
  HookResult,
  PermissionMode,
} from "../types/index.js";

interface HookEngineOptions {
  cwd?: string;
  log?: (message: string) => void;
}

interface HookEngineMeta {
  model?: string;
  transcriptPath?: string | null;
  permissionMode?: PermissionMode;
}

interface HookEngineFireOptions {
  signal?: AbortSignal;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class HookEngine implements HookEngineContract {
  cwd: string;
  log: (message: string) => void;
  plugins: HookPlugin[];
  sessionId: string;
  turnId: number;
  transcriptPath: string | null;
  model: string;
  permissionMode: PermissionMode;

  constructor({ cwd, log = () => {} }: HookEngineOptions = {}) {
    this.cwd = cwd as string;
    this.log = log;
    this.plugins = [];
    this.sessionId = `sess_${Date.now().toString(36)}`;
    this.turnId = 0;
    this.transcriptPath = null;
    this.model = "";
    this.permissionMode = "auto";
  }

  register(plugin: HookPlugin): void {
    if (!plugin || !plugin.name) throw new Error("plugin missing name");
    this.plugins.push(plugin);
  }

  setMeta({ model, transcriptPath, permissionMode }: HookEngineMeta = {}): void {
    if (model) this.model = model;
    if (transcriptPath !== undefined) this.transcriptPath = transcriptPath;
    if (permissionMode) this.permissionMode = permissionMode;
  }

  nextTurn(): string {
    this.turnId += 1;
    return `${this.sessionId}-${this.turnId}`;
  }

  api({ signal }: HookEngineFireOptions = {}): HookPluginApi {
    const cwd = this.cwd;
    return {
      cwd,
      signal,
      sessionId: this.sessionId,
      log: (msg: string) => this.log(msg),
      readFile: async (rel: string) => {
        const abs = join(cwd, rel);
        if (!existsSync(abs)) return null;
        return readFile(abs, "utf8");
      },
      readFileAbs: async (abs: string) => {
        if (!existsSync(abs)) return null;
        return readFile(abs, "utf8");
      },
    };
  }

  /**
   * Fire an event and aggregate blocks, injections, feedback, and plugin results.
   */
  async fire(event: HookEventName, fields: Record<string, unknown> = {}, { signal }: HookEngineFireOptions = {}): Promise<HookFireResult> {
    throwIfAborted(signal);
    const meta: HookMeta = {
      sessionId: this.sessionId,
      turnId: this.nextTurn(),
      transcriptPath: this.transcriptPath,
      cwd: this.cwd,
      model: this.model,
      permissionMode: this.permissionMode,
    };
    const input = buildHookInput(event, fields, meta);
    const blocks: string[] = [];
    const injects: string[] = [];
    const feedbacks: string[] = [];
    const results: Array<{ plugin: string; result: HookResult }> = [];
    const api = this.api({ signal });

    for (const plugin of this.plugins) {
      throwIfAborted(signal);
      const handler = plugin.hooks?.[event];
      if (typeof handler !== "function") continue;
      let result;
      try {
        result = await withAbort(Promise.resolve().then(() => handler(input, api)), signal);
      } catch (err) {
        if (signal?.aborted) throw abortReason(signal, err instanceof Error ? err : undefined);
        this.log(`[hook] ${plugin.name}.${event} threw: ${errorMessage(err)}`);
        continue;
      }
      results.push({ plugin: plugin.name, result });
      if (isBlock(result)) {
        blocks.push(`[${plugin.name}] ${result.reason || "blocked"}`);
      }
      if (result && "inject" in result) injects.push(result.inject);
      if (result && "feedback" in result) feedbacks.push(`[${plugin.name}] ${result.feedback}`);
    }

    return { blocks, injects, feedbacks, results };
  }
}

export function formatStatus(pluginName: string, event: HookEventName, msg: string): string {
  return `(LazyGLM/${pluginName}) ${event}: ${truncate(msg, 200)}`;
}
