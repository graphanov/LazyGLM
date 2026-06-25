// MCP (Model Context Protocol) server declaration parsing.
//
// This module is a PURE, SIDE-EFFECT-FREE parser/normalizer for the
// `mcpServers` map stored in the user config (~/.lazyglm/config.json).
// It classifies + validates server declarations but NEVER:
//   - spawns a subprocess (stdio `command` is stored, not executed);
//   - opens a network connection (remote `url` is stored, not fetched);
//   - prints env/header values (they may hold secrets -> redacted in diagnostics).
//
// This is the enabling input surface for a future MCP client implementation.
// The widely-used `mcpServers` map convention (Claude Desktop / Cursor) is:
//
//   "mcpServers": {
//     "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"], "env": { "FOO": "bar" } },
//     "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." }, "transport": "sse" }
//   }
//
// Validation rules:
//   - server name must be a non-empty string;
//   - entry must be a plain object;
//   - exactly one of `command` (stdio) or `url` (remote) must be present;
//   - `args` must be an array when present;
//   - `env` / `headers` must be plain objects when present;
//   - `transport` is preserved but NOT enum-validated (left for a future phase).
// Unknown fields are preserved for forward compatibility.

/**
 * True for a "plain" object (not an array, not null, not a class instance).
 */
function isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Classify a single validated server entry as "stdio" or "remote".
 * Assumes the entry has already passed validation.
 */
function classifyEntry(entry) {
  return entry.url ? "remote" : "stdio";
}

/**
 * Normalize a single server entry. Returns { ok, entry, kind, error }.
 * `entry` is the normalized declaration; `error` is a redacted reason string.
 */
function normalizeEntry(name, raw) {
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, error: "server name must be a non-empty string" };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, name, error: "declaration must be an object" };
  }

  const hasCommand = Object.prototype.hasOwnProperty.call(raw, "command") && raw.command != null;
  const hasUrl = Object.prototype.hasOwnProperty.call(raw, "url") && raw.url != null;

  if (hasCommand && hasUrl) {
    return { ok: false, name, error: "declaration has both 'command' and 'url' — specify exactly one" };
  }
  if (!hasCommand && !hasUrl) {
    return { ok: false, name, error: "declaration must have exactly one of 'command' (stdio) or 'url' (remote)" };
  }

  // Build the normalized entry, preserving unknown fields.
  const entry = { ...raw };

  if (hasCommand) {
    if (typeof raw.command !== "string" || raw.command.trim() === "") {
      return { ok: false, name, error: "'command' must be a non-empty string" };
    }
    entry.command = raw.command;
  }
  if (hasUrl) {
    if (typeof raw.url !== "string" || raw.url.trim() === "") {
      return { ok: false, name, error: "'url' must be a non-empty string" };
    }
    entry.url = raw.url;
  }

  if (Object.prototype.hasOwnProperty.call(raw, "args")) {
    if (!Array.isArray(raw.args)) {
      return { ok: false, name, error: "'args' must be an array" };
    }
    entry.args = raw.args;
  }
  if (Object.prototype.hasOwnProperty.call(raw, "env")) {
    if (!isPlainObject(raw.env)) {
      return { ok: false, name, error: "'env' must be an object" };
    }
    entry.env = raw.env;
  }
  if (Object.prototype.hasOwnProperty.call(raw, "headers")) {
    if (!isPlainObject(raw.headers)) {
      return { ok: false, name, error: "'headers' must be an object" };
    }
    entry.headers = raw.headers;
  }

  return { ok: true, name, kind: classifyEntry(entry), entry };
}

/**
 * Parse the `mcpServers` map from an already-loaded config object.
 *
 * Returns:
 *   {
 *     servers: [{ name, kind, entry }, ...],  // valid, normalized declarations
 *     errors:  [{ name, error }, ...],        // invalid declarations (redacted)
 *     count:   number                         // servers.length
 *   }
 *
 * Missing `mcpServers` parses as zero servers. A non-object `mcpServers`
 * produces a single redacted error. env/header VALUES are never copied into
 * error messages — only structural reasons are reported.
 */
export function parseMcpServers(config) {
  const result = { servers: [], errors: [], count: 0 };

  if (!config || !Object.prototype.hasOwnProperty.call(config, "mcpServers")) {
    return result;
  }
  const raw = config.mcpServers;
  if (!isPlainObject(raw)) {
    result.errors.push({ name: "(mcpServers)", error: "'mcpServers' must be an object map of server declarations" });
    return result;
  }

  for (const [name, value] of Object.entries(raw)) {
    const r = normalizeEntry(name, value);
    if (r.ok) {
      result.servers.push({ name: r.name, kind: r.kind, entry: r.entry });
    } else {
      result.errors.push({ name: r.name || name, error: r.error });
    }
  }

  result.count = result.servers.length;
  return result;
}

/**
 * A short, secret-safe summary string for doctor/diagnostics.
 * Reports counts and (for errors) redacted, name-scoped reasons.
 * NEVER includes env, header, command-arg, or url values.
 */
export function mcpServersSummary(parsed) {
  const { servers, errors } = parsed;
  if (!servers.length && !errors.length) {
    return "0 MCP servers declared";
  }
  const parts = [];
  if (servers.length) {
    const byKind = { stdio: 0, remote: 0 };
    for (const s of servers) byKind[s.kind] = (byKind[s.kind] || 0) + 1;
    const bits = [];
    if (byKind.stdio) bits.push(`${byKind.stdio} stdio`);
    if (byKind.remote) bits.push(`${byKind.remote} remote`);
    parts.push(`${servers.length} MCP server(s) declared (${bits.join(", ")}): ${servers.map((s) => s.name).join(", ")}`);
  }
  if (errors.length) {
    parts.push(`${errors.length} invalid declaration(s): ${errors.map((e) => `${e.name} (${e.error})`).join("; ")}`);
  }
  return parts.join(" | ");
}
