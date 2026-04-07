import type { Express } from "express";
import { createRequire } from "node:module";
import { dispatchInboundToAgent, type WebexInboundEvent, webexLogDebug, webexLogError, webexLogInfo } from "./runtime.js";

const require = createRequire(import.meta.url);

function ensureNavigatorWritableForLegacyDeps(): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  if (!descriptor) {
    return;
  }

  // Some legacy Webex transitive dependencies assign to globalThis.navigator.
  // Newer Node versions expose navigator via a getter-only property.
  const isGetterOnly = typeof descriptor.get === "function" && descriptor.set === undefined;
  if (!isGetterOnly || descriptor.configurable !== true) {
    return;
  }

  const current = descriptor.get?.call(globalThis);
  Object.defineProperty(globalThis, "navigator", {
    value: current,
    writable: true,
    configurable: true,
    enumerable: descriptor.enumerable ?? true,
  });
}

type FrameworkLike = {
  email?: string;
  start: () => Promise<boolean> | boolean;
  stop: () => Promise<boolean> | boolean;
  on: (eventName: string, cb: (...args: any[]) => void) => void;
  hears?: (matcher: string | RegExp, cb: (...args: any[]) => void) => void;
  getBotByRoomId: (roomId: string) => { say: (message: string | Record<string, unknown>) => Promise<unknown> } | null;
  getWebexSDK: () => {
    messages: {
      create: (payload: Record<string, unknown>) => Promise<unknown>;
      remove?: (messageId: string) => Promise<unknown>;
      delete?: (messageId: string) => Promise<unknown>;
    };
  };
};

export type WebexFrameworkConfig = {
  token: string;
  webhookUrl: string;
};

type AttachHandlersOpts = {
  cfg: unknown;
  send: (roomId: string, text: string) => Promise<void>;
};

export type WebexFrameworkRuntime = {
  framework: FrameworkLike;
  webhookMiddleware: (req: unknown, res: unknown, next?: (err?: unknown) => void) => void;
  attachInboundHandlers: (opts: AttachHandlersOpts) => void;
};

export function createWebexFrameworkRuntime(config: WebexFrameworkConfig): WebexFrameworkRuntime {
  webexLogInfo("webex framework init starting", {
    webhookHost: safeWebhookHost(config.webhookUrl),
    hasToken: Boolean(config.token?.trim()),
  });
  ensureNavigatorWritableForLegacyDeps();
  const FrameworkCtor = require("webex-node-bot-framework");
  const webhookFactory = require("webex-node-bot-framework/webhook");

  const framework = new FrameworkCtor({
    token: config.token,
    webhookUrl: config.webhookUrl,
    // Prevent startup discovery from spawning bot objects in existing/default rooms.
    maxStartupSpaces: 0,
  }) as FrameworkLike;

  framework.on("log", (msg: unknown) => {
    webexLogDebug("webex framework log", { msg: String(msg ?? "") });
  });
  framework.on("start", () => {
    webexLogInfo("webex framework start event");
  });
  framework.on("initialized", () => {
    webexLogInfo("webex framework initialized event");
  });
  framework.on("stop", () => {
    webexLogInfo("webex framework stop event");
  });
  framework.on("spawn", (_bot: unknown, id: unknown, addedBy: unknown) => {
    webexLogDebug("webex framework spawn event", {
      id: String(id ?? ""),
      hasAddedBy: Boolean(addedBy),
    });
  });

  const webhookMiddleware = webhookFactory(framework) as WebexFrameworkRuntime["webhookMiddleware"];

  const attachInboundHandlers = (opts: AttachHandlersOpts) => {
    if (typeof framework.hears === "function") {
      framework.hears(/[\s\S]*/, () => {
        // Keep this empty catch-all so the framework does not emit "No Hears Called" noise.
      });
      webexLogDebug("webex framework hears catch-all registered");
    }

    framework.on("message", (_bot: unknown, trigger: any) => {
      const botEmail = framework.email?.toLowerCase().trim();
      const senderEmail = String(trigger?.person?.emails?.[0] ?? trigger?.personEmail ?? "").toLowerCase().trim();

      if (botEmail && senderEmail && botEmail === senderEmail) {
        webexLogDebug("webex inbound ignored bot-authored message", { senderEmail });
        return;
      }

      const text = String(trigger?.message?.text ?? "").trim();
      const roomId = String(trigger?.message?.roomId ?? "").trim();
      if (!text || !roomId) {
        webexLogDebug("webex inbound ignored: missing text or roomId", {
          hasText: Boolean(text),
          hasRoomId: Boolean(roomId),
        });
        return;
      }

      webexLogDebug("webex inbound received", {
        roomId,
        messageId: typeof trigger?.message?.id === "string" ? trigger.message.id : undefined,
        senderEmail,
        textLength: text.length,
        textPreview: truncate(text, 280),
      });

      const event: WebexInboundEvent = {
        text,
        roomId,
        personId: typeof trigger?.personId === "string" ? trigger.personId : undefined,
        personEmail: senderEmail || undefined,
        messageId: typeof trigger?.message?.id === "string" ? trigger.message.id : undefined,
        raw: trigger,
      };

      void (async () => {
        const thinking = await sendThinkingMessage(framework, event.roomId);
        let replied = false;

        const clearThinking = async () => {
          if (!thinking?.id) {
            return;
          }
          await deleteThinkingMessage(framework, thinking.id, event.roomId);
        };

        try {
          await dispatchInboundToAgent(event, opts.cfg, async (replyText) => {
            if (!replied) {
              replied = true;
              await clearThinking();
            }
            await opts.send(event.roomId, replyText);
          });

          if (!replied) {
            await clearThinking();
            await sendNoResponseWarning(framework, event.roomId);
          }
        } catch (err) {
          await clearThinking();
          await sendNoResponseWarning(framework, event.roomId);
          webexLogError("webex inbound dispatch failed", { error: String(err) });
        }
      })();
    });
  };

  return {
    framework,
    webhookMiddleware,
    attachInboundHandlers,
  };
}

export async function sendFrameworkMessage(
  framework: FrameworkLike,
  to: string,
  text: string,
): Promise<void> {
  webexLogDebug("webex outbound dispatch begin", {
    target: to,
    textLength: text.length,
  });
  const bot = framework.getBotByRoomId(to);
  const messagePayload = createWebexAdaptiveMessage(text);
  if (bot) {
    const callMeta = {
      api: "bot.say",
      target: to,
      textLength: text.length,
      textPreview: truncate(text, 280),
    };
    await retryWebexApiCall(callMeta, () => bot.say(messagePayload));
    webexLogInfo("webex outbound sent via bot room context", { target: to });
    return;
  }

  const sdk = framework.getWebexSDK();
  if (to.startsWith("person:")) {
    const payload = { toPersonId: to.slice("person:".length), ...messagePayload };
    const callMeta = {
      api: "messages.create",
      mode: "direct",
      target: payload.toPersonId,
      textLength: text.length,
      textPreview: truncate(text, 280),
    };
    await retryWebexApiCall(callMeta, () => sdk.messages.create(payload));
    webexLogInfo("webex outbound sent via direct person target", { target: to });
    return;
  }

  const payload = { roomId: to, ...messagePayload };
  const callMeta = {
    api: "messages.create",
    mode: "room",
    target: payload.roomId,
    textLength: text.length,
    textPreview: truncate(text, 280),
  };
  await retryWebexApiCall(callMeta, () => sdk.messages.create(payload));
  webexLogInfo("webex outbound sent via room target", { target: to });
}

export function bindFrameworkWebhook(app: Express, path: string, middleware: WebexFrameworkRuntime["webhookMiddleware"]): void {
  webexLogDebug("webex webhook route bound", { path });
  app.post(path, (req, res, next) => middleware(req, res, next));
}

function safeWebhookHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return "invalid";
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}

type ThinkingMessage = {
  id?: string;
};

async function sendThinkingMessage(framework: FrameworkLike, roomId: string): Promise<ThinkingMessage | null> {
  const sdk = framework.getWebexSDK();
  const payload = { roomId, ...createWebexAdaptiveMessage("Thinking...") };

  try {
    const result = await retryWebexApiCall(
      { api: "messages.create", mode: "thinking", target: roomId },
      () => sdk.messages.create(payload),
    );
    const record = result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
    const id = typeof record?.id === "string" ? record.id : undefined;
    return { id };
  } catch (err) {
    webexLogDebug("webex thinking message skipped", {
      roomId,
      error: formatErrorForLog(err),
    });
    return null;
  }
}

async function deleteThinkingMessage(framework: FrameworkLike, messageId: string, roomId: string): Promise<void> {
  const sdk = framework.getWebexSDK();
  const removeMessage =
    typeof sdk.messages.remove === "function"
      ? sdk.messages.remove.bind(sdk.messages)
      : typeof sdk.messages.delete === "function"
        ? sdk.messages.delete.bind(sdk.messages)
        : undefined;

  if (!removeMessage) {
    webexLogDebug("webex thinking message delete unavailable", { roomId, messageId });
    return;
  }

  try {
    await retryWebexApiCall(
      { api: "messages.remove", mode: "thinking", target: roomId },
      () => removeMessage(messageId),
    );
  } catch (err) {
    webexLogDebug("webex thinking message delete failed", {
      roomId,
      messageId,
      error: formatErrorForLog(err),
    });
  }
}

async function sendNoResponseWarning(framework: FrameworkLike, roomId: string): Promise<void> {
  const sdk = framework.getWebexSDK();
  const payload = {
    roomId,
    ...createWebexAdaptiveMessage("I couldn't generate a response right now. Please try again."),
  };

  try {
    await retryWebexApiCall(
      { api: "messages.create", mode: "warning", target: roomId },
      () => sdk.messages.create(payload),
    );
  } catch (err) {
    webexLogError("webex warning message failed", {
      roomId,
      error: formatErrorForLog(err),
    });
  }
}

type WebexApiCallMeta = {
  api: string;
  mode?: string;
  target: string;
  textLength?: number;
  textPreview?: string;
};

async function retryWebexApiCall<T>(
  meta: WebexApiCallMeta,
  operation: () => Promise<T>,
): Promise<T> {
  const maxAttempts = 4;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    webexLogInfo("webex api call begin", {
      ...meta,
      attempt,
      maxAttempts,
    });

    try {
      const result = await operation();
      webexLogInfo("webex api call success", {
        api: meta.api,
        mode: meta.mode,
        target: meta.target,
        attempt,
      });
      return result;
    } catch (err) {
      lastError = err;
      const retriable = isRetriableWebexError(err);
      const isLastAttempt = attempt >= maxAttempts;

      webexLogError("webex api call failed", {
        api: meta.api,
        mode: meta.mode,
        target: meta.target,
        attempt,
        maxAttempts,
        retriable,
        error: formatErrorForLog(err),
      });

      if (!retriable || isLastAttempt) {
        throw err;
      }

      const delayMs = getRetryDelayMs(attempt);
      webexLogInfo("webex api call retry scheduled", {
        api: meta.api,
        mode: meta.mode,
        target: meta.target,
        nextAttempt: attempt + 1,
        delayMs,
      });
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Unknown Webex API error"));
}

function isRetriableWebexError(err: unknown): boolean {
  const details = extractErrorDetails(err);
  if (details.statusCode !== undefined) {
    if (details.statusCode === 429 || details.statusCode >= 500) {
      return true;
    }
    return false;
  }

  const haystack = [details.message, details.code, details.causeMessage]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();

  return [
    "networkorcorserror",
    "socket hang up",
    "tunneling socket could not be established",
    "econnreset",
    "etimedout",
    "econnrefused",
    "timeout",
    "temporarily unavailable",
    "fetch failed",
    "network error",
  ].some((needle) => haystack.includes(needle));
}

function extractErrorDetails(err: unknown): {
  message?: string;
  code?: string;
  causeMessage?: string;
  statusCode?: number;
} {
  if (!err || typeof err !== "object") {
    return { message: String(err ?? "") };
  }

  const record = err as Record<string, unknown>;
  const cause = record.cause && typeof record.cause === "object" ? (record.cause as Record<string, unknown>) : undefined;
  const response = record.response && typeof record.response === "object" ? (record.response as Record<string, unknown>) : undefined;

  return {
    message: typeof record.message === "string" ? record.message : String(err),
    code: typeof record.code === "string" ? record.code : undefined,
    causeMessage: typeof cause?.message === "string" ? cause.message : undefined,
    statusCode:
      typeof record.statusCode === "number"
        ? record.statusCode
        : typeof record.status === "number"
          ? record.status
          : typeof response?.statusCode === "number"
            ? response.statusCode
            : typeof response?.status === "number"
              ? response.status
              : undefined,
  };
}

function formatErrorForLog(err: unknown): string {
  const details = extractErrorDetails(err);
  return [details.message, details.code, details.causeMessage].filter(Boolean).join(" | ");
}

type AdaptiveCardAttachment = {
  contentType: "application/vnd.microsoft.card.adaptive";
  content: Record<string, unknown>;
};

function createWebexAdaptiveMessage(text: string): {
  markdown: string;
  attachments?: AdaptiveCardAttachment[];
} {
  if (!hasMarkdownSyntax(text)) {
    return { markdown: text };
  }

  return {
    markdown: text,
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: createAdaptiveCardFromText(text),
      },
    ],
  };
}

function hasMarkdownSyntax(text: string): boolean {
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (/^#{1,6}\s+/.test(trimmed)) return true;
    if (/^\s*([-*+])\s+/.test(line)) return true;
    if (/^\s*\d+\.\s+/.test(line)) return true;
    if (/^\s*>\s?/.test(line)) return true;
    if (/^\s*([-*_]){3,}\s*$/.test(trimmed)) return true;
    if (/^```/.test(trimmed)) return true;
    if (/`[^`]+`/.test(line)) return true;
    if (/\[[^\]]+\]\([^\)]+\)/.test(line)) return true;
    if (/\*\*[^*]+\*\*/.test(line) || /_[^_]+_/.test(line) || /\*[^*]+\*/.test(line)) return true;

    if (
      looksLikeMarkdownTableRow(trimmed) &&
      i + 1 < lines.length &&
      isMarkdownTableSeparator(lines[i + 1] ?? "")
    ) {
      return true;
    }
  }

  return false;
}

function createAdaptiveCardFromText(text: string): Record<string, unknown> {
  const body = buildAdaptiveCardBody(text);
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.3",
    body: body.length > 0 ? body : [createTextBlock(" ")],
  };
}

function buildAdaptiveCardBody(text: string): Record<string, unknown>[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const body: Record<string, unknown>[] = [];
  let paragraph: string[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }
    body.push(createTextBlock(paragraph.join("\n")));
    paragraph = [];
  };

  const flushCodeBlock = () => {
    if (codeLines.length === 0) {
      return;
    }
    body.push(createTextBlock(codeLines.join("\n"), { fontType: "Monospace", spacing: "Small" }));
    codeLines = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trimEnd();

    if (line.trim().startsWith("```")) {
      flushParagraph();
      if (inCodeBlock) {
        flushCodeBlock();
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    if (
      looksLikeMarkdownTableRow(line) &&
      i + 1 < lines.length &&
      isMarkdownTableSeparator(lines[i + 1] ?? "")
    ) {
      flushParagraph();

      const headers = parseMarkdownTableRow(line);
      const rows: string[][] = [];
      i += 1; // consume separator line

      while (i + 1 < lines.length && looksLikeMarkdownTableRow(lines[i + 1] ?? "")) {
        i += 1;
        const row = parseMarkdownTableRow(lines[i] ?? "");
        if (row.length > 0) {
          rows.push(row);
        }
      }

      body.push(...createMarkdownTableBlocks(headers, rows));
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      body.push(createHeadingBlock(heading[2], heading[1].length));
      continue;
    }

    const bullet = line.match(/^\s*([-*+])\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      body.push(createTextBlock(`• ${bullet[2]}`));
      continue;
    }

    const ordered = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      body.push(createTextBlock(`${ordered[1]}. ${ordered[2]}`));
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      body.push(createTextBlock(`❝ ${quote[1]}`, { isSubtle: true, spacing: "Small" }));
      continue;
    }

    if (/^\s*([-*_]){3,}\s*$/.test(line)) {
      flushParagraph();
      body.push({ type: "TextBlock", text: "────────", wrap: true, spacing: "Medium", isSubtle: true });
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  flushCodeBlock();

  return body;
}

function createHeadingBlock(text: string, level: number): Record<string, unknown> {
  if (level <= 1) {
    return createTextBlock(text, { weight: "Bolder", size: "Large" });
  }
  if (level === 2) {
    return createTextBlock(text, { weight: "Bolder", size: "Medium" });
  }
  return createTextBlock(text, { weight: "Bolder" });
}

function looksLikeMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && trimmed.replace(/\|/g, "").trim().length > 0;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = parseMarkdownTableRow(line);
  if (cells.length === 0) {
    return false;
  }
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }

  const withoutLeading = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutOuterPipes = withoutLeading.endsWith("|")
    ? withoutLeading.slice(0, -1)
    : withoutLeading;

  return withoutOuterPipes.split("|").map((cell) => cell.trim());
}

function createMarkdownTableBlocks(headers: string[], rows: string[][]): Record<string, unknown>[] {
  const columnCount = Math.max(
    headers.length,
    rows.reduce((max, row) => Math.max(max, row.length), 0),
    1,
  );

  const normalizeRow = (row: string[]): string[] => {
    const out = [...row];
    while (out.length < columnCount) {
      out.push("");
    }
    return out.slice(0, columnCount);
  };

  const blocks: Record<string, unknown>[] = [];
  blocks.push(createTableRowColumnSet(normalizeRow(headers), true));
  blocks.push({ type: "TextBlock", text: "────────", wrap: true, spacing: "Small", isSubtle: true });

  for (const row of rows) {
    blocks.push(createTableRowColumnSet(normalizeRow(row), false));
  }

  return blocks;
}

function createTableRowColumnSet(cells: string[], isHeader: boolean): Record<string, unknown> {
  return {
    type: "ColumnSet",
    spacing: "Small",
    columns: cells.map((cell) => ({
      type: "Column",
      width: "stretch",
      items: [
        createTextBlock(cell || " ", isHeader ? { weight: "Bolder" } : undefined),
      ],
    })),
  };
}

function createTextBlock(
  text: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "TextBlock",
    text,
    wrap: true,
    ...extra,
  };
}

function getRetryDelayMs(attempt: number): number {
  const baseMs = 750;
  const jitterMs = Math.floor(Math.random() * 250);
  return baseMs * 2 ** (attempt - 1) + jitterMs;
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
