// `lazyglm update` — self-update: compare the installed version against the
// npm registry and optionally install the latest published release.
// All network/exec lives behind injectable seams so tests never touch npm.
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { readJson } from "./util.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Strip surrounding quotes and whitespace. npm honours NPM_CONFIG_JSON / --json
// globally; when set, `npm view <pkg> version` returns a JSON-quoted string such
// as "1.2.3" instead of the bare 1.2.3. Feeding that to compareSemver makes the
// quoted major parse as NaN and inverts/equalises the result, silently hiding
// available updates. (PR #25 Codex review P2, thread src/update.js:34.)
export function normalizeVersion(v) {
  return String(v ?? "").trim().replace(/^["']|["']$/g, "");
}

// Pure: compare two x.y.z versions. Returns -1 if a < b, 0 if equal, 1 if a > b.
// Only the first three numeric components are considered (no prerelease/ranges).
export function compareSemver(a, b) {
  const pa = String(a ?? "0.0.0").split(".");
  const pb = String(b ?? "0.0.0").split(".");
  for (let i = 0; i < 3; i++) {
    const na = Number(pa[i] ?? 0);
    const nb = Number(pb[i] ?? 0);
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

export async function readLocalVersion() {
  const pkg = await readJson(join(ROOT, "package.json"), {});
  return pkg.version || "0.0.0";
}

// Real remote fetch via the npm registry. Overridable in tests via seams.
// `--no-json` neutralises a global NPM_CONFIG_JSON/--json setting, which would
// otherwise wrap the version in double quotes and break compareSemver.
export function fetchRemoteVersion() {
  return execSync("npm view lazyglm version --no-json", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
}

export function describeUpdate(result) {
  if (result.status === "behind") return `lazyglm ${result.local} is behind ${result.remote} — update available.`;
  if (result.status === "ahead") return `lazyglm ${result.local} is ahead of ${result.remote} — running newer than the registry.`;
  if (result.status === "equal") return `lazyglm ${result.local} is up to date.`;
  return `Could not check for updates: ${result.detail || "unknown error"}`;
}

// Compare local vs remote. Never touches npm when fetchRemote is injected.
// exitCode: 0 when local >= remote, 1 when behind (update available),
// 2 on fetch/registry error.
export async function checkUpdate({ fetchRemote = fetchRemoteVersion, readLocal = readLocalVersion } = {}) {
  const local = await readLocal();
  let remote;
  try {
    remote = await fetchRemote();
  } catch (e) {
    const detail = (e && e.message) ? e.message : String(e);
    return { status: "error", detail, local, remote: null, exitCode: 2 };
  }
  if (!remote) {
    return { status: "error", detail: "registry returned an empty version", local, remote: null, exitCode: 2 };
  }
  const localN = normalizeVersion(local);
  const remoteN = normalizeVersion(remote);
  const cmp = compareSemver(localN, remoteN);
  if (cmp === 0) return { status: "equal", local, remote, exitCode: 0 };
  if (cmp < 0) return { status: "behind", local, remote, exitCode: 1 };
  return { status: "ahead", local, remote, exitCode: 0 };
}

function defaultInstaller() {
  execSync("npm install -g lazyglm@latest", { stdio: ["ignore", "pipe", "pipe"] });
}

async function defaultPrompt(message) {
  const rl = readline.createInterface({ input: defaultInput, output: defaultOutput });
  try {
    return (await rl.question(message)).trim();
  } finally {
    rl.close();
  }
}

// Orchestrates compare + optional install. Prints the status report itself.
// {force:true} skips the confirmation prompt and installs when behind.
export async function selfUpdate({
  force = false,
  fetchRemote = fetchRemoteVersion,
  readLocal = readLocalVersion,
  installer = defaultInstaller,
  prompt = defaultPrompt,
  isInteractive = () => defaultInput.isTTY === true && defaultOutput.isTTY === true,
  stdout = process.stdout,
} = {}) {
  const result = await checkUpdate({ fetchRemote, readLocal });
  stdout.write(describeUpdate(result) + "\n");

  // registry error, or already up-to-date / ahead: nothing to install
  if (result.exitCode === 2) return result;
  if (result.status !== "behind") return result;

  if (!force) {
    // Non-interactive contexts (piped/closed stdin, CI, --no-TTY) cannot answer
    // a confirmation prompt. Calling question() would hang or exit early.
    // Skip the install and point the user to --force instead of waiting.
    if (!isInteractive()) {
      stdout.write(`Update available — rerun with --force to install lazyglm@${result.remote}.\n`);
      return { ...result, updated: false };
    }
    let confirmed = "";
    try {
      confirmed = await prompt(`Install lazyglm@${result.remote} now? [y/N] `);
    } catch {
      confirmed = "";
    }
    if (!/^[yt]/i.test(confirmed)) {
      stdout.write("Skipped update.\n");
      return { ...result, updated: false };
    }
  }

  try {
    installer();
    stdout.write(`Updated lazyglm to ${result.remote}.\n`);
    return { ...result, updated: true, exitCode: 0 };
  } catch (e) {
    const detail = (e && e.message) ? e.message : String(e);
    stdout.write(`Update failed: ${detail}\n`);
    return { ...result, updated: false, detail, exitCode: 2 };
  }
}
