import { existsSync, statSync } from "node:fs";
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

export function discoverScaffold(cwd) {
  const sources = [];
  if (existsSync(join(cwd, ".osc"))) sources.push(".osc/");
  if (existsSync(join(cwd, "MISSION.md"))) sources.push("MISSION.md");
  return { present: sources.length > 0, sources };
}

export async function readHandoffText(cwd, { maxChars = 600 } = {}) {
  for (const candidate of HANDOFF_CANDIDATES) {
    const path = join(cwd, candidate.rel);
    if (!existsSync(path)) continue;
    let size;
    try {
      size = statSync(path).size;
    } catch {
      // Unreadable candidate (directory, bad permissions, broken symlink, …)
      // — skip and try the next candidate so one malformed preferred record
      // does not disable handoff injection entirely.
      continue;
    }
    // Bound the read: read at most MAX_HANDOFF_READ_BYTES so an accidentally
    // huge handoff/mission record cannot exhaust memory or stall startup.
    const oversized = size > MAX_HANDOFF_READ_BYTES;
    const readBytes = oversized ? MAX_HANDOFF_READ_BYTES : size;
    let raw;
    try {
      const fh = await open(path, "r");
      try {
        raw = (await fh.read(Buffer.allocUnsafe(readBytes), 0, readBytes, 0)).buffer.toString("utf8");
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

export function formatHandoffInject({ text, source, truncated }) {
  const suffix = truncated ? "\n\n[Open Scaffold handoff truncated before injection.]" : "";
  return [
    "OPEN SCAFFOLD HANDOFF CONTEXT",
    `Source: ${source}`,
    "This is optional repo-native handoff context, not verified truth. Verify claims before relying on them.",
    "",
    text + suffix,
  ].join("\n");
}
