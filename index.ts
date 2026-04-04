import * as OpenClawCore from "openclaw/plugin-sdk/core";
import { webexPlugin } from "./src/channel.js";
import { setWebexRuntime } from "./src/runtime.js";

const defineChannelPluginEntryCompat: (params: any) => any =
  (OpenClawCore as { defineChannelPluginEntry?: (params: any) => any }).defineChannelPluginEntry ??
  ((params: any) => ({
    id: params.id,
    name: params.name,
    description: params.description,
    configSchema:
      typeof params.configSchema === "function"
        ? params.configSchema()
        : (params.configSchema ?? {
            type: "object",
            additionalProperties: false,
            properties: {},
          }),
    register(api: any) {
      params.setRuntime?.(api?.runtime ?? api);
      api.registerChannel?.({ plugin: params.plugin });
      params.registerCliMetadata?.(api);
      params.registerFull?.(api);
    },
    channelPlugin: params.plugin,
    ...(params.setRuntime ? { setChannelRuntime: params.setRuntime } : {}),
  }));

export { webexPlugin } from "./src/channel.js";
export { setWebexRuntime } from "./src/runtime.js";

export default defineChannelPluginEntryCompat({
  id: "openclaw-webex",
  name: "Cisco Webex",
  description: "Cisco Webex channel plugin (webex-node-bot-framework)",
  plugin: webexPlugin,
  setRuntime: setWebexRuntime,
});
