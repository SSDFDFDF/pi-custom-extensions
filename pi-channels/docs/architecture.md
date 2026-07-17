# pi-channels architecture (greenfield)

## Goal

Multi-channel companion for a **live Pi session**.  
Telegram is one adapter. No pi-telegram compatibility shims.

## Topology

```text
adapters (telegram, qqbot, …)  --ChannelEvent-->  core runtime  --Pi ports-->  Pi session
adapters <---OutboundIntent---  core runtime  <---agent_end text---  Pi session
```

## Core contracts

- `ChannelTarget` — `{ channelId, profileId, address }` (`address` opaque)
- `ChannelEvent` — message | command | action | control
- `ChannelTurn` + lanes control/priority/default
- `OutboundIntent` — typing | preview | final | notice (Markdown)
- `DeliveryFence` — instanceId + sessionGen + transportStamp

## Telegram adapter

- Long-poll `getUpdates`
- Default `finalFormat: "compat"` → Markdown → Telegram HTML
- Sanitize math / tickers / raw HTML
- Pair first user if `allowedUserId` missing
- Persist offset + pair id into `channels.json`

## QQ Bot adapter

- Gateway WebSocket (Identify + heartbeat + Dispatch)
- Intents: `GROUP_AND_C2C` (`1<<25`)
- C2C inbound → passive final with `msg_id` / `msg_seq`
- Inbound attachments download to temp (images → multimodal)
- Outbound attach: upload `file_data` base64 → `msg_type:7` media
- Outbound text: `msg_type:2` custom markdown when `finalFormat` is native/compat; plain fallback
- Progress: single status message (no edit API) → delete on clear/final; typing no-op
- Progress updates after first send are ignored (passive reply budget)
- Pair first openid if `allowedOpenId` missing
- Optional group `@` when `enableGroup: true`

## Config

`~/.pi/agent/channels.json` only.

## Phases

1. Solo telegram text
2. Files + progress draft + attach tool
3. QQ Bot C2C companion (current)
4. QQ media + group polish / webhook third channel
5. Extension platform APIs

## Non-goals

- Migrating pi-telegram state machines
- Multi-instance topic bus in v1
- Being a public multi-tenant bot
