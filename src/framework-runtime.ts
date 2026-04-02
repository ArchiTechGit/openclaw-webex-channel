import type { Express } from "express";
import { createRequire } from "node:module";
import { getWebexRuntime, type WebexInboundEvent } from "./runtime.js";

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

export type WebexFrameworkRuntime = {
  framework: FrameworkLike;
  webhookMiddleware: (req: unknown, res: unknown, next?: (err?: unknown) => void) => void;
  attachInboundHandlers: () => void;
};

export function createWebexFrameworkRuntime(config: WebexFrameworkConfig): WebexFrameworkRuntime {
  ensureNavigatorWritableForLegacyDeps();
  const FrameworkCtor = require("webex-node-bot-framework");
  const webhookFactory = require("webex-node-bot-framework/webhook");

  const framework = new FrameworkCtor({
    token: config.token,
    webhookUrl: config.webhookUrl,
  }) as FrameworkLike;

  const webhookMiddleware = webhookFactory(framework) as WebexFrameworkRuntime["webhookMiddleware"];

  const attachInboundHandlers = () => {
    framework.on("message", (_bot: unknown, trigger: any) => {
      const runtime = getWebexRuntime();
      const botEmail = framework.email?.toLowerCase().trim();
      const senderEmail = String(trigger?.person?.emails?.[0] ?? trigger?.personEmail ?? "").toLowerCase().trim();

      if (botEmail && senderEmail && botEmail === senderEmail) {
        return;
      }

      const text = String(trigger?.message?.text ?? "").trim();
      const roomId = String(trigger?.message?.roomId ?? "").trim();
      if (!text || !roomId) {
        runtime.log?.debug?.("webex inbound ignored: missing text or roomId");
        return;
      }

      const event: WebexInboundEvent = {
        text,
        roomId,
        personId: typeof trigger?.personId === "string" ? trigger.personId : undefined,
        personEmail: senderEmail || undefined,
        messageId: typeof trigger?.message?.id === "string" ? trigger.message.id : undefined,
        raw: trigger,
      };

      void Promise.resolve(runtime.onInboundMessage?.(event)).catch((err) => {
        runtime.log?.error?.("webex inbound dispatch failed", { error: String(err) });
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
  const bot = framework.getBotByRoomId(to);
  if (bot) {
    await bot.say(text);
    return;
  }

  const sdk = framework.getWebexSDK();
  if (to.startsWith("person:")) {
    await sdk.messages.create({ toPersonId: to.slice("person:".length), markdown: text });
    return;
  }

  await sdk.messages.create({ roomId: to, markdown: text });
}

export function bindFrameworkWebhook(app: Express, path: string, middleware: WebexFrameworkRuntime["webhookMiddleware"]): void {
  app.post(path, (req, res, next) => middleware(req, res, next));
}
