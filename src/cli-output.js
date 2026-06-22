import { truncate } from "./util.js";

const GRAY = "\x1b[90m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

export function createRunEventPrinter({ stdout = process.stdout, stderr = process.stderr, isTTY = stdout?.isTTY === true } = {}) {
  const tty = isTTY === true;
  let streamOpen = false;
  let streamMode = null; // "text" | "reasoning"
  let streamedText = false; // suppresses the assistant_text echo when deltas already showed it

  const ansi = (code) => (tty ? code : "");
  const writeOut = (text) => stdout.write(String(text));
  const writeErr = (text) => stderr.write(String(text));
  const lineOut = (text = "") => writeOut(`${text}\n`);
  const lineErr = (text = "") => writeErr(`${text}\n`);

  function closeStream() {
    if (streamOpen) {
      writeOut(`${ansi(RESET)}\n`);
      streamOpen = false;
      streamMode = null;
    }
  }

  function printEvent(ev) {
    switch (ev.type) {
      case "start":
        lineOut(`\n🚀 LazyGLM session ${ev.sessionId} | model: ${ev.model} | provider: ${ev.provider || "?"} | role: ${ev.role || "default"}`);
        lineOut(`   cwd: ${ev.cwd}`);
        lineOut(`   task: ${truncate(ev.task, 200)}\n`);
        break;
      case "reasoning_delta":
        // Reasoning streams first (GLM-5.2 thinks before answering). Show it dimmed
        // so the terminal isn't silent during long thinking — that silence is what
        // breaks trust in non-streaming agents.
        if (!streamOpen) {
          writeOut(`${ansi(GRAY)}✶ `);
          streamOpen = true;
          streamMode = "reasoning";
        } else if (streamMode !== "reasoning") {
          writeOut(`${ansi(RESET)}\n${ansi(GRAY)}✶ `);
          streamMode = "reasoning";
        }
        writeOut(ev.text);
        break;
      case "assistant_delta":
        if (streamOpen && streamMode === "reasoning") {
          writeOut(`${ansi(RESET)}\n`);
        }
        if (!streamOpen || streamMode !== "text") {
          writeOut("💬 ");
        }
        streamOpen = true;
        streamMode = "text";
        streamedText = true;
        writeOut(ev.text);
        break;
      case "assistant_text":
        // Close any open stream line first.
        if (streamedText) {
          closeStream();
          streamedText = false;
        } else {
          closeStream();
          if (ev.content?.trim()) lineOut(`💬 ${truncate(ev.content, 1200)}`);
        }
        break;
      case "tool_call_start":
        closeStream();
        break;
      case "tool_call": {
        closeStream();
        const arg = ev.input ? truncate(ev.input, 160) : "";
        lineOut(`🔧 ${ev.name}(${arg}) [turn ${ev.turn}]`);
        break;
      }
      case "tool_result":
        lineOut(`   ↳ ${truncate(ev.result, 400)}`);
        break;
      case "blocked":
        lineOut(`⛔ blocked ${ev.tool}: ${ev.reasons.join("; ")}`);
        break;
      case "retry":
        closeStream();
        lineOut(`${ansi(YELLOW)}   ⏳ retry ${ev.attempt}: ${ev.reason} (waiting ${ev.delay}ms)${ansi(RESET)}`);
        break;
      case "reasoning_budget_exceeded":
        closeStream();
        lineOut(`${ansi(YELLOW)}   🧠 reasoning budget exceeded: ${ev.used}/${ev.budget} tokens — stopping${ansi(RESET)}`);
        break;
      case "usage": {
        // Surface reasoning-token spend — the GLM-native cost signal. Only print
        // when reasoning tokens are non-zero to avoid noise on non-reasoning tiers.
        const cum = ev.cumulative || {};
        const turnReasoning = ev.usage?.completion_tokens_details?.reasoning_tokens || ev.usage?.reasoning_tokens || 0;
        if (turnReasoning > 0 || cum.reasoning > 0) {
          lineOut(`${ansi(GRAY)}   🧠 reasoning: +${turnReasoning} (cum ${cum.reasoning || 0}) | tokens in/out: ${cum.prompt || 0}/${cum.completion || 0}${ansi(RESET)}`);
        }
        break;
      }
      case "finish":
        closeStream();
        lineOut(`\n✅ FINISH: ${truncate(ev.summary, 1500)}\n`);
        break;
      case "compact":
        lineOut(`   (context compacted — #${ev.compactionCount})`);
        break;
      case "ultrawork_iteration":
        closeStream();
        lineOut(`\n🔁 ULTRAWORK iteration ${ev.iteration}/${ev.max}`);
        break;
      case "ultrawork_verify":
        lineOut(`   verify: ${ev.pass ? "PASS ✅" : "FAIL ❌"} — ${truncate(ev.reason, 300)}`);
        break;
      case "error":
        closeStream();
        lineErr(`❌ error: ${ev.message}`);
        break;
      default:
        break;
    }
  }

  return printEvent;
}
