// Shared wall-clock deadline and AbortSignal helpers for headless runs.

export class DeadlineExceededError extends Error {
  constructor(message = "LazyGLM run timed out") {
    super(message);
    this.name = "DeadlineExceededError";
    this.code = "LAZYGLM_TIMEOUT";
  }
}

export class RequestTimeoutError extends Error {
  constructor(message = "GLM request timed out") {
    super(message);
    this.name = "RequestTimeoutError";
    this.code = "LAZYGLM_REQUEST_TIMEOUT";
  }
}

export function isDeadlineError(err) {
  return err?.code === "LAZYGLM_TIMEOUT" || err?.name === "DeadlineExceededError";
}

export function isRequestTimeoutError(err) {
  return err?.code === "LAZYGLM_REQUEST_TIMEOUT" || err?.name === "RequestTimeoutError";
}

export function abortReason(signal, fallback = new Error("Operation aborted")) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (reason) return new Error(String(reason));
  return fallback;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

export function composeAbortSignals(signals = []) {
  const active = signals.filter(Boolean);
  if (!active.length) return { signal: undefined, cancel() {} };

  const controller = new AbortController();
  const listeners = [];
  const abortFrom = (signal) => {
    if (!controller.signal.aborted) controller.abort(abortReason(signal));
  };

  for (const signal of active) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const listener = () => abortFrom(signal);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push([signal, listener]);
  }

  return {
    signal: controller.signal,
    cancel() {
      for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    },
  };
}

export function createDeadline(timeoutMs, { signal, message } = {}) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) {
    const composed = composeAbortSignals([signal]);
    return {
      signal: composed.signal,
      deadlineAt: null,
      timeoutMs: 0,
      disabled: true,
      remainingMs() { return Infinity; },
      throwIfExpired() { throwIfAborted(composed.signal); },
      cancel() { composed.cancel(); },
    };
  }

  const deadlineAt = Date.now() + ms;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DeadlineExceededError(message || `LazyGLM run timed out after ${formatDuration(ms)}.`));
  }, ms);
  timer.unref?.();
  const composed = composeAbortSignals([signal, controller.signal]);

  return {
    signal: composed.signal,
    deadlineAt,
    timeoutMs: ms,
    disabled: false,
    remainingMs() {
      if (composed.signal?.aborted) return 0;
      return Math.max(0, deadlineAt - Date.now());
    },
    throwIfExpired() {
      if (composed.signal?.aborted) throw abortReason(composed.signal);
      if (Date.now() >= deadlineAt) {
        controller.abort(new DeadlineExceededError(message || `LazyGLM run timed out after ${formatDuration(ms)}.`));
        throw abortReason(composed.signal);
      }
    },
    cancel() {
      clearTimeout(timer);
      composed.cancel();
    },
  };
}

export function boundedTimeoutMs(preferredMs, deadline) {
  const preferred = Number(preferredMs);
  const remaining = deadline?.remainingMs?.() ?? Infinity;
  if (!Number.isFinite(remaining)) return preferred;
  if (!Number.isFinite(preferred) || preferred <= 0) return Math.max(1, remaining);
  return Math.max(1, Math.min(preferred, remaining));
}

export function abortableSleep(ms, signal) {
  const delay = Math.max(0, Number(ms) || 0);
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delay);
    const onAbort = () => done(abortReason(signal));
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    function done(err) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve();
    }
  });
}

export function withAbort(promise, signal) {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolve(value); },
      (err) => { cleanup(); reject(err); },
    );
  });
}

export function requestTimeoutError(timeoutMs) {
  return new RequestTimeoutError(`GLM request timed out after ${timeoutMs}ms.`);
}

function formatDuration(ms) {
  const seconds = ms / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}s`;
}
