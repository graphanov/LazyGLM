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
const PIPELINE_SHELLS = new Set(["sh", "bash", "zsh"]);
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
const ENV_OPTIONS_WITH_VALUE = new Set(["-C", "--chdir", "-S", "-u", "--unset"]);

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
const NPM_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "--cache",
  "--cert",
  "--cidr",
  "--diff",
  "--globalconfig",
  "--heading",
  "--https-proxy",
  "--key",
  "--local-address",
  "--loglevel",
  "--logs-dir",
  "--logs-max",
  "--node-options",
  "--otp",
  "--pack-destination",
  "--prefix",
  "--proxy",
  "--registry",
  "--script-shell",
  "--tag",
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
      return { flags, valueConsumesNext: body.slice(i + 1).length === 0 };
    }
    flags.push(ch);
  }
  return { flags, valueConsumesNext: false };
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
      i = skipWrapperOptions(tokens, i + 1, ENV_OPTIONS_WITH_VALUE);
      continue;
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

function hasNpmPublishInvocation(command = "") {
  const commandText = String(command);
  for (const match of commandText.matchAll(NPM_INVOCATION)) {
    const tokens = shellWords(match.groups?.args || "");

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "publish") return true;
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
      break;
    }
  }
  return false;
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

function hasGhReleaseInvocation(command = "") {
  const commandText = String(command);
  for (const match of commandText.matchAll(GH_INVOCATION)) {
    const tokens = shellWords(match.groups?.args || "");

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "release") return true;
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

// Shared alternation so the positive and negated matchers always agree on what
// counts as a mitigation signal.
const MITIGATION_WORD_ALTS =
  "mitigat\\w*|rollback|recover\\w*|backup|dry[- ]?run|scop(?:e|ed|ing)|limit(?:ed|ing)?|verif(?:y|ies|ied|ying|ication)|test(?:ed|ing|s)?|confirm(?:ed|ing|s)?|non[- ]?destructive|no irreversible";
const MITIGATION_WORDS = new RegExp("\\b(?:" + MITIGATION_WORD_ALTS + ")\\b", "i");
// A negation word can chain across conjunctions ("cannot test or verify"), so
// the matcher consumes each linked mitigation word rather than only the first —
// otherwise "verify" survives the replacement and re-satisfies MITIGATION_WORDS,
// letting an explicitly unmitigated rm -rf / publish / push bypass the gate.
const NEGATED_MITIGATION_WORDS = new RegExp(
  "\\b(?:no|not|never|without|lack(?:s|ing)?|missing|cannot|can't|won't|doesn['’]t|don't|isn['’]t|aren['’]t)\\b" +
    "(?:[\\s,.;:-]+\\w+){0,3}?[\\s,.;:-]+(?:" + MITIGATION_WORD_ALTS + ")\\b" +
    "(?:[\\s,.;:-]*(?:or|and|nor)[\\s,.;:-]+(?:" + MITIGATION_WORD_ALTS + ")\\b)*",
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
  return MITIGATION_WORDS.test(prediction.replace(NEGATED_MITIGATION_WORDS, ""));
}

function isHighImpactShell(command = "") {
  const commandText = String(command);
  return (
    hasRecursiveForceRm(commandText) ||
    hasRecursiveMetadataChange(commandText) ||
    hasGitPushInvocation(commandText) ||
    hasNpmPublishInvocation(commandText) ||
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
