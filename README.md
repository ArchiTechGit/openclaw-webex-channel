# OpenClaw Webex Channel Plugin

Cisco Webex channel plugin for OpenClaw, built on `webex-node-bot-framework`.

## Highlights

- Inbound messages are routed to OpenClaw agent dispatch via the PluginRuntime channel APIs.
- Outbound Webex API calls include retry with backoff for transient network/proxy failures.
- Temporary `Thinking...` placeholder message is sent immediately on inbound message receipt.
- Placeholder is deleted when the first LLM reply is sent.
- If no reply is produced, a fallback warning message is posted asking the user to try again.

## Installation

```bash
npm install @richwats/webex
```

This package exports the compiled extension entry at `./dist/index.js`.

## OpenClaw Extension Entry

Package metadata already declares:

```json
{
  "openclaw": {
    "extensions": ["./dist/index.js"]
  }
}
```

## Channel Configuration

Configure under `channels.webex` in your OpenClaw config.

Required fields:

- `token`: Webex bot token
- `webhookUrl`: public callback URL Webex calls for events

Optional fields:

- `enabled`: boolean (default `true`)
- `defaultTo`: default outbound destination (`roomId` or `person:<personId>` pattern when used by outbound tools)
- `listenPort`: local webhook server port override

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

## Control UI

The plugin provides structured channel schema fields for the Channels page in Control UI:

- `Enabled`
- `Bot Token` (marked as secret)
- `Webhook URL`
- `Default Target`
- `Listen Port`

## Runtime Notes

- Inbound bot-authored messages are ignored to prevent loops.
- Listen port resolution order: `channels.webex.listenPort` -> `PORT` env var -> explicit `webhookUrl` port -> `3978`.
- If running behind a reverse proxy, route your `webhookUrl` path to this plugin listener.

## Development

```bash
npm run check
npm run build
```

## License

Apache-2.0. See the LICENSE file.
