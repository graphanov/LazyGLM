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

const HIGH_IMPACT_SHELL_PATTERNS = [
  /\bgh\s+release\b/i,
];
const REMOTE_INSTALLER_PIPE = /\b(?:curl|wget)\b[^|\n]*\|\s*(?<target>[^;&|\n]+)/gi;
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
const ENV_OPTIONS_WITH_VALUE = new Set(["-C", "--chdir", "-S", "-u", "--unset"]);

const RM_INVOCATION = /\brm\b(?<args>[^;&|\n]*)/gi;
const RECURSIVE_METADATA_INVOCATION = /\b(?:chmod|chown)\b(?<args>[^;&|\n]*)/gi;
const GIT_INVOCATION = /\bgit\b(?<args>[^;&|\n]*)/gi;
const NPM_INVOCATION = /\bnpm\b(?<args>[^;&|\n]*)/gi;
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

function skipWrapperOptions(tokens, start, optionsWithValue) {
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "--") return i + 1;
    if (isAssignment(token)) {
      i += 1;
      continue;
    }
    if (!token.startsWith("-")) return i;

    const option = optionName(token);
    i += 1;
    if (optionsWithValue.has(option) && !token.includes("=")) i += 1;
  }
  return i;
}

function pipelineTargetInvokesShell(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const name = commandName(tokens[i]);
    if (PIPELINE_SHELLS.has(name)) return true;
    if (name === "sudo") {
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
    if (pipelineTargetInvokesShell(shellWords(match.groups?.target || ""))) return true;
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

const MITIGATION_WORDS = /\b(mitigat\w*|rollback|recover\w*|backup|dry[- ]?run|scop(?:e|ed|ing)|limit(?:ed|ing)?|verif(?:y|ies|ied|ying|ication)|test(?:ed|ing|s)?|confirm(?:ed|ing|s)?|non[- ]?destructive|no irreversible)\b/i;
const NEGATED_MITIGATION_WORDS = /\b(?:no|not|never|without|lack(?:s|ing)?|missing|cannot|can't|won't|doesn['’]t|don't|isn['’]t|aren['’]t)\b(?:[\s,.;:-]+\w+){0,3}?[\s,.;:-]+(?:mitigat\w*|rollback|recover\w*|backup|dry[- ]?run|scop(?:e|ed|ing)|limit(?:ed|ing)?|verif(?:y|ies|ied|ying|ication)|test(?:ed|ing|s)?|confirm(?:ed|ing|s)?|non[- ]?destructive)\b/gi;

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
    hasRemoteInstallerPipeline(commandText) ||
    HIGH_IMPACT_SHELL_PATTERNS.some((re) => re.test(commandText))
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
