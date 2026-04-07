import * as OpenClawCore from "openclaw/plugin-sdk/core";

const buildChannelConfigSchemaCompat: <T>(schema: T) => T | { schema: T } =
  (OpenClawCore as { buildChannelConfigSchema?: <T>(schema: T) => T }).buildChannelConfigSchema ??
  ((nextSchema) => ({ schema: nextSchema }));

export type WebexChannelConfig = {
  enabled?: boolean;
  token?: string;
  webhookUrl?: string;
  defaultTo?: string;
  listenPort?: number;
};

type JsonSchemaObject = {
  type: "object";
  additionalProperties?: boolean;
  properties?: Record<string, unknown>;
  required?: string[];
};

const schema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: {
      type: "boolean",
      default: true,
      title: "Enabled",
      description: "Enable or disable the Webex channel.",
    },
    token: {
      type: "string",
      minLength: 1,
      title: "Bot Token",
      description: "Webex bot access token.",
      "x-ui": {
        secret: true,
        tags: ["security", "auth", "webex", "channels"],
      },
    },
    webhookUrl: {
      type: "string",
      minLength: 1,
      title: "Webhook URL",
      description: "Public Webex webhook callback URL for this plugin.",
      format: "uri",
      "x-ui": {
        tags: ["network", "webhook", "channels"],
      },
    },
    defaultTo: {
      type: "string",
      minLength: 1,
      title: "Default Target",
      description: "Default Webex roomId target for outbound messages.",
      "x-ui": {
        tags: ["routing", "channels"],
      },
    },
    listenPort: {
      type: "integer",
      minimum: 1,
      maximum: 65535,
      title: "Listen Port",
      description:
        "Local HTTP listen port override for the Webex webhook server (useful when 3978 is already in use).",
      "x-ui": {
        tags: ["network", "channels"],
      },
    },
  },
  required: ["token", "webhookUrl"],
};

export const WebexChannelConfigSchema = buildChannelConfigSchemaCompat(schema);

export function resolveWebexChannelConfig(cfg: unknown): WebexChannelConfig {
  const channelCfg = (cfg as { channels?: { webex?: WebexChannelConfig } } | undefined)?.channels?.webex;
  return channelCfg ?? {};
}

export function hasConfiguredWebexChannel(cfg: unknown): boolean {
  const channelCfg = resolveWebexChannelConfig(cfg);
  return Boolean(channelCfg.token?.trim() && channelCfg.webhookUrl?.trim());
}

export function parseWebhookUrl(raw: string): { url: URL; path: string; port?: number } {
  const url = new URL(raw);
  const path = url.pathname?.trim() ? url.pathname : "/webex/webhook";
  const port = url.port ? Number(url.port) : undefined;
  return { url, path, port };
}
