// consequence-predictor — PreToolUse guard that makes the model forecast
// the consequence of risky actions before it mutates files or runs shell code.
// This is intentionally deterministic: the runtime can enforce the discipline
// without adding another model call before every tool use.

const GUARDED_TOOLS = new Set(["write_file", "patch_file", "run_shell"]);
const MIN_PREDICTION_CHARS = 40;

const GENERIC_PREDICTIONS = new Set([
  "ok",
  "safe",
  "no risk",
  "none",
  "n/a",
  "na",
  "low risk",
  "this is safe",
]);

// Reassurance / glue vocabulary that carries no consequence signal. A real
// prediction names a concrete affected surface, failure mode, or verification,
// so it leaves several distinct content tokens once these are stripped. A
// prediction that is only filler padded past MIN_PREDICTION_CHARS (or one word
// repeated) leaves too few and is treated as generic. Counting DISTINCT
// non-filler tokens also defeats length padding by repetition.
const GENERIC_FILLER_WORDS = new Set([
  "a", "an", "the", "this", "that", "these", "those", "it", "its",
  "i", "we", "you", "they", "he", "she",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "will", "would", "can", "could", "should", "shall", "may", "might", "must",
  "and", "or", "but", "to", "of", "in", "on", "at", "for", "with", "by",
  "as", "from", "into",
  "has", "have", "had", "do", "does", "did", "done",
  "here", "there", "now", "then", "so", "too", "very", "really", "quite",
  "just", "please",
  "everything", "nothing", "something", "anything", "all", "any", "some",
  "no", "not", "yes", "yeah",
  "ok", "okay", "fine", "good", "great", "nice", "sure", "alright",
  "safe", "safely", "safety", "risk", "risky", "risks", "problem", "worry",
  "looks", "look", "seems", "seem",
]);
const MIN_CONTENT_TOKENS = 3;

// Matches a curl/wget download piped into one or more stages, capturing the
// FULL remainder of the pipeline (every `|`-separated stage, up to a statement
// separator or newline). The scanner inspects ALL stages so a saver/filter
// placed before the shell — e.g. `curl url | tee file | bash` — cannot bypass
// the high-impact guard by making only the non-shell first stage visible.
const REMOTE_INSTALLER_PIPE = /\b(?:curl|wget)\b[^|\n]*\|\s*(?<pipeline>[^;&\n]+)/gi;
// Direct shell executables that read and execute piped installer stdin. Keep this
// explicit: a remote installer piped into `dash`/`fish` is still remote code
// execution even when it is not the most common `sh`/`bash` spelling.
const PIPELINE_SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "mksh",
  "fish",
  "csh",
  "tcsh",
]);
const NO_OPTIONS_WITH_VALUE = new Set();
const SUDO_OPTIONS_WITH_VALUE = new Set([
  "-C", "--close-from",
  "-D", "--chdir",
  "-g", "--group",
  "-h", "--host",
  "-p", "--prompt",
  "-R", "--chroot",
  "-r", "--role",
  "-T", "--command-timeout",
  "-t", "--type",
  "-U", "--other-user",
  "-u", "--user",
]);
// sudo -s/--shell and -i/--login launch a shell that runs the piped installer
// (verified: printf 'echo x\n' | sudo -s executes the stdin). When a remote
// installer is piped through sudo in one of these shell modes, the pipeline
// executes a shell even though no shell binary follows sudo.
const SUDO_SHELL_MODE_FLAGS = new Set(["--shell", "--login"]);
const ENV_OPTIONS_WITH_VALUE = new Set(["-C", "--chdir", "-S", "--split-string", "-u", "--unset"]);

const RM_INVOCATION = /\brm\b(?<args>[^;&|\n]*)/gi;
const RECURSIVE_METADATA_INVOCATION = /\b(?:chmod|chown)\b(?<args>[^;&|\n]*)/gi;
const GIT_INVOCATION = /\bgit\b(?<args>[^;&|\n]*)/gi;
const NPM_INVOCATION = /\bnpm\b(?<args>[^;&|\n]*)/gi;
const GH_INVOCATION = /\bgh\b(?<args>[^;&|\n]*)/gi;
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);
const GIT_GLOBAL_OPTION_FLAGS = new Set([
  "-p",
  "-P",
  "--bare",
  "--glob-pathspecs",
  "--icase-pathspecs",
  "--literal-pathspecs",
  "--no-optional-locks",
  "--no-pager",
  "--no-replace-objects",
  "--noglob-pathspecs",
  "--paginate",
]);
// gh reports two inherited flags (`gh release create --help`, INHERITED FLAGS):
// -R/--repo (takes a value) and --help (a flag). A command such as
// `gh -R owner/repo release create` must still be detected as high-impact, so
// the scanner walks past these before checking for the `release` subcommand.
const GH_GLOBAL_OPTIONS_WITH_VALUE = new Set(["-R", "--repo"]);
const GH_GLOBAL_OPTION_FLAGS = new Set(["--help", "-h"]);
// Only the mutating `gh release` subcommands are high-impact (they create or
// retract a release/artifact). Read-only inspections — `view`, `list`,
// `download` — must pass through so they are not blocked unless the prediction
// itself lacks mitigation. The mutating set is documented at the gh manual
// (https://cli.github.com/manual/gh_release).
const GH_RELEASE_MUTATING_SUBCOMMANDS = new Set([
  "create",
  // `gh release new` is the documented alias for `gh release create`
  // (ALIASES in `gh release create --help`), so it mutates a release too.
  "new",
  "upload",
  "delete",
  "delete-asset",
  "edit",
]);
const NPM_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "--cache",
  "--cert",
  "--cidr",
  "--diff",
  "--globalconfig",
  "--heading",
  "--https-proxy",
  "--include",
  "--key",
  "--local-address",
  "--loglevel",
  "--logs-dir",
  "--logs-max",
  "--node-options",
  "--omit",
  "--otp",
  "--pack-destination",
  "--prefix",
  "--proxy",
  "--registry",
  "--script-shell",
  "--tag",
  "--tag-version-prefix",
  "--user-agent",
  "--userconfig",
  "--workspace",
  "-w",
]);
const NPM_GLOBAL_OPTION_FLAGS = new Set([
  "--audit",
  "--dry-run",
  "--force",
  "--foreground-scripts",
  "--global",
  "--ignore-scripts",
  "--include-workspace-root",
  "--json",
  "--legacy-peer-deps",
  "--offline",
  "--package-lock-only",
  "--prefer-offline",
  "--prefer-online",
  "--silent",
  "--verbose",
  "--workspaces",
  "--yes",
  "-d",
  "-f",
  "-g",
  "-s",
  "-y",
]);

// npm accepts publish-specific options before the `publish` subcommand (verified
// via `npm --access public publish --dry-run` / `npm --provenance publish
// --dry-run`), so the scanner must keep walking past these to reach `publish`,
// otherwise a real registry publish with these flags bypasses the high-impact
// gate. These are publish-subcommand options, kept separate from the global
// npm option sets above for clarity.
const NPM_PUBLISH_OPTIONS_WITH_VALUE = new Set(["--access", "--provenance-file"]);
const NPM_PUBLISH_OPTION_FLAGS = new Set(["--provenance"]);

// Registry-mutating npm subcommands that must be classified high-impact. `pub`
// is an alias for `publish`; `unpublish` removes a published package/version.
const NPM_REGISTRY_MUTATION_SUBCOMMANDS = new Set(["publish", "pub", "unpublish"]);
// `npm exec` and the documented `npm x` alias can run a nested `npm publish` /
// `npm unpublish` command. Treat those nested registry mutations as high-impact
// without over-blocking local scripts such as `npm exec -- npm run publish`.
const NPM_EXEC_SUBCOMMANDS = new Set(["exec", "x"]);
const NPM_EXEC_CALL_OPTIONS_WITH_VALUE = new Set(["-c", "--call"]);
const NPM_EXEC_PACKAGE_OPTIONS_WITH_VALUE = new Set(["-p", "--package"]);

// npm subcommands. Used only to decide whether a non-option token that follows
// an unrecognized config option is that option's value or the real subcommand
// (see hasNpmRegistryMutationInvocation). Listed conservatively so a value-taking
// option not enumerated in NPM_GLOBAL_OPTIONS_WITH_VALUE cannot mask a later
// registry mutation. `npm run publish` breaks on `run` before any option is
// inspected, so it never reaches the value-consume branch.
const NPM_SUBCOMMANDS = new Set([
  "access", "add", "audit", "bin", "bugs", "cache", "ci", "config", "create",
  "dedupe", "deprecate", "diff", "dist-tag", "docs", "doctor", "edit", "exec",
  "explain", "explore", "find-dupes", "fund", "get", "help", "hook", "i",
  "init", "install", "install-clean", "link", "ln", "login", "logout", "ls",
  "org", "outdated", "owner", "pack", "ping", "pkg", "prefix", "profile",
  "prune", "pub", "publish", "query", "rebuild", "remove", "restart", "rm", "root",
  "run", "run-script", "search", "set", "shrinkwrap", "start", "stop", "t",
  "team", "test", "token", "uninstall", "unpublish", "unstar", "update",
  "upgrade", "version", "view", "whoami", "x",
]);

function hasRecursiveForceRm(command = "") {
  const commandText = String(command);
  for (const match of commandText.matchAll(RM_INVOCATION)) {
    const tokens = (match.groups?.args || "").trim().split(/\s+/).filter(Boolean);
    let recursive = false;
    let force = false;

    for (const token of tokens) {
      if (token === "--") break;
      if (!token.startsWith("-")) continue;

      if (token === "--recursive") recursive = true;
      if (token === "--force") force = true;
      if (token.startsWith("--")) continue;

      const shortFlags = token.slice(1);
      if (/[rR]/.test(shortFlags)) recursive = true;
      if (/f/.test(shortFlags)) force = true;
    }

    if (recursive && force) return true;
  }
  return false;
}

function hasRecursiveMetadataChange(command = "") {
  const commandText = String(command);
  for (const match of commandText.matchAll(RECURSIVE_METADATA_INVOCATION)) {
    const tokens = (match.groups?.args || "").trim().split(/\s+/).filter(Boolean);

    for (const token of tokens) {
      if (token === "--") break;
      if (!token.startsWith("-")) continue;
      if (token === "--recursive") return true;
      if (token.startsWith("--")) continue;
      if (/R/.test(token.slice(1))) return true;
    }
  }
  return false;
}

function gitGlobalOptionName(token) {
  const equalsAt = token.indexOf("=");
  return equalsAt === -1 ? token : token.slice(0, equalsAt);
}

function npmGlobalOptionName(token) {
  const equalsAt = token.indexOf("=");
  return equalsAt === -1 ? token : token.slice(0, equalsAt);
}

function shellWords(value = "") {
  const text = String(value);
  const words = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (const ch of text) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (escaped) current += "\\";
  if (current) words.push(current);
  return words;
}

function commandName(token) {
  return String(token).replace(/\\/g, "/").split("/").pop();
}

function optionName(token) {
  const equalsAt = token.indexOf("=");
  return equalsAt === -1 ? token : token.slice(0, equalsAt);
}

function isAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

// Short options that consume a value (e.g. sudo -u, git -C) as single chars,
// derived from the long-form set so both spellings agree.
function shortValueOptionChars(optionsWithValue) {
  const chars = new Set();
  for (const opt of optionsWithValue) {
    if (opt.length === 2 && opt[0] === "-") chars.add(opt[1]);
  }
  return chars;
}

// Walks a short-flag cluster (e.g. "-Hu", "-uroot") left-to-right the way
// getopt does. Flags before the first value-taking option are collected; that
// option consumes the rest of the cluster as its attached value, or — when it is
// the last flag — the following token (valueConsumesNext). Without this,
// "sudo -Hu root bash" stops at "root" and never reaches "bash".
function splitShortCluster(token, valueChars) {
  const body = token.slice(1);
  const flags = [];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (valueChars.has(ch)) {
      const attachedValue = body.slice(i + 1);
      return {
        flags,
        valueChar: ch,
        attachedValue,
        valueConsumesNext: attachedValue.length === 0,
      };
    }
    flags.push(ch);
  }
  return { flags, valueChar: null, attachedValue: "", valueConsumesNext: false };
}

function skipWrapperOptions(tokens, start, optionsWithValue) {
  const valueChars = shortValueOptionChars(optionsWithValue);
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "--") return i + 1;
    if (isAssignment(token)) {
      i += 1;
      continue;
    }
    if (!token.startsWith("-")) return i;

    if (token.startsWith("--")) {
      const option = optionName(token);
      i += 1;
      if (optionsWithValue.has(option) && !token.includes("=")) i += 1;
      continue;
    }

    const { valueConsumesNext } = splitShortCluster(token, valueChars);
    i += 1;
    if (valueConsumesNext) i += 1;
  }
  return i;
}

// Walks sudo's option tokens (starting after the `sudo` token) and reports
// whether sudo is launching a shell that would execute the piped installer.
// Returns true on -s/--shell or -i/--login; stops (returns false) once a
// non-option token is reached, because that token is the actual command and
// the main loop checks it against PIPELINE_SHELLS. Value-consuming options
// (-u user, -C n, etc.) are skipped so their argument is not mistaken for a
// shell-mode flag.
function sudoLaunchesShell(tokens, start) {
  const valueChars = shortValueOptionChars(SUDO_OPTIONS_WITH_VALUE);
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") return false;
    if (isAssignment(token)) continue;
    if (!token.startsWith("-")) return false;

    if (token.startsWith("--")) {
      const option = optionName(token);
      if (SUDO_SHELL_MODE_FLAGS.has(option)) return true;
      if (SUDO_OPTIONS_WITH_VALUE.has(option) && !token.includes("=")) i += 1;
      continue;
    }

    // Short-flag cluster in getopt order: a -s/-i flag before any value-taking
    // option starts a shell. A value-taking option as the last flag consumes the
    // next token, so "sudo -Hu root bash" skips root instead of returning false.
    const cluster = splitShortCluster(token, valueChars);
    if (cluster.flags.includes("s") || cluster.flags.includes("i")) return true;
    if (cluster.valueConsumesNext) i += 1;
  }
  return false;
}

function envSplitStringInvokesShell(value) {
  return pipelineTargetInvokesShell(shellWords(value));
}

// GNU env's -S/--split-string option processes its value into the command and
// arguments to execute. A remote installer such as `curl url | env -S 'bash -eux'`
// therefore invokes bash even though the shell binary is inside the option value
// rather than a later token. Inspect the split value instead of skipping it as a
// plain wrapper option argument.
function envTargetInvokesShell(tokens, start) {
  const valueChars = shortValueOptionChars(ENV_OPTIONS_WITH_VALUE);
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "--") return pipelineTargetInvokesShell(tokens.slice(i + 1));
    if (isAssignment(token)) {
      i += 1;
      continue;
    }
    if (!token.startsWith("-")) return pipelineTargetInvokesShell(tokens.slice(i));

    if (token.startsWith("--")) {
      const option = optionName(token);
      if (option === "--split-string") {
        const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : tokens[i + 1];
        if (value !== undefined && envSplitStringInvokesShell(value)) return true;
        i += token.includes("=") ? 1 : 2;
        continue;
      }
      i += 1;
      if (ENV_OPTIONS_WITH_VALUE.has(option) && !token.includes("=")) i += 1;
      continue;
    }

    const cluster = splitShortCluster(token, valueChars);
    if (cluster.valueChar === "S") {
      const value = cluster.valueConsumesNext ? tokens[i + 1] : cluster.attachedValue;
      if (value !== undefined && envSplitStringInvokesShell(value)) return true;
    }
    i += 1;
    if (cluster.valueConsumesNext) i += 1;
  }
  return false;
}

function pipelineTargetInvokesShell(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const name = commandName(tokens[i]);
    if (PIPELINE_SHELLS.has(name)) return true;
    if (name === "sudo") {
      if (sudoLaunchesShell(tokens, i + 1)) return true;
      i = skipWrapperOptions(tokens, i + 1, SUDO_OPTIONS_WITH_VALUE);
      continue;
    }
    if (name === "env") {
      return envTargetInvokesShell(tokens, i + 1);
    }
    if (name === "command") {
      i = skipWrapperOptions(tokens, i + 1, NO_OPTIONS_WITH_VALUE);
      continue;
    }
    if (isAssignment(tokens[i])) {
      i += 1;
      continue;
    }
    return false;
  }
  return false;
}

function hasRemoteInstallerPipeline(command = "") {
  const commandText = String(command);
  for (const match of commandText.matchAll(REMOTE_INSTALLER_PIPE)) {
    // Inspect every pipe-delimited stage of the captured pipeline, not just the
    // first, so a saver/filter before the shell (e.g. `curl url | tee file |
    // bash`) cannot hide the shell stage and bypass the guard.
    for (const stage of (match.groups?.pipeline || "").split("|")) {
      if (pipelineTargetInvokesShell(shellWords(stage))) return true;
    }
  }
  return false;
}

function npmShellCommandHasRegistryMutation(command = "", depth = 0) {
  if (depth >= 3) return false;
  const commandText = String(command);
  for (const match of commandText.matchAll(NPM_INVOCATION)) {
    if (npmTokensHaveRegistryMutation(shellWords(match.groups?.args || ""), 0, depth)) return true;
  }
  return false;
}

function nestedNpmCommandHasRegistryMutation(tokens, start, depth) {
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (isAssignment(token)) continue;
    if (commandName(token) === "npm") return npmTokensHaveRegistryMutation(tokens, i + 1, depth + 1);
    return false;
  }
  return false;
}

function npmExecHasRegistryMutation(tokens, start, depth) {
  if (depth >= 3) return false;

  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") return nestedNpmCommandHasRegistryMutation(tokens, i + 1, depth);
    if (isAssignment(token)) continue;
    if (!token.startsWith("-")) return nestedNpmCommandHasRegistryMutation(tokens, i, depth);

    const option = npmGlobalOptionName(token);
    if (NPM_EXEC_CALL_OPTIONS_WITH_VALUE.has(option)) {
      const call = token.includes("=") ? token.slice(token.indexOf("=") + 1) : tokens[i + 1];
      if (call !== undefined && npmShellCommandHasRegistryMutation(call, depth + 1)) return true;
      if (!token.includes("=")) i += 1;
      continue;
    }
    if (NPM_GLOBAL_OPTIONS_WITH_VALUE.has(option) || NPM_EXEC_PACKAGE_OPTIONS_WITH_VALUE.has(option)) {
      if (!token.includes("=")) i += 1;
      continue;
    }
    if (token.startsWith("-c") && token.length > 2) {
      if (npmShellCommandHasRegistryMutation(token.slice(2), depth + 1)) return true;
      continue;
    }
    if (
      (token.startsWith("-w") || token.startsWith("-C") || token.startsWith("-p")) &&
      token.length > 2
    ) {
      continue;
    }
    if (NPM_GLOBAL_OPTION_FLAGS.has(option)) continue;

    const next = tokens[i + 1];
    if (
      next !== undefined &&
      next !== "--" &&
      !next.startsWith("-") &&
      commandName(next) !== "npm" &&
      !NPM_SUBCOMMANDS.has(next)
    ) {
      i += 1;
    }
  }
  return false;
}

function npmTokensHaveRegistryMutation(tokens, start = 0, depth = 0) {
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (NPM_REGISTRY_MUTATION_SUBCOMMANDS.has(token)) return true;
    if (NPM_EXEC_SUBCOMMANDS.has(token)) return npmExecHasRegistryMutation(tokens, i + 1, depth);
    if (token === "--" || !token.startsWith("-")) break;

    const option = npmGlobalOptionName(token);
    if (NPM_GLOBAL_OPTIONS_WITH_VALUE.has(option)) {
      if (!token.includes("=")) i += 1;
      continue;
    }
    if (NPM_PUBLISH_OPTIONS_WITH_VALUE.has(option)) {
      if (!token.includes("=")) i += 1;
      continue;
    }
    if ((token.startsWith("-w") || token.startsWith("-C")) && token.length > 2) continue;
    if (NPM_GLOBAL_OPTION_FLAGS.has(option) || NPM_PUBLISH_OPTION_FLAGS.has(option)) continue;
    // npm exposes many config flags (e.g. --omit, --include, --no-audit) that
    // can precede the subcommand; the value-taking ones live in the sets
    // above. Any other option here is still a config/global flag, so keep
    // scanning rather than stopping — a real `npm <opts> publish` must stay
    // gated, and an unrecognized flag must not let it slip past. A
    // value-taking option not enumerated above would otherwise leave its
    // space-separated value as the next token, where the non-dash break
    // masks a registry mutation (e.g. `npm --custom-prefix v publish`). Consume
    // one following non-option token as that value, but never consume a
    // registry mutation itself, never consume past `--`, and never consume a
    // real subcommand.
    const next = tokens[i + 1];
    if (
      next !== undefined &&
      next !== "--" &&
      !next.startsWith("-") &&
      !NPM_REGISTRY_MUTATION_SUBCOMMANDS.has(next) &&
      !NPM_SUBCOMMANDS.has(next)
    ) {
      i += 1;
    }
    continue;
  }
  return false;
}

function hasNpmRegistryMutationInvocation(command = "") {
  return npmShellCommandHasRegistryMutation(command, 0);
}

function hasGitPushInvocation(command = "") {
  const commandText = String(command);
  for (const match of commandText.matchAll(GIT_INVOCATION)) {
    const tokens = shellWords(match.groups?.args || "");

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "push") return true;
      if (token === "--" || !token.startsWith("-")) break;

      const option = gitGlobalOptionName(token);
      if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(option)) {
        if (!token.includes("=")) i += 1;
        continue;
      }
      if (token.startsWith("-C") || token.startsWith("-c")) continue;
      if (GIT_GLOBAL_OPTION_FLAGS.has(option)) continue;
      break;
    }
  }
  return false;
}

function ghReleaseSubcommandAfterOptions(tokens, start) {
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") return tokens[i + 1];
    if (!token.startsWith("-")) return token;

    const option = optionName(token);
    if (GH_GLOBAL_OPTIONS_WITH_VALUE.has(option)) {
      if (!token.includes("=")) i += 1;
      continue;
    }
    if (token.startsWith("-R") && token.length > 2) continue;
    if (GH_GLOBAL_OPTION_FLAGS.has(option)) continue;
    return undefined;
  }
  return undefined;
}

function hasGhReleaseInvocation(command = "") {
  const commandText = String(command);
  for (const match of commandText.matchAll(GH_INVOCATION)) {
    const tokens = shellWords(match.groups?.args || "");

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "release") {
        // Only the mutating subcommands (create/new/upload/delete/delete-asset/edit)
        // are high-impact; read-only `gh release view|list|download` must pass.
        // gh inherited flags such as -R/--repo can appear either before
        // `release` or between `release` and the subcommand, so skip those
        // parent options before classifying the subcommand.
        const subcommand = ghReleaseSubcommandAfterOptions(tokens, i + 1);
        if (GH_RELEASE_MUTATING_SUBCOMMANDS.has(subcommand)) return true;
        // Read-only release subcommand: do not return false here. A chained
        // command may pair a read-only release with a mutating one (e.g.
        // `gh release view v1 && gh release upload v1 app.zip`); break out of
        // this invocation's tokens so the outer matchAll scan reaches the next
        // `gh` invocation. (GH_INVOCATION stops at &/;/|, so each `gh` is its
        // own match.)
        break;
      }
      if (token === "--" || !token.startsWith("-")) break;

      const option = optionName(token);
      if (GH_GLOBAL_OPTIONS_WITH_VALUE.has(option)) {
        if (!token.includes("=")) i += 1;
        continue;
      }
      if (token.startsWith("-R") && token.length > 2) continue;
      if (GH_GLOBAL_OPTION_FLAGS.has(option)) continue;
      break;
    }
  }
  return false;
}

// Shared alternations so the positive and negated matchers always agree on what
// counts as a mitigation signal. Bare `test`/`tests` is intentionally excluded
// from the core word list: a path such as `rm -rf tests` names an affected
// surface, not a mitigation. Test wording only counts when it is phrased as an
// action or command that will validate the high-impact operation. Bare
// `limited` is also excluded: it only counts when tied to an explicit bounded
// target such as "limited to generated artifacts".
const LIMITED_SCOPE_MITIGATION_ALTS =
  "limit(?:ed|ing)?\\s+(?:to|within)\\s+(?:a\\s+|an\\s+|the\\s+)?(?:single|specific|named|targeted|scoped|bounded|local|current|selected|generated|disposable|temporary|repo|repository|workspace|file|files|path|paths|dir|directory|tree|artifact|artifacts|surface|scope)";
const CORE_MITIGATION_WORD_ALTS =
  "mitigat\\w*|rollback|recover\\w*|backup|dry[- ]?run|scop(?:e|ed|ing)|" +
  LIMITED_SCOPE_MITIGATION_ALTS +
  "|verif(?:y|ies|ied|ying|ication)|confirm(?:ed|ing|s)?|non[- ]?destructive|no irreversible";
const TEST_MITIGATION_ALTS =
  "(?:run|runs|running|rerun|reruns|rerunning|execute|executes|executing|pass|passes|passing)\\s+(?:the\\s+)?(?:unit\\s+|integration\\s+|smoke\\s+|regression\\s+)?tests?|" +
  "(?:npm|pnpm|yarn|node|pytest|cargo|go|make)\\s+test(?:s)?|" +
  "tests?\\s+(?:will|would|should|must|can)\\s+(?:pass|verify|confirm|validate|cover)|" +
  "testing\\s+(?:will|would|should|must|can)\\s+(?:verify|confirm|validate|cover)";
const MITIGATION_WORDS = new RegExp("\\b(?:" + CORE_MITIGATION_WORD_ALTS + ")\\b", "i");
const TEST_MITIGATION_WORDS = new RegExp("\\b(?:" + TEST_MITIGATION_ALTS + ")\\b", "i");
// Negators. Words that negate a mitigation AFTER the keyword ("rollback is
// unavailable", "verification is impossible") are included alongside the
// pre-keyword negators ("no verification").
const NEGATION_WORDS =
  "no|not|never|without|lack(?:s|ing)?|missing|unavailable|impossible|absent|cannot|can't|won't|doesn['’]t|don't|isn['’]t|aren['’]t";
// A mitigation cluster is one mitigation word, optionally extended across
// or/and/nor so "rollback or verification" is consumed as one unit.
const MITIGATION_CLUSTER =
  "(?:" + CORE_MITIGATION_WORD_ALTS + ")\\b(?:[\\s,.;:-]*(?:or|and|nor)[\\s,.;:-]+(?:" + CORE_MITIGATION_WORD_ALTS + ")\\b)*";
// A mitigation is negated when a negator lands within a few words on EITHER
// side of the cluster. Both arms strip the mitigation word(s) before
// MITIGATION_WORDS is re-tested, so an explicitly unmitigated high-impact
// command stays blocked. Without the after-keyword arm, "verification is not
// possible" / "rollback is unavailable" would leave the keyword intact, satisfy
// MITIGATION_WORDS, and bypass the gate.
const NEGATED_MITIGATION_WORDS = new RegExp(
  "\\b(?:" +
    "(?:" + NEGATION_WORDS + ")\\b(?:[\\s,.;:-]+\\w+){0,3}?[\\s,.;:-]+" + MITIGATION_CLUSTER +
    "|" +
    MITIGATION_CLUSTER + "(?:[\\s,.;:-]+\\w+){0,3}?[\\s,.;:-]+(?:" + NEGATION_WORDS + ")\\b" +
  ")",
  "gi",
);
const NEGATED_TEST_MITIGATION_WORDS = new RegExp(
  "\\b(?:" +
    "(?:" + NEGATION_WORDS + ")\\b(?:[\\s,.;:-]+\\w+){0,4}?[\\s,.;:-]+(?:" + TEST_MITIGATION_ALTS + ")" +
    "|" +
    "(?:" + TEST_MITIGATION_ALTS + ")(?:[\\s,.;:-]+\\w+){0,4}?[\\s,.;:-]+(?:" + NEGATION_WORDS + ")\\b" +
  ")",
  "gi",
);

function normalizePrediction(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value).trim();
  }
}

function distinctContentTokens(prediction) {
  const tokens = prediction.toLowerCase().match(/[a-z0-9][a-z0-9._/-]*/g) || [];
  const seen = new Set();
  for (const token of tokens) {
    if (!GENERIC_FILLER_WORDS.has(token)) seen.add(token);
  }
  return seen.size;
}

function isGenericPrediction(prediction) {
  const normalized = prediction.toLowerCase().replace(/[.!?]+$/g, "").trim();
  return (
    prediction.length < MIN_PREDICTION_CHARS ||
    GENERIC_PREDICTIONS.has(normalized) ||
    distinctContentTokens(normalized) < MIN_CONTENT_TOKENS
  );
}

function hasPositiveMitigationSignal(prediction) {
  const positiveText = prediction
    .replace(NEGATED_MITIGATION_WORDS, "")
    .replace(NEGATED_TEST_MITIGATION_WORDS, "");
  return MITIGATION_WORDS.test(positiveText) || TEST_MITIGATION_WORDS.test(positiveText);
}

function isHighImpactShell(command = "") {
  const commandText = String(command);
  return (
    hasRecursiveForceRm(commandText) ||
    hasRecursiveMetadataChange(commandText) ||
    hasGitPushInvocation(commandText) ||
    hasNpmRegistryMutationInvocation(commandText) ||
    hasGhReleaseInvocation(commandText) ||
    hasRemoteInstallerPipeline(commandText)
  );
}

function missingPredictionReason(toolName) {
  return `${toolName} requires consequence_prediction: forecast the intended effect, files/commands affected, likely failure modes, and verification/mitigation before acting.`;
}

export default {
  name: "consequence-predictor",
  hooks: {
    async SessionStart() {
      return {
        inject:
          "Consequence prediction gate: before write_file, patch_file, or run_shell, include a consequence_prediction string in the tool input. Forecast the intended effect, affected files/commands, likely failure modes, and verification or mitigation. The PreToolUse hook blocks missing/generic predictions and high-impact shell commands without mitigation.",
      };
    },

    async PreToolUse(input) {
      if (input.permission_mode === "yolo") return undefined;
      if (!GUARDED_TOOLS.has(input.tool_name)) return undefined;

      const toolInput = input.tool_input || {};
      const prediction = normalizePrediction(toolInput.consequence_prediction);
      if (!prediction) {
        return { decision: "block", reason: missingPredictionReason(input.tool_name) };
      }

      if (isGenericPrediction(prediction)) {
        return {
          decision: "block",
          reason: `${input.tool_name} consequence_prediction is too generic. Be specific about expected change, affected surface, failure modes, and verification/mitigation.`,
        };
      }

      if (
        input.tool_name === "run_shell" &&
        isHighImpactShell(toolInput.command) &&
        !hasPositiveMitigationSignal(prediction)
      ) {
        return {
          decision: "block",
          reason:
            "High-impact shell commands need a consequence_prediction that names the mitigation, rollback, dry-run, scope limit, or verification before execution.",
        };
      }

      return undefined;
    },
  },
};
