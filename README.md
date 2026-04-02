# OpenClaw Webex Channel Plugin

Webex channel plugin for OpenClaw using webex-node-bot-framework.

## Required Configuration

Set both values in your OpenClaw config under channels.webex:

- token: Webex bot token
- webhookUrl: Public callback URL that Webex calls for events
- listenPort (optional): Local port for the plugin webhook server if default/fallback port is already in use

Example:

```json
{
  "channels": {
    "webex": {
      "enabled": true,
      "token": "YOUR_WEBEX_BOT_TOKEN",
      "webhookUrl": "https://your-public-host.example.com/webex/webhook",
      "defaultTo": "Y2lzY29zcGFyazovL3VzL1JPT00v...",
      "listenPort": 3988
    }
  }
}
```

## Enable in OpenClaw

1. Place this plugin in your OpenClaw extensions path (for example `.openclaw/extensions/webex`).
2. Ensure OpenClaw loads the plugin entry from `index.ts` (or built output if your runtime requires compiled JS).
3. Enable the channel in your OpenClaw config by setting `channels.webex.enabled: true` and providing `token` + `webhookUrl`.
4. Restart the OpenClaw gateway so the channel plugin is registered and started.

The plugin now exposes UI metadata for Control UI. In the channel settings panel,
you should see editable fields for:

- Enabled
- Bot Token
- Webhook URL
- Default Room ID
- Listener Port

Minimal enablement example:

```json
{
  "channels": {
    "webex": {
      "enabled": true,
      "token": "YOUR_WEBEX_BOT_TOKEN",
      "webhookUrl": "https://your-public-host.example.com/webex/webhook"
    }
  }
}
```

## Behavior

- Receives inbound messages from Webex via webhook middleware from webex-node-bot-framework.
- Sends outbound text messages to a target roomId, or person:<personId>.
- Ignores bot-authored inbound messages to prevent loops.

## Local OpenShell Notes

- Ensure webhookUrl is publicly reachable from Webex cloud.
- The plugin listens on `PORT` when set, otherwise uses webhookUrl explicit port, otherwise falls back to `3978`.
- To avoid `EADDRINUSE` port conflicts (common when another channel uses 3978), set `channels.webex.listenPort`.
- If running behind a reverse proxy in OpenShell, route webhookUrl path to this plugin service.
- The plugin includes a Node compatibility shim for legacy Webex dependencies that mutate `globalThis.navigator`.
