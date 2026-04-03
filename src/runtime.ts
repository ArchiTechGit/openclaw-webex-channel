type RuntimeLogMethod = (...args: unknown[]) => void;

type RuntimeLogger = {
  info?: RuntimeLogMethod;
  debug?: RuntimeLogMethod;
  error?: RuntimeLogMethod;
};

export type WebexInboundEvent = {
  text: string;
  roomId: string;
  personId?: string;
  personEmail?: string;
  messageId?: string;
  raw?: unknown;
};

export type WebexRuntime = {
  log?: RuntimeLogger;
  onInboundMessage?: (event: WebexInboundEvent) => Promise<void> | void;
};

let runtime: WebexRuntime = {};

export function webexLogInfo(msg: string, data?: unknown): void {
  dispatchLog("info", msg, data);
}

export function webexLogDebug(msg: string, data?: unknown): void {
  dispatchLog("debug", msg, data);
}

export function webexLogError(msg: string, data?: unknown): void {
  dispatchLog("error", msg, data);
}

export function setWebexRuntime(next: WebexRuntime | unknown): void {
  const normalized = normalizeRuntime(next);
  runtime = {
    ...runtime,
    ...normalized,
    log: normalized.log ?? runtime.log,
    onInboundMessage: normalized.onInboundMessage ?? runtime.onInboundMessage,
  };

  dispatchLog("debug", "webex runtime updated", {
    hasLogger: Boolean(runtime.log),
    hasInboundHandler: typeof runtime.onInboundMessage === "function",
  });
}

export function getWebexRuntime(): WebexRuntime {
  return runtime;
}

function normalizeRuntime(next: unknown): WebexRuntime {
  const source = (next && typeof next === "object" ? (next as Record<string, unknown>) : {}) ?? {};
  const sourceRuntime =
    source.runtime && typeof source.runtime === "object"
      ? (source.runtime as Record<string, unknown>)
      : undefined;

  const onInboundMessage =
    pickFunction(source, ["onInboundMessage", "emitInboundMessage", "pushInboundMessage"]) ??
    (sourceRuntime
      ? pickFunction(sourceRuntime, ["onInboundMessage", "emitInboundMessage", "pushInboundMessage"])
      : undefined);

  const log =
    normalizeLogger(source.log) ??
    normalizeLogger(source.logger) ??
    (sourceRuntime
      ? normalizeLogger(sourceRuntime.log) ?? normalizeLogger(sourceRuntime.logger)
      : undefined);

  return {
    log,
    onInboundMessage,
  };
}

function normalizeLogger(candidate: unknown): RuntimeLogger | undefined {
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  const logger = candidate as Record<string, unknown>;
  const info = pickFunction(logger, ["info", "log"]);
  const debug = pickFunction(logger, ["debug", "trace", "verbose", "info", "log"]);
  const error = pickFunction(logger, ["error", "fatal", "info", "log"]);

  if (!info && !debug && !error) {
    return undefined;
  }

  return { info, debug, error };
}

function pickFunction(source: Record<string, unknown>, names: string[]): RuntimeLogMethod | undefined {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "function") {
      return value as RuntimeLogMethod;
    }
  }
  return undefined;
}

function dispatchLog(level: "info" | "debug" | "error", msg: string, data?: unknown): void {
  const logger = runtime.log;
  const method = logger?.[level] ?? (level === "debug" ? logger?.info : undefined);
  if (method) {
    invokeLoggerMethod(method, msg, data);
    return;
  }

  const consoleMethod =
    level === "error"
      ? console.error
      : level === "debug"
        ? console.debug
        : console.info;

  if (data === undefined) {
    consoleMethod(`[webex] ${msg}`);
  } else {
    consoleMethod(`[webex] ${msg}`, data);
  }
}

function invokeLoggerMethod(method: RuntimeLogMethod, msg: string, data?: unknown): void {
  if (data === undefined) {
    method(msg);
    return;
  }

  try {
    method(msg, data);
    return;
  } catch {
    // Some structured loggers prefer (object, message) over (message, object).
  }

  if (data && typeof data === "object" && !Array.isArray(data)) {
    method(data, msg);
    return;
  }

  method({ data }, msg);
}
