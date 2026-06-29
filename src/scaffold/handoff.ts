import { existsSync, lstatSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { truncate } from "../util.js";

const HANDOFF_CANDIDATES = [
  { rel: ".osc/handoff.md", source: ".osc/handoff.md" },
  { rel: "MISSION.md", source: "MISSION.md" },
];

// Upper bound on how many bytes we read from disk for a single handoff
// candidate. Keeps startup bounded even if a repo accidentally contains a
// multi-gigabyte handoff/mission record. A small sentinel past maxChars is
// included so truncation can still be detected when the file is slightly
// larger than the configured budget.
const MAX_HANDOFF_READ_BYTES = 16 * 1024;

export interface ScaffoldDiscovery {
  present: boolean;
  sources: string[];
}

export interface HandoffText {
  text: string;
  source: string;
  truncated: boolean;
}

export function discoverScaffold(cwd: string): ScaffoldDiscovery {
  const sources: string[] = [];
  if (existsSync(join(cwd, ".osc"))) sources.push(".osc/");
  if (existsSync(join(cwd, "MISSION.md"))) sources.push("MISSION.md");
  return { present: sources.length > 0, sources };
}

export async function readHandoffText(cwd: string, { maxChars = 600 }: { maxChars?: number } = {}): Promise<HandoffText | null> {
  for (const candidate of HANDOFF_CANDIDATES) {
    const path = join(cwd, candidate.rel);
    if (!existsSync(path)) continue;
    let lstat;
    try {
      lstat = lstatSync(path);
    } catch {
      // Unreadable candidate (bad permissions, broken symlink, …) — skip and
      // try the next candidate so one malformed preferred record does not
      // disable handoff injection entirely.
      continue;
    }
    // Reject symlinks outright. A repo-local symlink could point at an
    // absolute path (e.g. $HOME/.ssh/config) or ..-escape the working tree,
    // leaking arbitrary files into the injected system prompt. Only accept
    // real, repo-native files for handoff context.
    if (lstat.isSymbolicLink()) continue;
    // Skip non-regular files (FIFOs, device nodes, sockets, directories): a
    // FIFO would block open() indefinitely, and directories behave
    // unpredictably under read(). Only proceed for real, readable files.
    if (!lstat.isFile()) continue;
    // Bound the read: read at most MAX_HANDOFF_READ_BYTES so an accidentally
    // huge handoff/mission record cannot exhaust memory or stall startup.
    const oversized = lstat.size > MAX_HANDOFF_READ_BYTES;
    const readBytes = oversized ? MAX_HANDOFF_READ_BYTES : lstat.size;
    let raw: string;
    try {
      const fh = await open(path, "r");
      try {
        // Decode only the bytes actually read so a short read or a file that
        // shrank between stat and read cannot leak uninitialized Buffer memory
        // into the injected system prompt.
        const { bytesRead, buffer } = await fh.read(
          Buffer.allocUnsafe(readBytes), 0, readBytes, 0,
        );
        raw = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await fh.close();
      }
    } catch {
      continue;
    }
    const text = raw.trim();
    if (!text) continue;
    return {
      text: truncate(text, maxChars),
      source: candidate.source,
      truncated: oversized || text.length > maxChars,
    };
  }
  return null;
}

export function formatHandoffInject({ text, source, truncated }: HandoffText): string {
  const suffix = truncated ? "\n\n[Open Scaffold handoff truncated before injection.]" : "";
  return [
    "OPEN SCAFFOLD HANDOFF CONTEXT",
    `Source: ${source}`,
    "This is optional repo-native handoff context, not verified truth. Verify claims before relying on them.",
    "",
    text + suffix,
  ].join("\n");
}
