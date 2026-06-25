import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMcpServers, mcpServersSummary } from "../src/mcp/config.js";

// ---------------------------------------------------------------------------
// parseMcpServers — success cases
// ---------------------------------------------------------------------------

test("missing mcpServers parses as zero servers", () => {
  const r = parseMcpServers({});
  assert.equal(r.count, 0);
  assert.deepEqual(r.servers, []);
  assert.deepEqual(r.errors, []);
});

test("undefined config parses as zero servers", () => {
  const r = parseMcpServers(undefined);
  assert.equal(r.count, 0);
  assert.deepEqual(r.servers, []);
});

test("null config parses as zero servers", () => {
  const r = parseMcpServers(null);
  assert.equal(r.count, 0);
});

test("valid stdio declaration parses without execution", () => {
  const r = parseMcpServers({
    mcpServers: {
      fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], env: { ROOT: "/tmp" } },
    },
  });
  assert.equal(r.count, 1);
  assert.equal(r.errors.length, 0);
  const s = r.servers[0];
  assert.equal(s.name, "fs");
  assert.equal(s.kind, "stdio");
  assert.equal(s.entry.command, "npx");
  assert.deepEqual(s.entry.args, ["-y", "@modelcontextprotocol/server-filesystem"]);
  assert.deepEqual(s.entry.env, { ROOT: "/tmp" });
});

test("valid remote declaration parses without network calls", () => {
  const r = parseMcpServers({
    mcpServers: {
      api: { url: "https://example.com/mcp", headers: { Authorization: "Bearer token" }, transport: "sse" },
    },
  });
  assert.equal(r.count, 1);
  assert.equal(r.errors.length, 0);
  const s = r.servers[0];
  assert.equal(s.name, "api");
  assert.equal(s.kind, "remote");
  assert.equal(s.entry.url, "https://example.com/mcp");
  assert.equal(s.entry.transport, "sse");
});

test("multiple servers of mixed kinds parse together", () => {
  const r = parseMcpServers({
    mcpServers: {
      local: { command: "node", args: ["server.js"] },
      remote: { url: "https://srv.example.com/mcp" },
    },
  });
  assert.equal(r.count, 2);
  assert.equal(r.errors.length, 0);
  const kinds = r.servers.map((s) => s.kind).sort();
  assert.deepEqual(kinds, ["remote", "stdio"]);
});

test("minimal stdio declaration (command only) parses", () => {
  const r = parseMcpServers({ mcpServers: { bare: { command: "echo" } } });
  assert.equal(r.count, 1);
  assert.equal(r.servers[0].kind, "stdio");
});

test("minimal remote declaration (url only) parses", () => {
  const r = parseMcpServers({ mcpServers: { bare: { url: "https://x.example.com/mcp" } } });
  assert.equal(r.count, 1);
  assert.equal(r.servers[0].kind, "remote");
});

test("unknown fields are preserved for forward compatibility", () => {
  const r = parseMcpServers({
    mcpServers: { future: { command: "x", sampleFeature: true, nested: { a: 1 } } },
  });
  assert.equal(r.count, 1);
  assert.equal(r.servers[0].entry.sampleFeature, true);
  assert.deepEqual(r.servers[0].entry.nested, { a: 1 });
});

// ---------------------------------------------------------------------------
// parseMcpServers — failure cases (must be deterministic + redacted)
// ---------------------------------------------------------------------------

test("entry that is not an object fails with redacted reason", () => {
  const r = parseMcpServers({ mcpServers: { bad: "not-an-object" } });
  assert.equal(r.count, 0);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].name, "bad");
  assert.match(r.errors[0].error, /must be an object/);
});

test("entry that is an array fails with redacted reason", () => {
  const r = parseMcpServers({ mcpServers: { bad: ["command"] } });
  assert.equal(r.count, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /must be an object/);
});

test("entry that is a class instance fails as non-plain object", () => {
  class ServerDecl {}
  const r = parseMcpServers({ mcpServers: { bad: new ServerDecl() } });
  assert.equal(r.count, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /must be an object/);
});

test("entry with both command and url fails", () => {
  const r = parseMcpServers({
    mcpServers: { both: { command: "x", url: "https://e.com" } },
  });
  assert.equal(r.count, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /both 'command' and 'url'/);
});

test("entry with neither command nor url fails", () => {
  const r = parseMcpServers({ mcpServers: { neither: { args: ["x"] } } });
  assert.equal(r.count, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /exactly one of 'command' .* 'url'/);
});

test("empty-string command fails", () => {
  const r = parseMcpServers({ mcpServers: { e: { command: "  " } } });
  assert.equal(r.count, 0);
  assert.match(r.errors[0].error, /'command' must be a non-empty string/);
});

test("empty-string url fails", () => {
  const r = parseMcpServers({ mcpServers: { e: { url: "" } } });
  assert.equal(r.count, 0);
  assert.match(r.errors[0].error, /'url' must be a non-empty string/);
});

test("relative or scheme-less remote url fails", () => {
  const r = parseMcpServers({ mcpServers: { api: { url: "localhost:3000/mcp" } } });
  assert.equal(r.count, 0);
  assert.match(r.errors[0].error, /'url' must use http or https|'url' must be an absolute HTTP\(S\) URL/);
});

test("unsupported remote url scheme fails", () => {
  const r = parseMcpServers({ mcpServers: { api: { url: "file:///tmp/mcp.sock" } } });
  assert.equal(r.count, 0);
  assert.match(r.errors[0].error, /'url' must use http or https/);
});

test("remote url is trimmed after validation", () => {
  const r = parseMcpServers({ mcpServers: { api: { url: "  https://example.com/mcp  " } } });
  assert.equal(r.count, 1);
  assert.equal(r.errors.length, 0);
  assert.equal(r.servers[0].entry.url, "https://example.com/mcp");
});

test("non-array args fails", () => {
  const r = parseMcpServers({ mcpServers: { e: { command: "x", args: "not-array" } } });
  assert.equal(r.count, 0);
  assert.match(r.errors[0].error, /'args' must be an array/);
});

test("non-object env fails", () => {
  const r = parseMcpServers({ mcpServers: { e: { command: "x", env: ["a"] } } });
  assert.equal(r.count, 0);
  assert.match(r.errors[0].error, /'env' must be an object/);
});

test("non-object headers fails", () => {
  const r = parseMcpServers({ mcpServers: { e: { url: "https://e.com", headers: "x" } } });
  assert.equal(r.count, 0);
  assert.match(r.errors[0].error, /'headers' must be an object/);
});

test("non-object mcpServers map fails with a redacted error", () => {
  const r = parseMcpServers({ mcpServers: "nope" });
  assert.equal(r.count, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /'mcpServers' must be an object/);
});

test("valid and invalid entries are split correctly", () => {
  const r = parseMcpServers({
    mcpServers: {
      good: { command: "x" },
      bad: { args: ["no-command-or-url"] },
      alsoGood: { url: "https://e.com" },
    },
  });
  assert.equal(r.count, 2);
  assert.equal(r.errors.length, 1);
  assert.deepEqual(
    r.servers.map((s) => s.name).sort(),
    ["alsoGood", "good"],
  );
  assert.equal(r.errors[0].name, "bad");
});

// ---------------------------------------------------------------------------
// Secret safety — env/header values must NEVER appear in diagnostics
// ---------------------------------------------------------------------------

test("env and header values never appear in error reasons", () => {
  const SECRET = "super-secret-token-value-xyz";
  const r = parseMcpServers({
    mcpServers: {
      // valid structurally, but we check the summary does not leak values
      ok: { command: "x", env: { TOKEN: SECRET } },
      // invalid (both command+url) but carries a secret header
      bad: { command: "x", url: "https://e.com", headers: { Authorization: SECRET } },
    },
  });
  const summary = mcpServersSummary(r);
  assert.ok(!summary.includes(SECRET), "summary must not leak env/header values");
});

test("summary for zero servers", () => {
  const r = parseMcpServers({});
  assert.equal(mcpServersSummary(r), "0 MCP servers declared");
});

test("summary counts servers by kind and lists names", () => {
  const r = parseMcpServers({
    mcpServers: {
      a: { command: "x" },
      b: { url: "https://e.com" },
      c: { command: "y" },
    },
  });
  const summary = mcpServersSummary(r);
  assert.match(summary, /3 MCP server\(s\)/);
  assert.match(summary, /2 stdio/);
  assert.match(summary, /1 remote/);
  assert.ok(summary.includes("a") && summary.includes("b") && summary.includes("c"));
});

test("summary includes redacted invalid-declaration reasons", () => {
  const r = parseMcpServers({
    mcpServers: { bad: { args: [] } },
  });
  const summary = mcpServersSummary(r);
  assert.match(summary, /1 invalid declaration\(s\)/);
  assert.match(summary, /bad \(.*exactly one of 'command'.*\)/);
});

test("summary reports both valid and invalid when both present", () => {
  const r = parseMcpServers({
    mcpServers: {
      good: { command: "x" },
      bad: "not-an-object",
    },
  });
  const summary = mcpServersSummary(r);
  assert.match(summary, /1 MCP server\(s\) declared/);
  assert.match(summary, /1 invalid declaration\(s\)/);
  assert.ok(!summary.includes("not-an-object"), "raw value must not leak");
});

// ---------------------------------------------------------------------------
// Purity / side-effect contract
// ---------------------------------------------------------------------------

test("parser does not mutate the input config", () => {
  const config = { mcpServers: { a: { command: "x", args: ["1"] } } };
  const snapshot = JSON.parse(JSON.stringify(config));
  parseMcpServers(config);
  assert.deepEqual(config, snapshot, "input config must be unchanged");
});

test("parser is synchronous and returns a plain object", () => {
  const r = parseMcpServers({ mcpServers: { a: { command: "x" } } });
  assert.equal(typeof r, "object");
  assert.ok(r !== null);
});
