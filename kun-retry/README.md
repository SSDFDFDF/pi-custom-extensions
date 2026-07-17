# kun-retry

Local Pi extension that replaces `@narumitw/pi-retry`.

## Features

- **maxRetries / baseDelayMs override** — written into `~/.pi/agent/settings.json` so Pi’s built-in `_prepareRetry` uses your budget
- **Extra HTTP status codes** in provider `errorMessage` (e.g. 401, 403, Cloudflare 520–524)
- **Extra error regex patterns**
- **Legacy transport matchers** (empty-detail Unknown error, Codex WS limit, OpenAI Responses premature stream end, WebSocket stream closed before completion, no response body, network errno, bad gateway)
- **Stall stream watchdog** (default 90s)
- **Empty-response retry** — a completed-but-empty assistant turn (HTTP 200, no answer text and no tool calls; thinking-only turns count as empty too) is rewritten into a retryable error so Pi retries it
- **`/retry-nl`** — unlimited mode: *any* assistant error becomes retryable, with a huge `maxRetries` written to settings

## Install / load

Auto-discovered from:

```text
~/.pi/agent/extensions/kun-retry/
```

Remove the old package:

```bash
# settings.json packages: drop "npm:@narumitw/pi-retry"
cd ~/.pi/agent/npm && npm uninstall @narumitw/pi-retry
```

Then `/reload` or restart Pi.

## Config file

`~/.pi/agent/kun-retry.config.json` (auto-created on first write):

```json
{
  "enabled": true,
  "maxRetries": 10,
  "baseDelayMs": 2000,
  "statusCodes": [401, 403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529],
  "errorPatterns": [],
  "stallTimeoutMs": 90000,
  "nl": false,
  "retryEmptyResponse": true,
  "syncSettings": true
}
```

## Commands

| Command | Meaning |
|---------|---------|
| `/retry` / `/retry status` | Show config |
| `/retry on` / `/retry off` | Enable / disable extension matching |
| `/retry max 20` | Set max retries (syncs settings.json) |
| `/retry delay 3000` | Set base delay ms |
| `/retry codes 401,403` | Status codes to match |
| `/retry patterns "quota reset",timeout` | Extra regexes |
| `/retry stall 60000` | Stall watchdog ms (`off`/`0` disables) |
| `/retry empty on` / `off` | Retry empty provider responses (default on) |
| `/retry sync` | Force write maxRetries into settings.json |
| `/retry-nl` | Toggle unlimited any-error mode |
| `/retry-nl on` / `off` | Explicit nl |

## How it works

1. On match (legacy / status / pattern / nl), `message_end` appends  
   `provider returned error` so Pi’s `isRetryableAssistantError` accepts it.
   Empty responses (non-error stopReason, no usable content) are rewritten with
   `stopReason: "error"` + the same hint so the built-in classifier sees them.
2. Pi’s agent auto-retry removes the failed assistant turn and `continue()`s with exponential backoff.
3. Attempt budget is **Pi settings** `retry.maxRetries` — this extension keeps that in sync with its config (and uses a large number when `nl` is on).

**Important:** Changing `settings.json` mid-session only updates the file. In-memory retry limits refresh on **process start** or **`/reload`**. After `/retry max` or `/retry-nl`, run `/reload` once so the agent uses the new budget.

## Stall flag / env

```bash
pi --retry-stall-timeout-ms 10000
PI_RETRY_STALL_TIMEOUT_MS=10000 pi
```

## Notes

- Context overflow is **not** turned into auto-retry (Pi compaction path).
- Escape still cancels an in-progress backoff.
- `nl` mode retries *every* `stopReason: "error"`; use carefully.
- Empty-response retry ignores `aborted` (user cancel) and `length` (partial output cut off by token limit) turns; disable with `/retry empty off` if a provider legitimately returns empty completions.
