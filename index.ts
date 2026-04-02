import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { webexPlugin } from "./src/channel.js";
import { setWebexRuntime } from "./src/runtime.js";

export { webexPlugin } from "./src/channel.js";
export { setWebexRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "webex",
  name: "Cisco Webex",
  description: "Cisco Webex channel plugin (webex-node-bot-framework)",
  plugin: webexPlugin,
  setRuntime: setWebexRuntime,
});
