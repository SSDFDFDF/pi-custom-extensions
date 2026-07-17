# pi-channels architecture (greenfield)

## Goal

Multi-channel companion for a **live Pi session**.  
Telegram is one adapter. No pi-telegram compatibility shims.

## Topology

```text
adapters (telegram, …)  --ChannelEvent-->  core runtime  --Pi ports-->  Pi session
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

## Config

`~/.pi/agent/channels.json` only.

## Phases

1. Solo telegram text (current)
2. Files + proactive push + structured actions
3. Optional telegram UI extras
4. Second channel (webhook/discord) to prove multi-channel
5. Extension platform APIs

## Non-goals

- Migrating pi-telegram state machines
- Multi-instance topic bus in v1
- Being a public multi-tenant bot
