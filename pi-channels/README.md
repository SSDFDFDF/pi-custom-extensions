# pi-channels

Multi-channel companion runtime for live Pi sessions.

Telegram is **adapter #1**. Core does not know Bot API types.  
**Greenfield** — no migration layer from `@llblab/pi-telegram`. Delete the old package when you switch.

## Packages

| Package | Role |
| --- | --- |
| `@kun/pi-channels-core` | Queue, turns, targets, runtime |
| `@kun/pi-channels-telegram` | Telegram poller + **compat HTML** replies (Web-safe default) |
| `@kun/pi-channels` | Pi extension (`/channel-*`) |

## Config

Only `~/.pi/agent/channels.json`:

```json
{
  "defaultChannel": "telegram",
  "proactivePush": true,
  "channels": {
    "telegram": {
      "profiles": {
        "default": {
          "enabled": true,
          "botToken": "…",
          "allowedUserId": 123,
          "render": {
            "finalFormat": "compat",
            "sanitizeMarkdown": true,
            "neutralizeMath": true,
            "draftPreviews": false
          }
        }
      }
    }
  }
}
```

## Pi commands

```text
/channel-setup <botToken>
/channel-connect [telegram]     # acquire poll lock + start getUpdates
/channel-connect force          # steal lock (only if sure other session is dead)
/channel-disconnect             # stop poll + release lock
/channel-status
```

### Connect lock (no double getUpdates)

Only one Pi session may poll a given telegram profile at a time.

- Lock file: `~/.pi/agent/tmp/channels/locks/telegram-default.json`
- Heartbeat every 15s; stale after ~45s or dead pid can be taken over
- Second `/channel-connect` fails with holder info unless `force`
- Always `/channel-disconnect` before connecting another session

Telegram DM controls: `/abort` `/stop` `/next` `/continue`

## Install (local)

Symlink into global extensions (auto-discovered):

```bash
ln -sfn /home/xjc/projects/pi-channels/packages/extension \
  ~/.pi/agent/extensions/pi-channels
```

Remove `npm:@llblab/pi-telegram` from `~/.pi/agent/settings.json` so two pollers
never share one bot token. Old `telegram.json` can be deleted after `channels.json` is filled.

## Docs

- [Architecture](./docs/architecture.md)
- [Decisions](./docs/decisions.md)

## Progress drafts (OpenClaw-style)

While a **channel-owned** turn runs tools, pi-channels keeps **one** status
message, edits it with compact lines like `📖 read: path`, then **deletes** it
on `agent_settled` before the final HTML answer. Local TUI runs never get a
progress draft or channel final. Subsequent progress edits are throttled;
only the first materialization is forced.

```json
"progress": {
  "mode": "progress",
  "startDelayMs": 2500,
  "maxLines": 5,
  "maxLineChars": 100,
  "minEditIntervalMs": 400
}
```

Set `mode: "off"` for final-only + typing.

## Inbound media & replies

- Photos **and image documents** (`image/*` / png/jpg/…) enter Pi as **multimodal** image blocks.
- Other documents/audio/video/voice download when under 50 MiB and appear as path notes.
- Final answers use Telegram `reply_parameters` on the triggering message (first chunk only).

## Outbound attach

Model tool: `channel_attach({ paths: string[], caption? })`.

- During a channel-owned turn → files queue and send **after** the final text on settle.
- Otherwise → send immediately to the last channel target.
- Images → `sendPhoto`; other files → `sendDocument`.

## Transport

Telegram API calls are **serialized** (progress edit vs final cannot race),
retry on 429/5xx/network, and fall back to **IPv4-only HTTPS** when dual-stack
`fetch` fails.

## Phase

- **Now:** solo Telegram, media in, progress draft, HTML final + reply anchor
- **Next:** outbound attach tool, proactive push, second channel (webhook)
- **Not v1:** Threaded multi-instance bus, full menu parity with pi-telegram
