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

      void dispatchInboundToAgent(event, opts.cfg, (text) => opts.send(event.roomId, text)).catch((err) => {
        webexLogError("webex inbound dispatch failed", { error: String(err) });
      });
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
  if (bot) {
    webexLogInfo("webex api call begin", {
      api: "bot.say",
      target: to,
      textLength: text.length,
      textPreview: truncate(text, 280),
    });
    try {
      await bot.say(text);
      webexLogInfo("webex api call success", {
        api: "bot.say",
        target: to,
      });
    } catch (err) {
      webexLogError("webex api call failed", {
        api: "bot.say",
        target: to,
        error: String(err),
      });
      throw err;
    }
    webexLogInfo("webex outbound sent via bot room context", { target: to });
    return;
  }

  const sdk = framework.getWebexSDK();
  if (to.startsWith("person:")) {
    const payload = { toPersonId: to.slice("person:".length), markdown: text };
    webexLogInfo("webex api call begin", {
      api: "messages.create",
      mode: "direct",
      target: payload.toPersonId,
      textLength: text.length,
      textPreview: truncate(text, 280),
    });
    try {
      await sdk.messages.create(payload);
      webexLogInfo("webex api call success", {
        api: "messages.create",
        mode: "direct",
        target: payload.toPersonId,
      });
    } catch (err) {
      webexLogError("webex api call failed", {
        api: "messages.create",
        mode: "direct",
        target: payload.toPersonId,
        error: String(err),
      });
      throw err;
    }
    webexLogInfo("webex outbound sent via direct person target", { target: to });
    return;
  }

  const payload = { roomId: to, markdown: text };
  webexLogInfo("webex api call begin", {
    api: "messages.create",
    mode: "room",
    target: payload.roomId,
    textLength: text.length,
    textPreview: truncate(text, 280),
  });
  try {
    await sdk.messages.create(payload);
    webexLogInfo("webex api call success", {
      api: "messages.create",
      mode: "room",
      target: payload.roomId,
    });
  } catch (err) {
    webexLogError("webex api call failed", {
      api: "messages.create",
      mode: "room",
      target: payload.roomId,
      error: String(err),
    });
    throw err;
  }
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
