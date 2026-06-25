// Tool layer for the GLM agent. Each tool is an OpenAI function spec plus a
// handler. Handlers run sandboxed to the project cwd unless explicitly escaped.
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, isAbsolute, resolve } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readLines, listDirEntries, resolvePath, ensureDir, truncate } from "../util.js";
import { abortReason, boundedTimeoutMs, isDeadlineError } from "./deadline.js";

const execP = promisify(exec);

// --- Tool specs (OpenAI function-calling schema) ---
export const TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the project. Returns numbered lines. Use offset/limit for large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative or absolute path." },
          offset: { type: "integer", description: "1-indexed line to start at (default 1)." },
          limit: { type: "integer", description: "Max lines to read (default 500)." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file with the given content. Creates parent dirs. Use for new files or full rewrites.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string", description: "Full file content." },
          consequence_prediction: {
            type: "string",
            description: "1-3 sentences forecasting intended effect, affected files, likely failure modes, and verification/mitigation before writing.",
          },
        },
        required: ["path", "content", "consequence_prediction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "patch_file",
      description: "Targeted find-and-replace in a file. old_string must match exactly and uniquely unless replace_all=true. Prefer this over write_file for small edits.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
          consequence_prediction: {
            type: "string",
            description: "1-3 sentences forecasting intended effect, affected files, likely failure modes, and verification/mitigation before patching.",
          },
        },
        required: ["path", "old_string", "new_string", "consequence_prediction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List entries in a directory (dirs first). Hides .git/node_modules.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory (default '.')." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with a regex. Returns matching lines with file:line. Searches the whole project by default.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern." },
          path: { type: "string", description: "File or dir to search (default '.')." },
          glob: { type: "string", description: "Optional filename glob, e.g. '*.js'." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "Run a shell command in the project cwd. Use for builds, tests, git, installs. Output is capped.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout: { type: "integer", description: "Seconds before kill (default 120, max 600)." },
          consequence_prediction: {
            type: "string",
            description: "1-3 sentences forecasting command effects, likely failure modes, expected filesystem/process changes, and verification/mitigation.",
          },
        },
        required: ["command", "consequence_prediction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Signal that the task is complete. Call exactly once when done, with a concise summary of what was accomplished and how to verify.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "What was done + how to verify (commands/files)." },
        },
        required: ["summary"],
      },
    },
  },
];

export const TOOL_NAMES = TOOL_SPECS.map((t) => t.function.name);

// --- Handlers ---
// ctx = { cwd, runtime }
export const TOOL_HANDLERS = {
  async read_file({ path, offset, limit }, ctx) {
    const abs = resolvePath(path, ctx.cwd);
    if (!existsSync(abs)) return `Error: file not found: ${path}`;
    const out = await readLines(abs, offset || 1, limit || 500);
    return out || "(empty file)";
  },

  async write_file({ path, content }, ctx) {
    const abs = resolvePath(path, ctx.cwd);
    await ensureDir(join(abs, ".."));
    await writeFile(abs, content ?? "", "utf8");
    return `wrote ${path} (${(content ?? "").length} bytes)`;
  },

  async patch_file({ path, old_string, new_string, replace_all }, ctx) {
    const abs = resolvePath(path, ctx.cwd);
    if (!existsSync(abs)) return `Error: file not found: ${path}`;
    const original = await readFile(abs, "utf8");
    if (!original.includes(old_string)) {
      return `Error: old_string not found in ${path}. Make sure it matches exactly (whitespace included).`;
    }
    const count = replace_all ? Infinity : 1;
    let occurrences = 0;
    let result;
    if (replace_all) {
      result = original.split(old_string).join(new_string);
      occurrences = original.split(old_string).length - 1;
    } else {
      const idx = original.indexOf(old_string);
      if (idx === -1) return `Error: old_string not found in ${path}.`;
      // uniqueness check
      const second = original.indexOf(old_string, idx + 1);
      if (second !== -1) {
        return `Error: old_string is not unique in ${path} (found at >=2 positions). Add more context or set replace_all=true.`;
      }
      result = original.slice(0, idx) + new_string + original.slice(idx + old_string.length);
      occurrences = 1;
    }
    await writeFile(abs, result, "utf8");
    return `patched ${path} (${occurrences} replacement${occurrences === 1 ? "" : "s"})`;
  },

  async list_dir({ path }, ctx) {
    const abs = resolvePath(path || ".", ctx.cwd);
    if (!existsSync(abs)) return `Error: dir not found: ${path}`;
    const entries = await listDirEntries(abs);
    if (!entries.length) return "(empty)";
    return entries.map((e) => (e.isDir ? `${e.name}/` : e.name)).join("\n");
  },

  async grep({ pattern, path, glob }, ctx) {
    const root = resolvePath(path || ".", ctx.cwd);
    // prefer ripgrep for speed; fall back to JS walk
    try {
      const args = ["-n", "-H"];
      if (glob) args.push("-g", glob);
      args.push("--", pattern, root);
      const { stdout } = await execP(`rg ${args.map(shellQuote).join(" ")}`, {
        maxBuffer: 4 * 1024 * 1024,
      });
      return truncate(stdout || "(no matches)", 8000);
    } catch (err) {
      if (err.stdout !== undefined) {
        // rg returns exit 1 on no matches — that's fine
        if (err.code === 1 || err.code === 2) return truncate(err.stdout || "(no matches)", 8000);
      }
    }
    return jsGrep(pattern, root, glob);
  },

  async run_shell({ command, timeout }, ctx) {
    const secs = Math.min(Math.max(timeout || 120, 1), 600);
    const deadline = ctx.runtime?.deadline;
    deadline?.throwIfExpired?.();
    const signal = deadline?.signal || ctx.runtime?.signal;
    const timeoutMs = boundedTimeoutMs(secs * 1000, deadline);
    try {
      const { stdout, stderr } = await execP(command, {
        cwd: ctx.cwd,
        timeout: timeoutMs,
        signal,
        maxBuffer: 8 * 1024 * 1024,
      });
      const out = [stdout, stderr].filter(Boolean).join("\n");
      return truncate(out || "(no output)", 12000);
    } catch (err) {
      if (isDeadlineError(err) || signal?.aborted) throw abortReason(signal, err);
      const out = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n");
      return `Command exited ${err.code ?? "?"}:\n${truncate(out, 12000)}`;
    }
  },

  async finish({ summary }, ctx) {
    return { __finish: true, summary: summary || "(no summary)" };
  },
};

function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

async function jsGrep(pattern, root, glob) {
  const re = new RegExp(pattern);
  const results = [];
  const seen = new Set();
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".git") || e.name === "node_modules") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        if (glob && !minimatch(e.name, glob)) continue;
        if (seen.has(full)) continue;
        seen.add(full);
        try {
          const text = await readFile(full, "utf8");
          text.split("\n").forEach((line, i) => {
            if (re.test(line)) {
              results.push(`${relative(root, full)}:${i + 1}:${line}`);
            }
          });
        } catch {
          // binary / unreadable
        }
      }
      if (results.length > 200) return;
    }
  }
  await walk(root);
  return truncate(results.join("\n") || "(no matches)", 8000);
}

function minimatch(name, glob) {
  // minimal glob: handle * and exact suffix
  const g = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${g}$`).test(name);
}
