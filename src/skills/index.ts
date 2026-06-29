// Skills system: loads skills/<name>/SKILL.md, lists them, and detects
// `$name` invocations in prompts (the same command syntax the original used).
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");

interface SkillRecord {
  name: string;
  path: string;
  frontmatter: Record<string, string>;
  body: string;
}

const _cache = new Map<string, SkillRecord>();
let _loaded = false;

export async function loadSkills(): Promise<Map<string, SkillRecord>> {
  if (_loaded) return _cache;
  _loaded = true;
  if (!existsSync(SKILLS_DIR)) return _cache;
  let entries: Dirent[] = [];
  try {
    entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return _cache;
  }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const md = join(SKILLS_DIR, d.name, "SKILL.md");
    if (!existsSync(md)) continue;
    let text = "";
    try {
      text = await readFile(md, "utf8");
    } catch {
      continue;
    }
    _cache.set(d.name, { name: d.name, path: md, frontmatter: parseFrontmatter(text), body: text });
  }
  return _cache;
}

export function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^(\w+):\s*"?(.*?)"?\s*$/);
    if (mm) fm[mm[1]] = mm[2];
  }
  return fm;
}

export function listSkillNames(): string[] {
  return [..._cache.keys()];
}

export function getSkill(name: string): SkillRecord | undefined {
  return _cache.get(name);
}

export function detectSkillInvocation(text: string): string | null {
  const m = (text || "").match(/\$([a-z][a-z0-9-]*)\b/);
  return m ? m[1] : null;
}
