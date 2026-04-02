export type WebexChannelConfig = {
  enabled?: boolean;
  token?: string;
  webhookUrl?: string;
  defaultTo?: string;
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
    enabled: { type: "boolean", default: true },
    token: {
      type: "string",
      minLength: 1,
      description: "Webex bot access token.",
    },
    webhookUrl: {
      type: "string",
      minLength: 1,
      description: "Public Webex webhook callback URL for this plugin.",
    },
    defaultTo: {
      type: "string",
      minLength: 1,
      description: "Default Webex roomId target for outbound messages.",
    },
  },
  required: ["token", "webhookUrl"],
};

export const WebexChannelConfigSchema = schema;

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
