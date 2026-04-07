declare module "openclaw/plugin-sdk/core" {
  export function defineChannelPluginEntry(config: any): any;
  export function createChatChannelPlugin(config: any): any;
  export function buildChannelConfigSchema<T = any>(schema: T): T;
}

declare module "openclaw/plugin-sdk/channel-contract" {
  export type ChannelPlugin<TAccount = unknown, TProbe = unknown> = any;
}

declare module "openclaw/plugin-sdk/channel-config-schema" {
  export type JsonSchemaObject = {
    type: "object";
    additionalProperties?: boolean;
    properties?: Record<string, unknown>;
    required?: string[];
  };

  export function buildChannelConfigSchema<T = JsonSchemaObject>(schema: T): T;
}
