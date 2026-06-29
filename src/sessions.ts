// Session persistence for the REPL. Each session is a JSONL file at
// ~/.lazyglm/sessions/<id>.jsonl. The first record is a header (session meta);
// subsequent records are turn events (user / assistant / tool / usage / compact).
// `lazyglm --continue` resumes the most recent session; `/resume` lists and
// picks a past one.
import { appendFile, readFile, readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nowIso } from "./util.js";
import type { Provider, SessionRecord } from "./types/index.js";

function home() {
  return process.env.LAZYGLM_HOME || join(process.env.HOME || "/tmp", ".lazyglm");
}
export function sessionsDir(): string {
  return join(home(), "sessions");
}

export function newSessionId(): string {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Create a new session file with a header record. Returns { id, path, model, provider }.
 */
export interface SessionInfo {
  id: string;
  path: string;
  model?: string | null;
  provider?: Provider | null;
}

interface CreateSessionOptions {
  id?: string;
  model?: string | null;
  provider?: Provider | null;
  firstPrompt?: string | null;
}

export interface ListedSession extends SessionInfo {
  mtime: number;
  firstPrompt?: string | null;
  startedAt?: string | null;
}

function asSessionRecord(value: unknown): SessionRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as SessionRecord : { t: nowIso(), type: "unknown" };
}

export async function createSession({ id, model, provider, firstPrompt }: CreateSessionOptions = {}): Promise<SessionInfo> {
  const sid = id || newSessionId();
  const dir = sessionsDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sid}.jsonl`);
  const header: SessionRecord = { t: nowIso(), type: "session", id: sid, model: model || null, provider: provider || null, firstPrompt: firstPrompt || null };
  await appendFile(path, JSON.stringify(header) + "\n", "utf8");
  return { id: sid, path, model, provider };
}

/**
 * Append a turn event to a session file (best-effort; never throws).
 */
export async function appendEvent(session: Pick<SessionInfo, "path"> | null | undefined, event: Omit<SessionRecord, "t">): Promise<void> {
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
export async function listSessions(): Promise<ListedSession[]> {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out: ListedSession[] = [];
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

async function readSessionMeta(path: string): Promise<Pick<ListedSession, "model" | "provider" | "firstPrompt" | "startedAt">> {
  try {
    const raw = await readFile(path, "utf8");
    const first = raw.split("\n").find((l) => l.trim());
    const hdr = asSessionRecord(first ? JSON.parse(first) : {});
    return { model: hdr.model, provider: hdr.provider, firstPrompt: hdr.firstPrompt, startedAt: hdr.t };
  } catch {
    return {};
  }
}

export async function lastSession(): Promise<ListedSession | null> {
  const list = await listSessions();
  return list[0] || null;
}

/**
 * Load all event records for a session id. Returns null if not found.
 */
export async function loadSessionEvents(id: string): Promise<SessionRecord[] | null> {
  const path = join(sessionsDir(), `${id}.jsonl`);
  if (!existsSync(path)) return null;
  let raw: string;
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
        return asSessionRecord(JSON.parse(l));
      } catch {
        return null;
      }
    })
    .filter((record): record is SessionRecord => Boolean(record));
}
