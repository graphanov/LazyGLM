// comment-checker — PostToolUse hook on write_file/patch_file. Scans edited
// files for AI-slop comments (placeholder TODOs, restate-the-code narration,
// "let's/we will/as an AI" mannerisms) and blocks with feedback so the GLM
// model cleans them up. Clean-room rewrite of the OMO comment-checker.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { resolvePath, truncate } from "../util.js";

const EDIT_TOOLS = new Set(["write_file", "patch_file"]);

// Heuristic slop detectors. Conservative: only flag clearly AI-generated noise.
const SLOP_PATTERNS = [
  { re: /\/\/\s*(todo|fixme)\b[^]*\b(implement|placeholder|your code|add code|insert code|fill in|complete this)\b/i, msg: "placeholder TODO — implement it or remove the comment" },
  { re: /\/\/\s*(add your code here|your code here|insert your code|placeholder code|implementation goes here|rest of the code goes here)/i, msg: "placeholder comment — remove it and ship real code" },
  { re: /\/\/\s*(in this (function|block),? we (will|are going to|first|then)|let's|let us|as an ai|as a language model)/i, msg: "AI-narration comment — describe intent only, drop the 'we will/let's' voice" },
  { re: /\/\/\s*(here we|now we|this is where we|at this point we)\s+(are|will|can|just)\b/i, msg: "narrating-the-process comment — remove unless it carries real intent" },
  { re: /\/\*\*\s*@(author|generatedby)\s*(ai|chatgpt|copilot|claude|glm)\b/i, msg: "AI authorship tag — remove" },
  { re: /\/\/\s*[a-z ]{0,30}\b(magic happens here|rest is up to you|enjoy!|happy coding)\b/i, msg: "fluff comment — remove" },
  { re: /^\s*#\s*(in this (function|block),? we (will|are going to)|let's|as an ai)\b/i, msg: "AI-narration comment (py) — remove" },
];

// Words that carry no real intent — ignored when deciding if a comment merely
// restates the code below it.
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "to", "of",
  "in", "on", "for", "with", "and", "or", "but", "set", "get", "now", "then", "here",
  "we", "will", "this", "that", "it", "as", "at", "by", "from", "up", "out", "if",
  "so", "do", "does", "did", "just", "into", "before", "after", "new", "var", "let",
  "const", "our", "your", "its",
]);

// Detect a comment that merely restates the next non-comment code line.
function restateComment(lines) {
  const hits = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const m = line.match(/^\s*\/\/\s*(.+?)\s*$/);
    if (!m) continue;
    const commentWords = m[1]
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w));
    if (commentWords.length < 2) continue;
    // find next non-empty, non-comment, non-brace line
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j].trim();
      if (!next || next.startsWith("//") || next === "{" || next === "}" || next.startsWith("*")) {
        j++;
        continue;
      }
      break;
    }
    if (j >= lines.length) continue;
    const codeLine = lines[j].toLowerCase().replace(/[^a-z0-9 ]/g, " ");
    // restate = every content word of the comment appears in the code line
    if (commentWords.every((w) => codeLine.includes(w))) {
      hits.push({ line: i + 1, comment: m[1], code: lines[j].trim() });
    }
  }
  return hits;
}

function scan(text) {
  const findings = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { re, msg } of SLOP_PATTERNS) {
      if (re.test(line)) {
        findings.push({ line: i + 1, text: line.trim(), msg });
        break;
      }
    }
  }
  for (const h of restateComment(lines).slice(0, 3)) {
    findings.push({ line: h.line, text: `// ${h.comment}`, msg: `restates the code on the next line ('${truncate(h.code, 60)}') — remove redundant comment` });
  }
  return findings;
}

export default {
  name: "comment-checker",
  hooks: {
    async PostToolUse(input, api) {
      if (!EDIT_TOOLS.has(input.tool_name)) return undefined;
      const rel = input.tool_input?.path;
      if (!rel || typeof rel !== "string") return undefined;
      // only scan code files
      if (!/\.(js|mjs|ts|tsx|jsx|py|go|rs|java|c|cpp|h|rb|php|cs|swift|kt)$/i.test(rel)) return undefined;

      let abs;
      try {
        abs = resolvePath(rel, api.cwd);
      } catch {
        return undefined;
      }
      if (!existsSync(abs)) return undefined;

      let text;
      try {
        text = await readFile(abs, "utf8");
      } catch {
        return undefined;
      }

      const findings = scan(text);
      if (!findings.length) return undefined;

      const detail = findings
        .slice(0, 6)
        .map((f) => `  L${f.line}: ${f.text}\n    -> ${f.msg}`)
        .join("\n");
      return {
        decision: "block",
        reason: `comment-checker found ${findings.length} AI-slop comment(s) in ${rel}:\n${detail}\nFix these comments (implement placeholders, remove narration/restate comments) and continue.`,
      };
    },
  },
};
