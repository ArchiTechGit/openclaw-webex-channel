import * as OpenClawCore from "openclaw/plugin-sdk/core";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-contract";
import { WebexChannelConfigSchema, hasConfiguredWebexChannel, resolveWebexChannelConfig } from "./config-schema.js";
import { monitorWebexProvider } from "./monitor.js";
import { sendTextWebex } from "./outbound.js";
import { getWebexRuntime } from "./runtime.js";

const createChatChannelPluginCompat: (config: any) => any =
  (OpenClawCore as { createChatChannelPlugin?: (config: any) => any }).createChatChannelPlugin ??
  ((config: any) => config?.base ?? config);

type RuntimeState = {
  provider?: Awaited<ReturnType<typeof monitorWebexProvider>>;
};

const state: RuntimeState = {};

async function waitUntilAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return await new Promise<void>(() => {});
  }
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export const webexPlugin: ChannelPlugin<any, any> = createChatChannelPluginCompat({
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
      // Keep both modern and legacy config adapter fields for broad runtime compatibility.
      sectionKey: "webex",
      listAccountIds: () => ["default"],
      resolveAccount: (cfg: any) => ({
        accountId: "default",
        enabled: cfg?.channels?.webex?.enabled !== false,
        configured: hasConfiguredWebexChannel(cfg),
      }),
      resolveAccessorAccount: ({ cfg }: any) => resolveWebexChannelConfig(cfg),
      resolveAllowFrom: () => undefined,
      resolveDefaultTo: (account: any) => account?.defaultTo,
      isConfigured: (_account: unknown, cfg: unknown) => hasConfiguredWebexChannel(cfg),
    },
    gateway: {
      startAccount: async (ctx: any) => {
        if (state.provider) {
          await state.provider.shutdown();
          state.provider = undefined;
        }

        const provider = await monitorWebexProvider({
          cfg: ctx.cfg,
          abortSignal: ctx.abortSignal,
        });
        state.provider = provider ?? undefined;
        const configured = hasConfiguredWebexChannel(ctx.cfg);
        ctx.setStatus({ accountId: ctx.accountId, configured, running: Boolean(provider) });
        if (!provider) {
          return null;
        }

        try {
          await waitUntilAbort(ctx.abortSignal);
          return null;
        } finally {
          if (state.provider) {
            await state.provider.shutdown();
            state.provider = undefined;
          }
        }
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
