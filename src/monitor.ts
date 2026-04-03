import express from "express";
import type { Server } from "node:http";
import { createWebexFrameworkRuntime, type WebexFrameworkRuntime, bindFrameworkWebhook } from "./framework-runtime.js";
import { parseWebhookUrl, resolveWebexChannelConfig } from "./config-schema.js";
import { getWebexRuntime, webexLogDebug, webexLogError, webexLogInfo } from "./runtime.js";

export type MonitorWebexOptions = {
  cfg: unknown;
  abortSignal?: AbortSignal;
};

export type MonitorWebexResult = {
  runtime: WebexFrameworkRuntime;
  shutdown: () => Promise<void>;
  port: number;
  path: string;
};

export async function monitorWebexProvider(options: MonitorWebexOptions): Promise<MonitorWebexResult | null> {
  const runtime = getWebexRuntime();
  const channelCfg = resolveWebexChannelConfig(options.cfg);

  webexLogDebug("webex monitor starting", {
    enabled: channelCfg.enabled !== false,
    hasToken: Boolean(channelCfg.token?.trim()),
    hasWebhookUrl: Boolean(channelCfg.webhookUrl?.trim()),
  });

  if (channelCfg.enabled === false) {
    runtime.log?.debug?.("webex provider disabled");
    return null;
  }

  if (!channelCfg.token?.trim() || !channelCfg.webhookUrl?.trim()) {
    runtime.log?.error?.("webex token and webhookUrl are required");
    return null;
  }

  const parsedWebhook = parseWebhookUrl(channelCfg.webhookUrl);
  const path = parsedWebhook.path;
  const cfgListenPort =
    typeof channelCfg.listenPort === "number" && channelCfg.listenPort > 0
      ? Math.floor(channelCfg.listenPort)
      : undefined;
  const envPort = Number(process.env.PORT || "");
  const port =
    cfgListenPort ??
    (Number.isFinite(envPort) && envPort > 0 ? envPort : (parsedWebhook.port ?? 3978));
  const frameworkRuntime = createWebexFrameworkRuntime({
    token: channelCfg.token,
    webhookUrl: channelCfg.webhookUrl,
  });
  frameworkRuntime.attachInboundHandlers();

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  bindFrameworkWebhook(app, path, frameworkRuntime.webhookMiddleware);

  webexLogInfo("webex monitor binding http listener", { port, path });
  const server = await listen(app, port);
  try {
    webexLogInfo("webex framework.start begin", { port, path });
    await frameworkRuntime.framework.start();
    webexLogInfo("webex framework.start complete", { port, path });
  } catch (err) {
    webexLogError("webex framework.start failed", { error: String(err), port, path });
    await closeServer(server);
    throw err;
  }

  const shutdown = async () => {
    webexLogInfo("webex monitor shutdown begin", { port, path });
    await Promise.resolve(frameworkRuntime.framework.stop());
    await closeServer(server);
    webexLogInfo("webex monitor shutdown complete", { port, path });
  };

  runtime.log?.info?.("webex provider started", { port, path });

  return {
    runtime: frameworkRuntime,
    shutdown,
    port,
    path,
  };
}

async function listen(app: ReturnType<typeof express>, port: number): Promise<Server> {
  return await new Promise<Server>((resolve, reject) => {
    const server = app.listen(port);
    server.once("listening", () => {
      webexLogDebug("webex http listener active", { port });
      resolve(server);
    });
    server.once("error", (err: unknown) => {
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as { code?: unknown }).code)
          : "";
      if (code === "EADDRINUSE") {
        reject(
          new Error(
            `webex listen port ${port} already in use. Set channels.webex.listenPort, PORT, or webhookUrl with an explicit port to resolve the conflict.`,
          ),
        );
        return;
      }
      webexLogError("webex http listener error", { port, code, error: String(err) });
      reject(err);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
