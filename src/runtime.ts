// ─── Minimal PluginRuntime types ─────────────────────────────────────────────
// Based on openclaw dist/plugin-sdk/plugins/runtime/types.d.ts (version 2026.x)

type PluginReplyDispatcher = {
  sendToolResult: (payload: { text?: string }) => boolean;
  sendBlockReply: (payload: { text?: string }) => boolean;
  sendFinalReply: (payload: { text?: string }) => boolean;
  waitForIdle: () => Promise<void>;
  getQueuedCounts: () => Record<string, number>;
  markComplete: () => void;
};

type PluginRuntime = {
  channel: {
    routing: {
      resolveAgentRoute: (input: {
        cfg: unknown;
        channel: string;
        accountId?: string | null;
        peer?: { kind: string; id: string } | null;
      }) => {
        agentId: string;
        channel: string;
        accountId: string;
        sessionKey: string;
        mainSessionKey: string;
      };
    };
    reply: {
      dispatchReplyFromConfig: (params: {
        ctx: Record<string, unknown>;
        cfg: unknown;
        dispatcher: PluginReplyDispatcher;
      }) => Promise<{ queuedFinal: boolean; counts: Record<string, number> }>;
      createReplyDispatcherWithTyping: (options: {
        deliver: (payload: { text?: string }) => Promise<void>;
        onIdle?: () => void;
      }) => { dispatcher: PluginReplyDispatcher; markDispatchIdle: () => void };
      finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => T & { CommandAuthorized: boolean };
      formatAgentEnvelope: (params: {
        channel: string;
        from: string;
        timestamp?: Date | null;
        previousTimestamp?: Date | null;
        envelope?: unknown;
        body: string;
      }) => string;
      resolveEnvelopeFormatOptions: (params: { cfg: unknown; sessionKey: string }) => unknown;
    };
    session: {
      resolveStorePath: (storePath: unknown, opts: { agentId: string }) => string;
      recordInboundSession: (params: {
        storePath: string;
        sessionKey: string;
        ctx: Record<string, unknown>;
        onRecordError?: (err: unknown) => void;
      }) => Promise<void>;
    };
  };
};

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

// Module-level state: separate logger and PluginRuntime for dispatch.
let logger: RuntimeLogger | undefined;
let pluginRuntime: PluginRuntime | undefined;

export function webexLogInfo(msg: string, data?: unknown): void {
  dispatchLog("info", msg, data);
}

export function webexLogDebug(msg: string, data?: unknown): void {
  dispatchLog("debug", msg, data);
}

export function webexLogError(msg: string, data?: unknown): void {
  dispatchLog("error", msg, data);
}

export function setWebexRuntime(next: unknown): void {
  const source = toRecord(next);
  const sourceRuntime = toRecord(source.runtime);

  const resolvedLogger =
    normalizeLogger(source.log) ??
    normalizeLogger(source.logger) ??
    normalizeLogger(sourceRuntime.log) ??
    normalizeLogger(sourceRuntime.logger);

  if (resolvedLogger) {
    logger = resolvedLogger;
  }

  const resolvedRuntime =
    detectPluginRuntime(source) ?? detectPluginRuntime(sourceRuntime);
  if (resolvedRuntime) {
    pluginRuntime = resolvedRuntime;
  }

  dispatchLog("debug", "webex runtime updated", {
    hasLogger: Boolean(logger),
    hasPluginRuntime: Boolean(pluginRuntime),
  });
}

export function getPluginRuntime(): PluginRuntime | undefined {
  return pluginRuntime;
}

// ─── Agent dispatch ───────────────────────────────────────────────────────────

export async function dispatchInboundToAgent(
  event: WebexInboundEvent,
  cfg: unknown,
  send: (text: string) => Promise<void>,
): Promise<void> {
  const core = pluginRuntime;
  if (!core) {
    webexLogError("webex dispatch skipped: PluginRuntime not initialized");
    return;
  }

  const peerId = event.personId ?? event.personEmail ?? event.roomId;
  const chatType = "direct";

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "webex",
    peer: { kind: chatType, id: peerId },
  });

  webexLogDebug("webex dispatch routing resolved", {
    sessionKey: route.sessionKey,
    agentId: route.agentId,
    accountId: route.accountId,
  });

  const timestamp = new Date();

  const envelope = core.channel.reply.formatAgentEnvelope({
    channel: "Webex",
    from: event.personEmail ?? event.personId ?? event.roomId,
    timestamp,
    previousTimestamp: null,
    body: event.text,
  });

  const rawCtx: Record<string, unknown> = {
    Body: envelope,
    BodyForAgent: event.text,
    RawBody: event.text,
    CommandBody: event.text,
    BodyForCommands: event.text,
    From: event.personEmail ? `webex:${event.personEmail}` : `webex:${event.roomId}`,
    To: event.roomId,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    ConversationLabel: event.personEmail ?? event.personId ?? event.roomId,
    SenderName: event.personEmail,
    SenderId: event.personId ?? event.personEmail,
    Provider: "webex",
    Surface: "webex",
    MessageSid: event.messageId,
    Timestamp: timestamp.getTime(),
    WasMentioned: true,
    OriginatingChannel: "webex",
    OriginatingTo: event.roomId,
  };

  const ctxPayload = core.channel.reply.finalizeInboundContext(rawCtx);

  try {
    const storePath = core.channel.session.resolveStorePath(
      (cfg as { session?: { store?: unknown } } | null)?.session?.store,
      { agentId: route.agentId },
    );
    await core.channel.session.recordInboundSession({
      storePath,
      sessionKey: route.sessionKey,
      ctx: ctxPayload,
      onRecordError: (err) => {
        webexLogDebug("webex session record failed (non-fatal)", { error: String(err) });
      },
    });
  } catch (err) {
    webexLogDebug("webex session record threw (non-fatal)", { error: String(err) });
  }

  const { dispatcher } = core.channel.reply.createReplyDispatcherWithTyping({
    deliver: async (payload) => {
      const text = payload.text ?? "";
      if (!text.trim()) return;
      webexLogDebug("webex dispatch delivering reply", { textLength: text.length });
      try {
        await send(text);
      } catch (err) {
        webexLogError("webex dispatch deliver failed", { error: String(err) });
        throw err;
      }
    },
  });

  webexLogInfo("webex dispatching to agent", {
    agentId: route.agentId,
    sessionKey: route.sessionKey,
    roomId: event.roomId,
  });

  const result = await core.channel.reply.dispatchReplyFromConfig({
    cfg,
    ctx: ctxPayload,
    dispatcher,
  });

  webexLogInfo("webex dispatch complete", {
    queuedFinal: result.queuedFinal,
    counts: result.counts,
  });
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

function detectPluginRuntime(source: Record<string, unknown>): PluginRuntime | undefined {
  const ch = toRecord(source.channel);
  const routing = toRecord(ch.routing);
  const reply = toRecord(ch.reply);
  if (
    typeof routing.resolveAgentRoute === "function" &&
    typeof reply.dispatchReplyFromConfig === "function"
  ) {
    return source as unknown as PluginRuntime;
  }
  return undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
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
  const log = logger;
  const method = log?.[level] ?? (level === "debug" ? log?.info : undefined);
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
