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
const SCRIPT_FILE_CONSUMERS = new Set(["source", "."]);
const SHELL_COMMAND_STRING_DEPTH_LIMIT = 3;
const SHELL_COMMAND_STRING_OPTIONS_WITH_VALUE = new Set(["-o", "-O", "--init-file", "--rcfile"]);
const NO_OPTIONS_WITH_VALUE = new Set();
const EXEC_OPTIONS_WITH_VALUE = new Set(["-a"]);
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
const TIMEOUT_OPTIONS_WITH_VALUE = new Set(["-k", "--kill-after", "-s", "--signal"]);
const TIME_OPTIONS_WITH_VALUE = new Set(["-f", "--format", "-o", "--output"]);
const STDBUF_OPTIONS_WITH_VALUE = new Set(["-e", "--error", "-i", "--input", "-o", "--output"]);
const PIPELINE_COMMAND_WRAPPER_OPTIONS_WITH_VALUE = new Map([
  ["exec", EXEC_OPTIONS_WITH_VALUE],
  ["nohup", NO_OPTIONS_WITH_VALUE],
  ["nice", new Set(["-n", "--adjustment"])],
  ["stdbuf", STDBUF_OPTIONS_WITH_VALUE],
  ["time", TIME_OPTIONS_WITH_VALUE],
]);
// Shell syntax words that can legally occupy the command position before the
// executable that actually runs. The scanner is not a full shell parser, but it
// must not stop at `if`/`do`/`then` while a high-impact command follows in the
// same parsed stage.
const SHELL_CONTROL_COMMAND_PREFIXES = new Set(["!", "{", "if", "then", "do", "else", "elif", "while", "until"]);
const SHELL_CONTROL_STRUCTURE_WORDS = new Set(["}", "for", "select", "in", "fi", "done", "esac"]);
const SHELL_SUBSHELL_PREFIX_WORDS = new Set(["!", "if", "then", "do", "else", "elif", "while", "until"]);

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
const GH_API_MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
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

// Registry-mutating npm subcommands that must be classified high-impact.
// Include common npm abbreviations that resolve to the same mutating commands.
const NPM_REGISTRY_MUTATION_SUBCOMMANDS = new Set([
  "publish", "pub", "pu", "publ",
  "unpublish", "unp", "unpub", "unpubl",
  "deprecate", "dep", "undeprecate", "undep",
]);
const NPM_DIST_TAG_SUBCOMMANDS = new Set(["dist-tag", "dist-tags"]);
const NPM_DIST_TAG_MUTATION_SUBCOMMANDS = new Set(["add", "rm", "remove", "del", "delete"]);
const NPM_SCOPED_MUTATION_SUBCOMMANDS = new Map([
  ["owner", new Set(["add", "rm", "remove", "delete", "del"])],
  ["author", new Set(["add", "rm", "remove", "delete", "del"])],
  ["access", new Set(["set", "grant", "revoke", "rm", "remove", "delete", "del"])],
  ["team", new Set(["create", "destroy", "add", "rm", "remove", "delete", "del"])],
  ["org", new Set(["set", "rm", "remove", "delete", "del"])],
  ["token", new Set(["create", "revoke", "rm", "remove", "delete", "del"])],
  ["trust", new Set(["github", "revoke", "rm", "remove", "delete", "del"])],
]);
// `npm exec` and the documented `npm x` alias can run a nested `npm publish` /
// `npm unpublish` command. Treat those nested registry mutations as high-impact
// without over-blocking local scripts such as `npm exec -- npm run publish`.
const NPM_EXEC_SUBCOMMANDS = new Set(["exec", "x", "exe"]);
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
  "dedupe", "dep", "deprecate", "diff", "dist-tag", "dist-tags", "docs", "doctor", "edit", "exe", "exec",
  "explain", "explore", "find-dupes", "fund", "get", "help", "hook", "i",
  "init", "install", "install-clean", "link", "ln", "login", "logout", "ls",
  "org", "outdated", "owner", "pack", "ping", "pkg", "prefix", "profile",
  "prune", "pu", "pub", "publ", "publish", "query", "rebuild", "remove", "restart", "rm", "root",
  "run", "run-script", "search", "set", "shrinkwrap", "start", "stop", "t",
  "team", "test", "token", "trust", "undep", "undeprecate", "uninstall", "unp", "unpub", "unpubl", "unpublish", "unstar", "update",
  "upgrade", "version", "view", "whoami", "x",
]);

function hasRecursiveForceRm(command = "") {
  for (const tokens of shellCommandStages(command)) {
    const commandIndex = commandInvocationIndex(tokens);
    if (commandIndex === -1 || commandName(tokens[commandIndex]) !== "rm") continue;

    let recursive = false;
    let force = false;
    for (const token of tokens.slice(commandIndex + 1)) {
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
  for (const tokens of shellCommandStages(command)) {
    const commandIndex = commandInvocationIndex(tokens);
    if (commandIndex === -1) continue;
    const name = commandName(tokens[commandIndex]);
    if (name !== "chmod" && name !== "chown") continue;

    for (const token of tokens.slice(commandIndex + 1)) {
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

function isNpmExecutableName(name) {
  return name === "npm" || /^npm@[^\s/]+$/.test(name);
}

function shellWords(value = "") {
  const text = String(value);
  const words = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (escaped) {
      if (ch === "\n") {
        escaped = false;
        continue;
      }
      if (ch === "\r" && text[index + 1] === "\n") {
        index += 1;
        escaped = false;
        continue;
      }
      current += ch;
      escaped = false;
      continue;
    }

    if (!quote && ch === "$" && (text[index + 1] === "'" || text[index + 1] === '"')) {
      quote = text[index + 1];
      index += 1;
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

// Parse shell command text into command stages while applying the same simple
// backslash and quote handling as shellWords(). High-impact classifiers must
// inspect normalized tokens (e.g. `n\pm publish` -> `npm publish`) instead of
// raw regex matches, because the shell executes escaped command names normally.
function shellPipelines(value = "") {
  const text = String(value);
  const pipelines = [];
  let pipeline = [];
  let tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;

  function pushToken() {
    if (!current) return;
    tokens.push(current);
    current = "";
  }

  function pushStage() {
    pushToken();
    if (!tokens.length) return;
    pipeline.push(tokens);
    tokens = [];
  }

  function pushPipeline() {
    pushStage();
    if (!pipeline.length) return;
    pipelines.push(pipeline);
    pipeline = [];
  }

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (escaped) {
      if (ch === "\n") {
        escaped = false;
        continue;
      }
      if (ch === "\r" && text[index + 1] === "\n") {
        index += 1;
        escaped = false;
        continue;
      }
      current += ch;
      escaped = false;
      continue;
    }

    if (!quote && ch === "$" && (text[index + 1] === "'" || text[index + 1] === '"')) {
      quote = text[index + 1];
      index += 1;
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

    if (ch === "|") {
      if (text[index + 1] === "|") {
        pushPipeline();
        index += 1;
      } else {
        pushStage();
        if (text[index + 1] === "&") index += 1;
      }
      continue;
    }

    if (ch === ";" || ch === "&" || ch === "\n") {
      pushPipeline();
      if (ch === "&" && text[index + 1] === "&") index += 1;
      continue;
    }

    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }

    current += ch;
  }

  if (escaped) current += "\\";
  pushPipeline();
  return pipelines;
}

function shellCommandStages(value = "") {
  return shellPipelines(value).flat();
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

function shellRedirectionOperand(token) {
  const text = String(token);
  const match = text.match(/^(?:\d+)?(?:<<<|<<-?|<>|>>|>\||>&|<&|>|<)(.*)$/) || text.match(/^&>>?(.*)$/);
  return match ? match[1] : undefined;
}

function skipShellRedirection(tokens, index) {
  const operand = shellRedirectionOperand(tokens[index]);
  if (operand === undefined) return index;
  return operand === "" ? index + 2 : index + 1;
}

function caseArmCommandIndex(tokens, start) {
  for (let i = start; i < tokens.length; i += 1) {
    if (String(tokens[i]).endsWith(")")) return commandInvocationIndex(tokens, i + 1);
  }
  return -1;
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
    const afterRedirection = skipShellRedirection(tokens, i);
    if (afterRedirection !== i) {
      i = afterRedirection;
      continue;
    }

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

function shellCommandStringAfterOptions(tokens, start) {
  const valueChars = shortValueOptionChars(SHELL_COMMAND_STRING_OPTIONS_WITH_VALUE);
  const commandStringValueChars = new Set(valueChars);
  commandStringValueChars.add("c");

  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") return undefined;
    if (isAssignment(token)) continue;
    if (!token.startsWith("-")) return undefined;

    if (token.startsWith("--")) {
      const option = optionName(token);
      if (SHELL_COMMAND_STRING_OPTIONS_WITH_VALUE.has(option) && !token.includes("=")) i += 1;
      continue;
    }

    const cluster = splitShortCluster(token, commandStringValueChars);
    if (cluster.valueChar === "c") {
      return cluster.valueConsumesNext ? tokens[i + 1] : cluster.attachedValue;
    }
    if (cluster.valueConsumesNext) i += 1;
  }
  return undefined;
}

function evalCommandString(tokens, start) {
  const command = tokens.slice(start).join(" ").trim();
  return command || undefined;
}

function previousSignificantChar(text, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (!/\s/.test(text[i])) return text[i];
  }
  return "";
}

function previousShellWord(text, index) {
  let end = index - 1;
  while (end >= 0 && /\s/.test(text[end])) end -= 1;
  if (end < 0) return "";
  let start = end;
  while (start >= 0 && !/[\s;|&(){}]/.test(text[start])) start -= 1;
  return text.slice(start + 1, end + 1);
}

function startsShellSubshellGroup(text, index) {
  const previous = previousSignificantChar(text, index);
  if (previous === "" || previous === ";" || previous === "|" || previous === "&" || previous === "(" || previous === "!" || previous === ")") {
    return true;
  }
  return SHELL_SUBSHELL_PREFIX_WORDS.has(previousShellWord(text, index));
}

function startsShellCommandWord(text, index) {
  return startsShellSubshellGroup(text, index);
}

function matchingParenIndex(text, openIndex) {
  let depth = 1;
  let quote = null;
  let escaped = false;

  for (let i = openIndex + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function matchingBacktickIndex(text, start) {
  let escaped = false;
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "`") return i;
  }
  return -1;
}

function hasRemoteDownloadInvocation(command = "") {
  for (const tokens of shellCommandStages(command)) {
    if (stageHasRemoteDownloadInvocation(tokens)) return true;
  }
  return false;
}

function stageHasRemoteDownloadInvocation(tokens) {
  const commandIndex = commandInvocationIndex(tokens);
  if (commandIndex === -1) return false;
  const name = commandName(tokens[commandIndex]);
  return name === "curl" || name === "wget";
}

function commandConsumesScriptFromStdin(command = "") {
  for (const pipeline of shellPipelines(command)) {
    for (const stage of pipeline) {
      if (pipelineTargetConsumesScript(stage)) return true;
    }
  }
  return false;
}

function processSubstitutionFeedsScriptConsumer(text, index, nestedCommand) {
  if (!hasRemoteDownloadInvocation(nestedCommand)) return false;

  const stagesBeforeSubstitution = shellCommandStages(String(text).slice(0, index));
  const currentStage = stagesBeforeSubstitution[stagesBeforeSubstitution.length - 1] || [];
  return pipelineTargetConsumesScript(currentStage);
}

function processSubstitutionConsumesDownloaderOutput(text, index, nestedCommand) {
  if (text[index] !== ">") return false;
  if (!commandConsumesScriptFromStdin(nestedCommand)) return false;

  const pipelinesBeforeSubstitution = shellPipelines(String(text).slice(0, index));
  const currentPipeline = pipelinesBeforeSubstitution[pipelinesBeforeSubstitution.length - 1] || [];
  return currentPipeline.some((stage) => stageHasRemoteDownloadInvocation(stage));
}

function hasShellExpansionHighImpact(command = "", depth = 0) {
  if (depth >= SHELL_COMMAND_STRING_DEPTH_LIMIT) return false;

  const text = String(command);
  let quote = null;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      // Command substitutions and backticks still execute inside double quotes;
      // only single quotes make them literal shell text.
      if (quote === "'") continue;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === "$" && text[i + 1] === "(") {
      const close = matchingParenIndex(text, i + 1);
      if (close !== -1) {
        const nestedCommand = text.slice(i + 2, close);
        if (isHighImpactShell(nestedCommand, depth + 1)) return true;
        if (startsShellCommandWord(text, i) && hasRemoteDownloadInvocation(nestedCommand)) return true;
        i = close;
      }
      continue;
    }

    if (ch === "`") {
      const close = matchingBacktickIndex(text, i);
      if (close !== -1) {
        const nestedCommand = text.slice(i + 1, close);
        if (isHighImpactShell(nestedCommand, depth + 1)) return true;
        if (startsShellCommandWord(text, i) && hasRemoteDownloadInvocation(nestedCommand)) return true;
        i = close;
      }
      continue;
    }

    // Bash process substitutions (`<(cmd)` / `>(cmd)`) execute the nested
    // command before the visible command completes. Quotes make this syntax
    // literal, unlike `$()` and backticks inside double quotes.
    if (!quote && (ch === "<" || ch === ">") && text[i + 1] === "(") {
      const close = matchingParenIndex(text, i + 1);
      if (close !== -1) {
        const nestedCommand = text.slice(i + 2, close);
        if (
          isHighImpactShell(nestedCommand, depth + 1) ||
          processSubstitutionFeedsScriptConsumer(text, i, nestedCommand) ||
          processSubstitutionConsumesDownloaderOutput(text, i, nestedCommand)
        ) {
          return true;
        }
        i = close;
      }
      continue;
    }

    if (ch === "(" && startsShellSubshellGroup(text, i)) {
      const close = matchingParenIndex(text, i);
      if (close !== -1) {
        const nestedCommand = text.slice(i + 1, close);
        if (isHighImpactShell(nestedCommand, depth + 1)) return true;
        i = close;
      }
    }
  }

  return false;
}

function envSplitStringHasHighImpact(tokens, start, depth) {
  if (depth >= SHELL_COMMAND_STRING_DEPTH_LIMIT) return false;

  const valueChars = shortValueOptionChars(ENV_OPTIONS_WITH_VALUE);
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") return false;
    if (isAssignment(token)) continue;
    if (!token.startsWith("-")) return false;

    if (token.startsWith("--")) {
      const option = optionName(token);
      if (option === "--split-string") {
        const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : tokens[i + 1];
        if (value !== undefined && isHighImpactShell(value, depth + 1)) return true;
        if (!token.includes("=")) i += 1;
        continue;
      }
      if (ENV_OPTIONS_WITH_VALUE.has(option) && !token.includes("=")) i += 1;
      continue;
    }

    const cluster = splitShortCluster(token, valueChars);
    if (cluster.valueChar === "S") {
      const value = cluster.valueConsumesNext ? tokens[i + 1] : cluster.attachedValue;
      if (value !== undefined && isHighImpactShell(value, depth + 1)) return true;
    }
    if (cluster.valueConsumesNext) i += 1;
  }
  return false;
}

function hasShellCommandStringHighImpact(command = "", depth = 0) {
  if (depth >= SHELL_COMMAND_STRING_DEPTH_LIMIT) return false;

  for (const tokens of shellCommandStages(command)) {
    const commandIndex = commandInvocationIndex(tokens);
    if (commandIndex === -1) continue;

    const name = commandName(tokens[commandIndex]);
    if (name === "eval") {
      const nestedCommand = evalCommandString(tokens, commandIndex + 1);
      if (nestedCommand !== undefined && isHighImpactShell(nestedCommand, depth + 1)) return true;
    }
    if (name === "env" && envSplitStringHasHighImpact(tokens, commandIndex + 1, depth)) return true;
    if (!PIPELINE_SHELLS.has(name)) continue;

    const nestedCommand = shellCommandStringAfterOptions(tokens, commandIndex + 1);
    if (nestedCommand !== undefined && isHighImpactShell(nestedCommand, depth + 1)) return true;
  }
  return false;
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
    const afterRedirection = skipShellRedirection(tokens, i);
    if (afterRedirection !== i) {
      i = afterRedirection - 1;
      continue;
    }

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

function sudoShellCommandIndex(tokens, start) {
  const valueChars = shortValueOptionChars(SUDO_OPTIONS_WITH_VALUE);
  let shellMode = false;
  for (let i = start; i < tokens.length; i += 1) {
    const afterRedirection = skipShellRedirection(tokens, i);
    if (afterRedirection !== i) {
      i = afterRedirection - 1;
      continue;
    }

    const token = tokens[i];
    if (token === "--") return shellMode ? commandInvocationIndex(tokens, i + 1) : -1;
    if (isAssignment(token)) continue;
    if (!token.startsWith("-")) return shellMode ? i : -1;

    if (token.startsWith("--")) {
      const option = optionName(token);
      if (SUDO_SHELL_MODE_FLAGS.has(option)) shellMode = true;
      if (SUDO_OPTIONS_WITH_VALUE.has(option) && !token.includes("=")) i += 1;
      continue;
    }

    const cluster = splitShortCluster(token, valueChars);
    if (cluster.flags.includes("s") || cluster.flags.includes("i")) shellMode = true;
    if (cluster.valueConsumesNext) i += 1;
  }
  return -1;
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

function timeoutCommandIndex(tokens, start) {
  const durationIndex = skipWrapperOptions(tokens, start, TIMEOUT_OPTIONS_WITH_VALUE);
  return durationIndex < tokens.length ? durationIndex + 1 : durationIndex;
}

function envCommandIndex(tokens, start) {
  const valueChars = shortValueOptionChars(ENV_OPTIONS_WITH_VALUE);
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
      if (option === "--split-string") return -1;
      i += 1;
      if (ENV_OPTIONS_WITH_VALUE.has(option) && !token.includes("=")) i += 1;
      continue;
    }

    const cluster = splitShortCluster(token, valueChars);
    if (cluster.valueChar === "S") return -1;
    i += 1;
    if (cluster.valueConsumesNext) i += 1;
  }
  return -1;
}

function commandInvocationIndex(tokens, start = 0) {
  let i = start;
  while (i < tokens.length) {
    const afterRedirection = skipShellRedirection(tokens, i);
    if (afterRedirection !== i) {
      i = afterRedirection;
      continue;
    }

    const name = commandName(tokens[i]);
    if (isAssignment(tokens[i])) {
      i += 1;
      continue;
    }
    if (SHELL_CONTROL_COMMAND_PREFIXES.has(name)) {
      i += 1;
      continue;
    }
    if (String(tokens[i]).endsWith(")")) {
      i += 1;
      continue;
    }
    if (name === "case") {
      const caseCommandIndex = caseArmCommandIndex(tokens, i + 1);
      if (caseCommandIndex !== -1) {
        i = caseCommandIndex;
        continue;
      }
      return -1;
    }
    if (SHELL_CONTROL_STRUCTURE_WORDS.has(name)) return -1;
    if (name === "sudo") {
      const shellCommandIndex = sudoShellCommandIndex(tokens, i + 1);
      if (shellCommandIndex !== -1) {
        i = shellCommandIndex;
        continue;
      }
      if (sudoLaunchesShell(tokens, i + 1)) return i;
      i = skipWrapperOptions(tokens, i + 1, SUDO_OPTIONS_WITH_VALUE);
      continue;
    }
    if (name === "env") {
      const next = envCommandIndex(tokens, i + 1);
      if (next === -1) return i;
      i = next;
      continue;
    }
    if (name === "command") {
      i = skipWrapperOptions(tokens, i + 1, NO_OPTIONS_WITH_VALUE);
      continue;
    }
    if (name === "timeout") {
      i = timeoutCommandIndex(tokens, i + 1);
      continue;
    }
    const wrapperOptions = PIPELINE_COMMAND_WRAPPER_OPTIONS_WITH_VALUE.get(name);
    if (wrapperOptions) {
      i = skipWrapperOptions(tokens, i + 1, wrapperOptions);
      continue;
    }
    return i;
  }
  return -1;
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
    if (name === "timeout") {
      i = timeoutCommandIndex(tokens, i + 1);
      continue;
    }
    const wrapperOptions = PIPELINE_COMMAND_WRAPPER_OPTIONS_WITH_VALUE.get(name);
    if (wrapperOptions) {
      i = skipWrapperOptions(tokens, i + 1, wrapperOptions);
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

function pipelineTargetConsumesScript(tokens) {
  if (pipelineTargetInvokesShell(tokens)) return true;

  let i = 0;
  while (i < tokens.length) {
    const name = commandName(tokens[i]);
    if (SCRIPT_FILE_CONSUMERS.has(name)) return true;
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

function hasRemoteDownloadExpansion(command = "", depth = 0) {
  if (depth >= SHELL_COMMAND_STRING_DEPTH_LIMIT) return false;
  const text = String(command);
  let quote = null;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      if (quote === "'") continue;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === "$" && text[i + 1] === "(") {
      const close = matchingParenIndex(text, i + 1);
      if (close !== -1) {
        const nestedCommand = text.slice(i + 2, close);
        if (hasRemoteDownloadInvocation(nestedCommand) || hasRemoteDownloadExpansion(nestedCommand, depth + 1)) return true;
        i = close;
      }
      continue;
    }
    if (ch === "`") {
      const close = matchingBacktickIndex(text, i);
      if (close !== -1) {
        const nestedCommand = text.slice(i + 1, close);
        if (hasRemoteDownloadInvocation(nestedCommand) || hasRemoteDownloadExpansion(nestedCommand, depth + 1)) return true;
        i = close;
      }
    }
  }
  return false;
}

function isHereStringRedirectionToken(token) {
  return /^\d*<<<.*$/.test(String(token));
}

function hasRemoteInstallerHereString(command = "") {
  for (const tokens of shellCommandStages(command)) {
    if (!pipelineTargetConsumesScript(tokens)) continue;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      const operand = shellRedirectionOperand(token);
      if (operand === undefined || !isHereStringRedirectionToken(token)) continue;
      const payload = operand === "" ? tokens[i + 1] : operand;
      if (payload && (hasRemoteDownloadInvocation(payload) || hasRemoteDownloadExpansion(payload))) return true;
    }
  }
  return false;
}

function hasRemoteInstallerPipeline(command = "") {
  for (const pipeline of shellPipelines(command)) {
    for (let sourceIndex = 0; sourceIndex < pipeline.length - 1; sourceIndex += 1) {
      const hasRemoteDownloader = pipeline[sourceIndex].some((token) => {
        const name = commandName(token);
        return name === "curl" || name === "wget";
      });
      if (!hasRemoteDownloader) continue;

      for (const stage of pipeline.slice(sourceIndex + 1)) {
        if (pipelineTargetInvokesShell(stage)) return true;
      }
    }
  }
  return false;
}

function npmShellCommandHasRegistryMutation(command = "", depth = 0) {
  if (depth >= 3) return false;
  for (const tokens of shellCommandStages(command)) {
    const commandIndex = commandInvocationIndex(tokens);
    if (commandIndex === -1) continue;

    const name = commandName(tokens[commandIndex]);
    if (isNpmExecutableName(name)) {
      if (npmTokensHaveRegistryMutation(tokens, commandIndex + 1, depth)) return true;
      continue;
    }
    if (name === "npx" && npmExecHasRegistryMutation(tokens, commandIndex + 1, depth)) return true;
  }
  return false;
}

function nestedNpmCommandHasRegistryMutation(tokens, start, depth) {
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (isAssignment(token)) continue;
    if (isNpmExecutableName(commandName(token))) return npmTokensHaveRegistryMutation(tokens, i + 1, depth + 1);
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
      !isNpmExecutableName(commandName(next)) &&
      !NPM_SUBCOMMANDS.has(next)
    ) {
      i += 1;
    }
  }
  return false;
}

function npmNextActionToken(tokens, start) {
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") continue;
    if (isAssignment(token)) continue;
    if (!token.startsWith("-")) return token;

    const option = npmGlobalOptionName(token);
    if (
      NPM_GLOBAL_OPTIONS_WITH_VALUE.has(option) ||
      NPM_PUBLISH_OPTIONS_WITH_VALUE.has(option) ||
      NPM_EXEC_PACKAGE_OPTIONS_WITH_VALUE.has(option)
    ) {
      if (!token.includes("=")) i += 1;
      continue;
    }
    if ((token.startsWith("-w") || token.startsWith("-C") || token.startsWith("-p")) && token.length > 2) continue;
    if (NPM_GLOBAL_OPTION_FLAGS.has(option) || NPM_PUBLISH_OPTION_FLAGS.has(option)) continue;
  }
  return undefined;
}

function npmTokenStartsRegistryMutation(tokens, index) {
  const token = tokens[index];
  if (NPM_REGISTRY_MUTATION_SUBCOMMANDS.has(token)) return true;
  if (NPM_DIST_TAG_SUBCOMMANDS.has(token)) {
    return NPM_DIST_TAG_MUTATION_SUBCOMMANDS.has(npmNextActionToken(tokens, index + 1));
  }
  const scopedMutations = NPM_SCOPED_MUTATION_SUBCOMMANDS.get(token);
  return Boolean(scopedMutations && scopedMutations.has(npmNextActionToken(tokens, index + 1)));
}

function shellCommandFromTokens(tokens) {
  return tokens
    .map((token) => {
      const text = String(token);
      return /\s/.test(text) ? `'${text.replace(/'/g, `'\\''`)}'` : text;
    })
    .join(" ");
}

function npmExploreHasHighImpact(tokens, start, depth) {
  if (depth >= 3) return false;
  let sawPackage = false;
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") {
      if (!sawPackage) continue;
      const nestedCommand = shellCommandFromTokens(tokens.slice(i + 1)).trim();
      return nestedCommand ? isHighImpactShell(nestedCommand, depth + 1) : false;
    }
    if (isAssignment(token)) continue;
    if (!token.startsWith("-")) {
      sawPackage = true;
      continue;
    }

    const option = npmGlobalOptionName(token);
    if (NPM_GLOBAL_OPTIONS_WITH_VALUE.has(option)) {
      if (!token.includes("=")) i += 1;
      continue;
    }
    if ((token.startsWith("-w") || token.startsWith("-C")) && token.length > 2) continue;
    if (NPM_GLOBAL_OPTION_FLAGS.has(option)) continue;
  }
  return false;
}

function npmTokensHaveRegistryMutation(tokens, start = 0, depth = 0) {
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (npmTokenStartsRegistryMutation(tokens, i)) return true;
    if (NPM_EXEC_SUBCOMMANDS.has(token)) return npmExecHasRegistryMutation(tokens, i + 1, depth);
    if (token === "explore") return npmExploreHasHighImpact(tokens, i + 1, depth);
    // npm accepts `--` before the subcommand (for example `npm -- publish`),
    // so the option terminator must not mask a following registry mutation.
    if (token === "--") continue;
    if (!token.startsWith("-")) break;

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
      !npmTokenStartsRegistryMutation(tokens, i + 1) &&
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

function gitAliasFromConfig(value) {
  const match = String(value || "").match(/^alias\.([A-Za-z0-9_-]+)=(.*)$/);
  return match ? { name: match[1], expansion: match[2] } : null;
}

function gitAliasExpansionPushes(expansion, depth) {
  const text = String(expansion || "").trim();
  if (!text) return false;
  if (text.startsWith("!")) return isHighImpactShell(text.slice(1), depth + 1);
  return commandName(shellWords(text)[0] || "") === "push";
}

function hasGitPushInvocation(command = "", depth = 0) {
  for (const tokens of shellCommandStages(command)) {
    const commandIndex = commandInvocationIndex(tokens);
    if (commandIndex === -1 || commandName(tokens[commandIndex]) !== "git") continue;

    const aliases = new Map();
    for (let i = commandIndex + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "push") return true;
      if (token === "--") break;
      if (!token.startsWith("-")) {
        const expansion = aliases.get(token);
        if (expansion !== undefined && gitAliasExpansionPushes(expansion, depth)) return true;
        break;
      }

      const option = gitGlobalOptionName(token);
      if (option === "-c") {
        const value = token === "-c" ? tokens[i + 1] : token.slice(2);
        const alias = gitAliasFromConfig(value);
        if (alias) aliases.set(alias.name, alias.expansion);
        if (token === "-c") i += 1;
        continue;
      }
      if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(option)) {
        if (!token.includes("=")) i += 1;
        continue;
      }
      if (token.startsWith("-C")) continue;
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

function ghApiMutatesReleaseEndpoint(tokens, start) {
  let method = "GET";
  let sawRequestFields = false;
  let endpoint;

  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") continue;

    if (token === "-X" || token === "--method") {
      method = String(tokens[i + 1] || "").toUpperCase();
      i += 1;
      continue;
    }
    if (token.startsWith("-X") && token.length > 2) {
      method = token.slice(2).toUpperCase();
      continue;
    }
    if (token.startsWith("--method=")) {
      method = token.slice(token.indexOf("=") + 1).toUpperCase();
      continue;
    }

    if (["-f", "--field", "-F", "--raw-field"].includes(token)) {
      sawRequestFields = true;
      i += 1;
      continue;
    }
    if (token.startsWith("-f") && token.length > 2) {
      sawRequestFields = true;
      continue;
    }
    if (token.startsWith("--field=") || token.startsWith("--raw-field=")) {
      sawRequestFields = true;
      continue;
    }
    if (["-H", "--header", "--hostname", "--input", "--jq", "-q", "--template", "-t"].includes(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith("--hostname=") || token.startsWith("--input=") || token.startsWith("--jq=") || token.startsWith("--template=")) {
      continue;
    }
    if (["--cache", "--paginate", "--slurp", "--silent", "--verbose", "--include", "-i"].includes(token)) continue;
    if (token.startsWith("-")) continue;

    if (!endpoint) endpoint = token;
  }

  if (!endpoint) return false;
  const effectiveMethod = method === "GET" && sawRequestFields ? "POST" : method;
  const normalizedEndpoint = endpoint.replace(/^\/+/, "");
  return GH_API_MUTATING_METHODS.has(effectiveMethod) && /^repos\/[^/]+\/[^/]+\/releases(?:$|\/)/.test(normalizedEndpoint);
}

function hasGhReleaseInvocation(command = "") {
  for (const tokens of shellCommandStages(command)) {
    const commandIndex = commandInvocationIndex(tokens);
    if (commandIndex === -1 || commandName(tokens[commandIndex]) !== "gh") continue;

    for (let i = commandIndex + 1; i < tokens.length; i += 1) {
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
        // this gh invocation so the outer stage scan reaches the next one.
        break;
      }
      if (token === "api") {
        if (ghApiMutatesReleaseEndpoint(tokens, i + 1)) return true;
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

function matchingBraceIndex(text, openIndex) {
  let depth = 1;
  let quote = null;
  let escaped = false;

  for (let i = openIndex + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function hasShellFunctionDefinitionHighImpact(command = "", depth = 0) {
  if (depth >= SHELL_COMMAND_STRING_DEPTH_LIMIT) return false;
  const text = String(command);
  const functionStart = /(?:^|[;\s])(?:function\s+[A-Za-z_][A-Za-z0-9_]*\s*|[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*)\{/g;
  let match;
  while ((match = functionStart.exec(text)) !== null) {
    const open = text.indexOf("{", match.index);
    if (open === -1) continue;
    const close = matchingBraceIndex(text, open);
    if (close === -1) continue;
    const body = text.slice(open + 1, close);
    if (isHighImpactShell(body, depth + 1)) return true;
    functionStart.lastIndex = close + 1;
  }
  return false;
}

function xargsNestedCommandIndex(tokens, start) {
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") return i + 1;
    if (!token.startsWith("-")) return i;
    if (["-I", "-L", "-n", "-P", "-s", "--replace", "--max-lines", "--max-args", "--max-procs", "--max-chars", "--arg-file", "-a", "--delimiter", "-d"].includes(optionName(token))) {
      if (!token.includes("=") && token.length === optionName(token).length) i += 1;
      continue;
    }
  }
  return -1;
}

function hasXargsNestedHighImpact(command = "", depth = 0) {
  if (depth >= SHELL_COMMAND_STRING_DEPTH_LIMIT) return false;
  for (const tokens of shellCommandStages(command)) {
    const commandIndex = commandInvocationIndex(tokens);
    if (commandIndex === -1 || commandName(tokens[commandIndex]) !== "xargs") continue;
    const nestedIndex = xargsNestedCommandIndex(tokens, commandIndex + 1);
    if (nestedIndex !== -1 && isHighImpactShell(tokens.slice(nestedIndex).join(" "), depth + 1)) return true;
  }
  return false;
}

function hasFindExecHighImpact(command = "", depth = 0) {
  if (depth >= SHELL_COMMAND_STRING_DEPTH_LIMIT) return false;
  for (const tokens of shellCommandStages(command)) {
    const commandIndex = commandInvocationIndex(tokens);
    if (commandIndex === -1 || commandName(tokens[commandIndex]) !== "find") continue;
    for (let i = commandIndex + 1; i < tokens.length; i += 1) {
      if (tokens[i] !== "-exec" && tokens[i] !== "-execdir") continue;
      const nested = [];
      for (let j = i + 1; j < tokens.length && tokens[j] !== ";" && tokens[j] !== "+"; j += 1) {
        nested.push(tokens[j]);
      }
      if (nested.length && isHighImpactShell(nested.join(" "), depth + 1)) return true;
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

function isHighImpactShell(command = "", depth = 0) {
  const commandText = String(command);
  return (
    hasRecursiveForceRm(commandText) ||
    hasRecursiveMetadataChange(commandText) ||
    hasGitPushInvocation(commandText, depth) ||
    hasNpmRegistryMutationInvocation(commandText) ||
    hasGhReleaseInvocation(commandText) ||
    hasRemoteInstallerPipeline(commandText) ||
    hasRemoteInstallerHereString(commandText) ||
    hasShellCommandStringHighImpact(commandText, depth) ||
    hasShellExpansionHighImpact(commandText, depth) ||
    hasShellFunctionDefinitionHighImpact(commandText, depth) ||
    hasXargsNestedHighImpact(commandText, depth) ||
    hasFindExecHighImpact(commandText, depth)
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
