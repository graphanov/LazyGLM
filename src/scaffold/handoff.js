import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { truncate } from "../util.js";

const HANDOFF_CANDIDATES = [
  { rel: ".osc/handoff.md", source: ".osc/handoff.md" },
  { rel: "MISSION.md", source: "MISSION.md" },
];

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
    let raw;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      // Unreadable candidate (directory, bad permissions, broken symlink, …)
      // — skip and try the next candidate so one malformed preferred record
      // does not disable handoff injection entirely.
      continue;
    }
    const text = raw.trim();
    if (!text) continue;
    return {
      text: truncate(text, maxChars),
      source: candidate.source,
      truncated: text.length > maxChars,
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
