import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunEventPrinter } from "../src/cli-output.js";

const ANSI_RE = /\x1b\[/;

function capturePrinter({ isTTY, stdoutIsTTY } = {}) {
  let stdoutText = "";
  let stderrText = "";
  const stdout = {
    isTTY: stdoutIsTTY,
    write(chunk) {
      stdoutText += String(chunk);
    },
  };
  const stderr = {
    write(chunk) {
      stderrText += String(chunk);
    },
  };
  const opts = { stdout, stderr };
  if (Object.hasOwn({ isTTY }, "isTTY")) opts.isTTY = isTTY;
  return {
    print: createRunEventPrinter(opts),
    get stdout() { return stdoutText; },
    get stderr() { return stderrText; },
  };
}

function emitReasoningRetryUsage(print) {
  print({ type: "reasoning_delta", text: "checking options" });
  print({ type: "retry", attempt: 2, reason: "rate limit", delay: 250 });
  print({
    type: "usage",
    usage: { completion_tokens_details: { reasoning_tokens: 7 } },
    cumulative: { prompt: 11, completion: 13, reasoning: 7 },
  });
}

test("non-TTY reasoning/retry/usage output contains no ANSI escapes", () => {
  const out = capturePrinter({ isTTY: false });
  emitReasoningRetryUsage(out.print);

  assert.doesNotMatch(out.stdout, ANSI_RE);
  assert.ok(out.stdout.includes("✶ checking options"));
  assert.ok(out.stdout.includes("⏳ retry 2: rate limit (waiting 250ms)"));
  assert.ok(out.stdout.includes("🧠 reasoning: +7 (cum 7) | tokens in/out: 11/13"));
});

test("only explicit isTTY:true enables colored reasoning/retry/usage output", () => {
  const out = capturePrinter({ stdoutIsTTY: undefined });
  emitReasoningRetryUsage(out.print);

  assert.doesNotMatch(out.stdout, ANSI_RE);
});

test("TTY reasoning/retry/usage output keeps ANSI color escapes", () => {
  const out = capturePrinter({ isTTY: true });
  emitReasoningRetryUsage(out.print);

  assert.match(out.stdout, ANSI_RE);
  assert.match(out.stdout, /\x1b\[90m✶ checking options/);
  assert.match(out.stdout, /\x1b\[33m   ⏳ retry 2: rate limit \(waiting 250ms\)\x1b\[0m/);
  assert.match(out.stdout, /\x1b\[90m   🧠 reasoning: \+7 \(cum 7\) \| tokens in\/out: 11\/13\x1b\[0m/);
});
