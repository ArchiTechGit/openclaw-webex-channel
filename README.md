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
