# OpenClaw Webex Channel Plugin

Webex channel plugin for OpenClaw using webex-node-bot-framework.

## Required Configuration

Set both values in your OpenClaw config under channels.webex:

- token: Webex bot token
- webhookUrl: Public callback URL that Webex calls for events

Example:

```json
{
  "channels": {
    "webex": {
      "enabled": true,
      "token": "YOUR_WEBEX_BOT_TOKEN",
      "webhookUrl": "https://your-public-host.example.com/webex/webhook",
      "defaultTo": "Y2lzY29zcGFyazovL3VzL1JPT00v..."
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
- The plugin listens on the port inferred from webhookUrl (80/443 default).
- If running behind a reverse proxy in OpenShell, route webhookUrl path to this plugin service.
