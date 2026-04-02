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
  hears?: (
    phrase: string | RegExp,
    action: (bot: { say: (...args: any[]) => Promise<unknown> | unknown }, trigger: any, id?: string) =>
      Promise<unknown> | unknown,
    helpText?: string,
    preference?: number,
  ) => string;
  getBotByRoomId: (roomId: string) => { say: (message: string | Record<string, unknown>) => Promise<unknown> } | null;
  getWebexSDK: () => {
    messages: {
      create: (payload: Record<string, unknown>) => Promise<unknown>;
    };
    webhooks: {
      list: () => Promise<{ items?: Array<Record<string, unknown>> }>;
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
    // Prevent startup discovery from spawning bot objects in existing/default rooms.
    maxStartupSpaces: 0,
  }) as FrameworkLike;

  const webhookMiddleware = webhookFactory(framework) as WebexFrameworkRuntime["webhookMiddleware"];

  const attachInboundHandlers = () => {
    registerSlashCommands(framework);

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

function registerSlashCommands(framework: FrameworkLike): void {
  if (typeof framework.hears !== "function") {
    return;
  }

  framework.hears(
    /^\/webex-listwebhooks(?:\s+.*)?$/i,
    async (bot) => {
      try {
        const response = await framework.getWebexSDK().webhooks.list();
        const items = Array.isArray(response?.items) ? response.items : [];
        const preview = items.slice(0, 20).map((entry) => ({
          id: entry.id,
          resource: entry.resource,
          event: entry.event,
          targetUrl: entry.targetUrl,
          name: entry.name,
        }));

        const payload = {
          count: items.length,
          returned: preview.length,
          truncated: items.length > preview.length,
          items: preview,
        };

        await bot.say("markdown", `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``);
      } catch (err) {
        await bot.say("markdown", `webex-listwebhooks failed: ${String(err)}`);
      }
    },
    "**/webex-listwebhooks** - List Webex webhooks for this bot token",
    0,
  );
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
