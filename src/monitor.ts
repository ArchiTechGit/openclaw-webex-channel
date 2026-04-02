import express from "express";
import type { Server } from "node:http";
import { createWebexFrameworkRuntime, type WebexFrameworkRuntime, bindFrameworkWebhook } from "./framework-runtime.js";
import { parseWebhookUrl, resolveWebexChannelConfig } from "./config-schema.js";
import { getWebexRuntime } from "./runtime.js";

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
  const envPort = Number(process.env.PORT || "");
  const port = Number.isFinite(envPort) && envPort > 0 ? envPort : (parsedWebhook.port ?? 3978);
  const frameworkRuntime = createWebexFrameworkRuntime({
    token: channelCfg.token,
    webhookUrl: channelCfg.webhookUrl,
  });
  frameworkRuntime.attachInboundHandlers();

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  bindFrameworkWebhook(app, path, frameworkRuntime.webhookMiddleware);

  const server = await listen(app, port);
  await frameworkRuntime.framework.start();

  const shutdown = async () => {
    await Promise.resolve(frameworkRuntime.framework.stop());
    await closeServer(server);
  };

  options.abortSignal?.addEventListener("abort", () => {
    void shutdown();
  });

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
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
