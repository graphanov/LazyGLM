// Shared helpers for lazyglm. Pure Node, no deps.
import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { execSync } from "node:child_process";

export const LAZYGLM_DIR = ".lazyglm";
export const LAZYGLM_HOME = process.env.LAZYGLM_HOME || join(process.env.HOME || "/tmp", ".lazyglm");

export function nowIso() {
  return new Date().toISOString();
}

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "task";
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function readJson(path, fallback = undefined) {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function writeJson(path, value) {
  await ensureDir(join(path, ".."));
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function readText(path) {
  return readFile(path, "utf8");
}

export async function writeText(path, content) {
  await ensureDir(join(path, ".."));
  await writeFile(path, content, "utf8");
}

export function truncate(text, max = 2000) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

// Resolve a path against a cwd, refusing escapes when sandboxed.
export function resolvePath(p, cwd, { allowEscape = false } = {}) {
  const abs = isAbsolute(p) ? p : resolve(cwd || process.cwd(), p);
  if (!allowEscape) {
    const base = resolve(cwd || process.cwd());
    const rel = relative(base, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path escapes project root: ${p}`);
    }
  }
  return abs;
}

export function gitInfo(cwd) {
  const out = { isRepo: false, branch: "", root: "" };
  try {
    const root = execSync("git rev-parse --show-toplevel", { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    out.isRepo = true;
    out.root = root;
    out.branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    // not a git repo
  }
  return out;
}

export async function listDirEntries(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((e) => !e.name.startsWith(".git") && e.name !== "node_modules")
    .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

export function fileStats(path) {
  try {
    const s = statSync(path);
    return { size: s.size, mtime: s.mtime.toISOString(), isDir: s.isDirectory() };
  } catch {
    return null;
  }
}

export async function readLines(path, offset = 1, limit = 500) {
  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n");
  const start = Math.max(0, (offset || 1) - 1);
  const end = Math.min(lines.length, start + (limit || 500));
  return lines.slice(start, end).map((line, i) => `${start + i + 1}|${line}`).join("\n");
}

// Cheap semantic version of "is this a meaningful project dir"
export function looksLikeProject(cwd) {
  return existsSync(join(cwd, "package.json")) || existsSync(join(cwd, ".git")) || existsSync(join(cwd, "AGENTS.md"));
}
