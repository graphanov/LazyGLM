import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "../src/doctor.js";
import { resetConfigCache } from "../src/config.js";

// Doctor touches the network/provider. Isolate LAZYGLM_HOME and use the
// keyless ollama provider so no API secrets are needed. The ollama daemon
// is almost certainly NOT running in CI; doctor degrades reachable/ollama
// checks to `warn` (not `fail`) for ollama, so doctor() resolves cleanly.

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function withIsolatedHome(fn) {
  const savedHome = process.env.LAZYGLM_HOME;
  const savedProvider = process.env.LAZYGLM_PROVIDER;
  const savedModel = process.env.LAZYGLM_MODEL;
  const savedBase = process.env.LAZYGLM_BASE_URL;
  const savedKey = process.env.LAZYGLM_API_KEY;
  const savedTimeout = process.env.LAZYGLM_TIMEOUT;
  const savedRetries = process.env.LAZYGLM_MAX_RETRIES;
  const savedContextBudget = process.env.LAZYGLM_CONTEXT_BUDGET;
  const home = await mkdtemp(join(tmpdir(), "lazyglm-doctor-"));
  try {
    process.env.LAZYGLM_HOME = home;
    process.env.LAZYGLM_PROVIDER = "ollama";
    delete process.env.LAZYGLM_MODEL;
    delete process.env.LAZYGLM_BASE_URL;
    delete process.env.LAZYGLM_API_KEY;
    delete process.env.LAZYGLM_CONTEXT_BUDGET;
    process.env.LAZYGLM_TIMEOUT = "250";
    process.env.LAZYGLM_MAX_RETRIES = "0";
    resetConfigCache();
    return await fn(home);
  } finally {
    restoreEnv("LAZYGLM_HOME", savedHome);
    restoreEnv("LAZYGLM_PROVIDER", savedProvider);
    restoreEnv("LAZYGLM_MODEL", savedModel);
    restoreEnv("LAZYGLM_BASE_URL", savedBase);
    restoreEnv("LAZYGLM_API_KEY", savedKey);
    restoreEnv("LAZYGLM_TIMEOUT", savedTimeout);
    restoreEnv("LAZYGLM_MAX_RETRIES", savedRetries);
    restoreEnv("LAZYGLM_CONTEXT_BUDGET", savedContextBudget);
    resetConfigCache();
    await rm(home, { recursive: true, force: true });
  }
}

async function writeUserConfig(home, config) {
  // configPath() = join(LAZYGLM_HOME, "config.json") — directly under home.
  await writeFile(join(home, "config.json"), JSON.stringify(config, null, 2), "utf8");
}

function findCheck(result, name) {
  return result.checks.find((c) => c.name === name);
}

test("doctor returns an mcp check when no MCP servers are declared", async () => {
  await withIsolatedHome(async () => {
    const res = await doctor({ cwd: tmpdir() });
    const mcp = findCheck(res, "mcp");
    assert.ok(mcp, "doctor must include an 'mcp' check");
    assert.equal(mcp.status, "ok");
    assert.match(mcp.detail, /no MCP servers declared/);
  });
});

test("doctor reports catalog-derived context budget and documented window", async () => {
  await withIsolatedHome(async () => {
    const res = await doctor({ cwd: tmpdir() });
    const context = findCheck(res, "context");
    assert.ok(context, "doctor must include a 'context' check");
    assert.equal(context.status, "ok");
    assert.match(context.detail, /context budget: 800000 tokens/);
    assert.match(context.detail, /glm-5\.2's 1000000 token window/);
  });
});

test("doctor context budget follows the active LAZYGLM_MODEL override", async () => {
  await withIsolatedHome(async () => {
    process.env.LAZYGLM_MODEL = "glm-4.7";
    const res = await doctor({ cwd: tmpdir() });
    const context = findCheck(res, "context");
    assert.ok(context, "doctor must include a 'context' check");
    assert.equal(context.status, "ok");
    assert.match(context.detail, /context budget: 160000 tokens/);
    assert.match(context.detail, /glm-4\.7's 200000 token window/);
  });
});
test("doctor context check honors LAZYGLM_MODEL in the provider-error fallback path", async () => {
  // Simulate the common troubleshooting path: default zai provider with no API
  // key (resolveProviderConfig throws), but LAZYGLM_MODEL selects a different
  // model. The fallback cfg must report the env-selected model's context window,
  // not the catalog default.
  await withIsolatedHome(async () => {
    process.env.LAZYGLM_PROVIDER = "zai"; // requires a key we don't have -> throws
    process.env.LAZYGLM_API_KEY = ""; // force the error path
    process.env.LAZYGLM_MODEL = "glm-4.7";
    const res = await doctor({ cwd: tmpdir() });
    const context = findCheck(res, "context");
    assert.ok(context, "doctor must include a 'context' check");
    assert.equal(context.status, "ok");
    // glm-4.7 has a 200000 token window; 80% = 160000
    assert.match(context.detail, /context budget: 160000 tokens/);
    assert.match(context.detail, /glm-4\.7's 200000 token window/);
  });
});

test("doctor warns when user config JSON is malformed before declaring MCP healthy", async () => {
  await withIsolatedHome(async (home) => {
    await writeFile(join(home, "config.json"), "{ bad json", "utf8");
    const res = await doctor({ cwd: tmpdir() });
    const mcp = findCheck(res, "mcp");
    assert.equal(mcp.status, "warn");
    assert.match(mcp.detail, /could not read MCP server declarations/);
    assert.doesNotMatch(mcp.detail, /no MCP servers declared/);
  });
});

test("doctor reports a valid stdio MCP declaration as ok", async () => {
  await withIsolatedHome(async (home) => {
    await writeUserConfig(home, {
      provider: "ollama",
      mcpServers: {
        fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
      },
    });
    const res = await doctor({ cwd: tmpdir() });
    const mcp = findCheck(res, "mcp");
    assert.equal(mcp.status, "ok");
    assert.match(mcp.detail, /1 MCP server\(s\) declared/);
    assert.match(mcp.detail, /1 stdio/);
    assert.ok(mcp.detail.includes("fs"), "server name should appear in detail");
    assert.match(mcp.detail, /not connected/, "must clarify declarations are not connected");
  });
});

test("doctor reports a valid remote MCP declaration as ok", async () => {
  await withIsolatedHome(async (home) => {
    await writeUserConfig(home, {
      provider: "ollama",
      mcpServers: {
        api: { url: "https://example.com/mcp", transport: "sse" },
      },
    });
    const res = await doctor({ cwd: tmpdir() });
    const mcp = findCheck(res, "mcp");
    assert.equal(mcp.status, "ok");
    assert.match(mcp.detail, /1 remote/);
    assert.ok(mcp.detail.includes("api"));
  });
});

test("doctor warns on malformed remote MCP URLs", async () => {
  await withIsolatedHome(async (home) => {
    await writeUserConfig(home, {
      provider: "ollama",
      mcpServers: {
        api: { url: "localhost:3000/mcp", transport: "sse" },
      },
    });
    const res = await doctor({ cwd: tmpdir() });
    const mcp = findCheck(res, "mcp");
    assert.equal(mcp.status, "warn");
    assert.match(mcp.detail, /1 invalid declaration\(s\)/);
    assert.match(mcp.detail, /api/);
    assert.doesNotMatch(mcp.detail, /localhost:3000/);
  });
});

test("doctor warns on invalid MCP declarations with redacted reasons", async () => {
  await withIsolatedHome(async (home) => {
    await writeUserConfig(home, {
      provider: "ollama",
      mcpServers: {
        bad: { args: ["no-command-or-url"] },
      },
    });
    const res = await doctor({ cwd: tmpdir() });
    const mcp = findCheck(res, "mcp");
    assert.equal(mcp.status, "warn");
    assert.match(mcp.detail, /1 invalid declaration\(s\)/);
    assert.match(mcp.detail, /bad/);
  });
});

test("doctor reports both valid and invalid declarations", async () => {
  await withIsolatedHome(async (home) => {
    await writeUserConfig(home, {
      provider: "ollama",
      mcpServers: {
        good: { command: "x" },
        bad: "not-an-object",
      },
    });
    const res = await doctor({ cwd: tmpdir() });
    const mcp = findCheck(res, "mcp");
    // errors present => warn
    assert.equal(mcp.status, "warn");
    assert.match(mcp.detail, /1 MCP server\(s\) declared/);
    assert.match(mcp.detail, /1 invalid declaration\(s\)/);
    assert.ok(mcp.detail.includes("good"));
    assert.ok(mcp.detail.includes("bad"));
  });
});

test("doctor mcp detail never leaks env/header secret values", async () => {
  await withIsolatedHome(async (home) => {
    await writeUserConfig(home, {
      provider: "ollama",
      mcpServers: {
        s: { command: "x", env: { API_TOKEN: "LEAK-ME-DOCTOR-123" } },
        r: { url: "https://e.com", headers: { Authorization: "LEAK-ME-DOCTOR-456" } },
      },
    });
    const res = await doctor({ cwd: tmpdir() });
    const mcp = findCheck(res, "mcp");
    assert.ok(!mcp.detail.includes("LEAK-ME-DOCTOR-123"), "env value must not leak into doctor detail");
    assert.ok(!mcp.detail.includes("LEAK-ME-DOCTOR-456"), "header value must not leak into doctor detail");
  });
});
