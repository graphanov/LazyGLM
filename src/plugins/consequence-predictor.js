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

const HIGH_IMPACT_SHELL_PATTERNS = [
  /\bgit\s+push\b/i,
  /\bgh\s+release\b/i,
  /\bnpm\s+publish\b/i,
  /\b(?:curl|wget)\b[^|\n]*\|\s*(?:(?:sudo|env|command)\b(?:\s+(?:-[^\s]+|[A-Za-z_][A-Za-z0-9_]*=[^\s]+))*\s+)*(?:\/(?:usr\/)?bin\/)?(?:sh|bash|zsh)\b/i,
  /\bchmod\s+-R\b/i,
  /\bchown\s+-R\b/i,
];

const RM_INVOCATION = /\brm\b(?<args>[^;&|\n]*)/gi;

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

const MITIGATION_WORDS = /\b(mitigat\w*|rollback|recover\w*|backup|dry[- ]?run|scop(?:e|ed|ing)|limit(?:ed|ing)?|verif(?:y|ies|ied|ying|ication)|test(?:ed|ing|s)?|confirm(?:ed|ing|s)?|non[- ]?destructive|no irreversible)\b/i;

function normalizePrediction(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value).trim();
  }
}

function isGenericPrediction(prediction) {
  const normalized = prediction.toLowerCase().replace(/[.!?]+$/g, "").trim();
  return prediction.length < MIN_PREDICTION_CHARS || GENERIC_PREDICTIONS.has(normalized);
}

function isHighImpactShell(command = "") {
  const commandText = String(command);
  return hasRecursiveForceRm(commandText) || HIGH_IMPACT_SHELL_PATTERNS.some((re) => re.test(commandText));
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
        !MITIGATION_WORDS.test(prediction)
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
