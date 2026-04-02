import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-contract";
import { WebexChannelConfigSchema, hasConfiguredWebexChannel, resolveWebexChannelConfig } from "./config-schema.js";
import { monitorWebexProvider } from "./monitor.js";
import { sendTextWebex } from "./outbound.js";
import { getWebexRuntime } from "./runtime.js";

type RuntimeState = {
  provider?: Awaited<ReturnType<typeof monitorWebexProvider>>;
};

const state: RuntimeState = {};

export const webexPlugin: ChannelPlugin<any, any> = createChatChannelPlugin({
  base: {
    id: "webex",
    meta: {
      id: "webex",
      label: "Cisco Webex",
      selectionLabel: "Cisco Webex Bot",
      docsPath: "/channels/webex",
      docsLabel: "webex",
      blurb: "Webex bot channel powered by webex-node-bot-framework.",
      aliases: ["cisco-webex"],
      order: 80,
    },
    capabilities: {
      chatTypes: ["direct", "channel"],
      threads: false,
      media: false,
      polls: false,
    },
    reload: { configPrefixes: ["channels.webex"] },
    configSchema: WebexChannelConfigSchema,
    config: {
      sectionKey: "webex",
      resolveAccount: (cfg: any) => ({
        accountId: "default",
        enabled: cfg?.channels?.webex?.enabled !== false,
        configured: hasConfiguredWebexChannel(cfg),
      }),
      isConfigured: (_account: unknown, cfg: unknown) => hasConfiguredWebexChannel(cfg),
    },
    gateway: {
      startAccount: async (ctx: any) => {
        const provider = await monitorWebexProvider({
          cfg: ctx.cfg,
          abortSignal: ctx.abortSignal,
        });
        state.provider = provider ?? undefined;
        const configured = hasConfiguredWebexChannel(ctx.cfg);
        ctx.setStatus({ accountId: ctx.accountId, configured, running: Boolean(provider) });
        return provider;
      },
    },
    outbound: {
      deliveryMode: "direct",
      sendText: async (params: any) => {
        const runtime = getWebexRuntime();
        const provider = state.provider;
        if (!provider) {
          throw new Error("Webex provider not running.");
        }

        const cfg = resolveWebexChannelConfig(params.cfg);
        const to = (params.to || cfg.defaultTo || "").trim();
        if (!to) {
          throw new Error("Missing Webex target. Provide `to` or configure channels.webex.defaultTo.");
        }

        await sendTextWebex({
          frameworkRuntime: provider.runtime,
          to,
          text: params.text,
        });
        runtime.log?.debug?.("webex outbound sent", { to });
        return { messageId: "framework", conversationId: to };
      },
    },
  },
});
