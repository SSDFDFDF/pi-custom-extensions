# pi-channels

Multi-channel companion runtime for live Pi sessions.

Adapters: **Telegram** + **QQ Bot** (C2C). Core does not know Bot API types.  
**Greenfield** — no migration layer from `@llblab/pi-telegram`. Delete the old package when you switch.

## Packages

| Package | Role |
| --- | --- |
| `@kun/pi-channels-core` | Queue, turns, targets, runtime |
| `@kun/pi-channels-telegram` | Telegram poller + **compat HTML** replies (Web-safe default) |
| `@kun/pi-channels-qqbot` | QQ Bot Gateway WS + passive C2C replies |
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
    },
    "qqbot": {
      "profiles": {
        "default": {
          "enabled": true,
          "appId": "…",
          "clientSecret": "…",
          "allowedOpenId": "",
          "enableGroup": false,
          "sandbox": false,
          "render": { "finalFormat": "plain" },
          "progress": { "mode": "progress" }
        }
      }
    }
  }
}
```

## Pi commands

```text
/channel-setup <botToken>
/channel-setup qqbot <appId> <clientSecret> [sandbox]
/channel-connect [telegram|qqbot]   # acquire lock + start transport
/channel-connect qqbot force        # steal lock if sure other session is dead
/channel-disconnect                 # stop + release lock
/channel-status
```

### Connect lock (one transport owner per profile)

Only one Pi session may own a given channel profile at a time.

- Lock files: `~/.pi/agent/tmp/channels/locks/<channel>-default.json`
- Heartbeat every 15s; stale after ~45s or dead pid can be taken over
- Second `/channel-connect` fails with holder info unless `force`
- Always `/channel-disconnect` before connecting another session / channel

DM controls (Telegram + QQ C2C): `/abort` `/stop` `/next` `/continue`

### QQ Bot notes

- Register at [q.qq.com](https://q.qq.com/) → create bot → AppID + AppSecret
- Prefer **passive** replies (`msg_id`); proactive C2C is ~4 msgs/user/month
- Default progress drafts are **off** (passive reply quota)
- First C2C message pairs `allowedOpenId` (solo operator)
- Optional `enableGroup: true` for `GROUP_AT_MESSAGE_CREATE`
- Sandbox: `/channel-setup qqbot <appId> <secret> sandbox`
- **Inbound media**: image/file attachments download into temp and enter Pi (images as multimodal)
- **Outbound media**: `channel_attach` uploads via `/v2/users|groups/.../files` then `msg_type:7`
- **Text format**: default **`plain`** (`msg_type:0`). Optional markdown: set `render.finalFormat` to `compat`/`native` (`msg_type:2`, falls back to plain on reject).
- **Progress**: not Telegram-style edit-in-place. **One** sticky bubble on first tool: `💪 正在执行中` (Unicode emoji; no recall on settle). Later progress ticks are ignored to save passive reply quota.
- **Faces (C2C)**: real 小黄脸 embeds don't render in bot private chat. Instead:
  - classic slash codes work: `/fendou` `/wx` `/微笑` `/gz` … → Unicode (💪 😊 …)
  - `/fendou` alone is a fun command (not sent to the model)
  - `<faceType=…>` / `<emoji:N>` auto-map to Unicode
  - reserved: `/abort` `/stop` `/next` `/continue` `/help` (not faces)

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

- **Now:** Telegram (full) + QQ Bot C2C (passive final, progress off, media in/out)
- **Next:** QQ group polish, stream_messages, proactive push policy
- **Not v1:** Threaded multi-instance bus, full menu parity with pi-telegram
