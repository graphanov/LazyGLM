// Session persistence for the REPL. Each session is a JSONL file at
// ~/.lazyglm/sessions/<id>.jsonl. The first record is a header (session meta);
// subsequent records are turn events (user / assistant / tool / usage / compact).
// `lazyglm --continue` resumes the most recent session; `/resume` lists and
// picks a past one.
import { appendFile, readFile, readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nowIso } from "./util.js";

function home() {
  return process.env.LAZYGLM_HOME || join(process.env.HOME || "/tmp", ".lazyglm");
}
export function sessionsDir() {
  return join(home(), "sessions");
}

export function newSessionId() {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Create a new session file with a header record. Returns { id, path, model, provider }.
 */
export async function createSession({ id, model, provider, firstPrompt } = {}) {
  const sid = id || newSessionId();
  const dir = sessionsDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sid}.jsonl`);
  const header = { t: nowIso(), type: "session", id: sid, model: model || null, provider: provider || null, firstPrompt: firstPrompt || null };
  await appendFile(path, JSON.stringify(header) + "\n", "utf8");
  return { id: sid, path, model, provider };
}

/**
 * Append a turn event to a session file (best-effort; never throws).
 */
export async function appendEvent(session, event) {
  if (!session?.path) return;
  try {
    await appendFile(session.path, JSON.stringify({ t: nowIso(), ...event }) + "\n", "utf8");
  } catch {
    // session persistence is best-effort — never break the turn
  }
}

/**
 * List past sessions, most-recent first. Each entry: { id, path, mtime, model, provider, firstPrompt, startedAt }.
 */
export async function listSessions() {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  let files = [];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.filter((f) => f.endsWith(".jsonl"))) {
    const path = join(dir, f);
    let st;
    try {
      st = await stat(path);
    } catch {
      continue;
    }
    const id = f.replace(/\.jsonl$/, "");
    out.push({ id, path, mtime: st.mtimeMs, ...(await readSessionMeta(path)) });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

async function readSessionMeta(path) {
  try {
    const raw = await readFile(path, "utf8");
    const first = raw.split("\n").find((l) => l.trim());
    const hdr = first ? JSON.parse(first) : {};
    return { model: hdr.model, provider: hdr.provider, firstPrompt: hdr.firstPrompt, startedAt: hdr.t };
  } catch {
    return {};
  }
}

export async function lastSession() {
  const list = await listSessions();
  return list[0] || null;
}

/**
 * Load all event records for a session id. Returns null if not found.
 */
export async function loadSessionEvents(id) {
  const path = join(sessionsDir(), `${id}.jsonl`);
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
