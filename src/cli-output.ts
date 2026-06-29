import { truncate } from "./util.js";
import type { Writable } from "node:stream";

const GRAY = "\x1b[90m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

type OutputStream = Pick<Writable, "write"> & { isTTY?: boolean };

type RunPrinterEvent = Record<string, unknown> & {
  type?: string;
  text?: string;
  content?: string | null;
  input?: string | null;
  result?: string | null;
  summary?: string | null;
  reason?: string | null;
  message?: string | null;
  reasons?: unknown[];
};

export interface RunEventPrinterOptions {
  stdout?: OutputStream;
  stderr?: OutputStream;
  isTTY?: boolean;
}

function textField(value: unknown): string {
  return value == null ? "" : String(value);
}

function numberField(value: unknown): number {
  return Number(value) || 0;
}

export function createRunEventPrinter({
  stdout = process.stdout,
  stderr = process.stderr,
  isTTY = stdout?.isTTY === true,
}: RunEventPrinterOptions = {}): (event: RunPrinterEvent) => void {
  const tty = isTTY === true;
  let streamOpen = false;
  let streamMode: "text" | "reasoning" | null = null;
  let streamedText = false; // suppresses the assistant_text echo when deltas already showed it

  const ansi = (code: string): string => (tty ? code : "");
  const writeOut = (text: unknown): boolean => stdout.write(String(text));
  const writeErr = (text: unknown): boolean => stderr.write(String(text));
  const lineOut = (text = ""): boolean => writeOut(`${text}\n`);
  const lineErr = (text = ""): boolean => writeErr(`${text}\n`);

  function closeStream(): void {
    if (streamOpen) {
      writeOut(`${ansi(RESET)}\n`);
      streamOpen = false;
      streamMode = null;
    }
  }

  function printEvent(ev: RunPrinterEvent): void {
    switch (ev.type) {
      case "start":
        lineOut(`\n🚀 LazyGLM session ${ev.sessionId} | model: ${ev.model} | provider: ${ev.provider || "?"} | role: ${ev.role || "default"}`);
        lineOut(`   cwd: ${ev.cwd}`);
        lineOut(`   task: ${truncate(textField(ev.task), 200)}\n`);
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
        writeOut(textField(ev.text));
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
        writeOut(textField(ev.text));
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
        lineOut(`   ↳ ${truncate(textField(ev.result), 400)}`);
        break;
      case "blocked":
        lineOut(`⛔ blocked ${ev.tool}: ${(Array.isArray(ev.reasons) ? ev.reasons : []).map(textField).join("; ")}`);
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
        const cum = ev.cumulative && typeof ev.cumulative === "object" ? ev.cumulative as Record<string, unknown> : {};
        const usage = ev.usage && typeof ev.usage === "object" ? ev.usage as Record<string, unknown> : {};
        const details = usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
          ? usage.completion_tokens_details as Record<string, unknown>
          : {};
        const turnReasoning = numberField(details.reasoning_tokens || usage.reasoning_tokens);
        const cumulativeReasoning = numberField(cum.reasoning);
        if (turnReasoning > 0 || cumulativeReasoning > 0) {
          lineOut(`${ansi(GRAY)}   🧠 reasoning: +${turnReasoning} (cum ${cumulativeReasoning}) | tokens in/out: ${numberField(cum.prompt)}/${numberField(cum.completion)}${ansi(RESET)}`);
        }
        break;
      }
      case "finish":
        closeStream();
        lineOut(`\n✅ FINISH: ${truncate(textField(ev.summary), 1500)}\n`);
        break;
      case "compact":
        lineOut(`   (context compacted — #${ev.compactionCount})`);
        break;
      case "ultrawork_iteration":
        closeStream();
        lineOut(`\n🔁 ULTRAWORK iteration ${ev.iteration}/${ev.max}`);
        break;
      case "ultrawork_verify":
        lineOut(`   verify: ${ev.pass ? "PASS ✅" : "FAIL ❌"} — ${truncate(textField(ev.reason), 300)}`);
        break;
      case "error":
        closeStream();
        lineErr(`❌ error: ${textField(ev.message)}`);
        break;
      default:
        break;
    }
  }

  return printEvent;
}
