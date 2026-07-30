# kun-retry

Local Pi extension that replaces `@narumitw/pi-retry`.

## Features

- **maxRetries / baseDelayMs override** — written into `~/.pi/agent/settings.json` so Pi’s built-in `_prepareRetry` uses your budget
- **Constant retry interval** — opt-in fixed wait between attempts instead of Pi’s uncapped exponential backoff (`constantDelayMs`, off by default)
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
  "constantDelayMs": 0,
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
| `/retry delay 3000` | Set exponential base delay ms |
| `/retry constant 5s` | Fixed interval between attempts (`off`/`0` restores exponential) |
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
2. Pi’s agent auto-retry removes the failed assistant turn and `continue()`s after a backoff.
3. Attempt budget is **Pi settings** `retry.maxRetries` — this extension keeps that in sync with its config (and uses a large number when `nl` is on).

## Backoff: exponential vs constant

Pi computes its agent-level delay in `AgentSession._prepareRetry` as
`baseDelayMs * 2 ** (attempt - 1)` — no cap, no jitter. Over a long `nl` run that
reaches days between attempts, and once the delay passes ~2^31 ms Node’s timer
clamps it back to 1 ms and the backoff degenerates into a hot loop.

`constantDelayMs > 0` replaces that curve with a fixed interval:

| `constantDelayMs` | Behavior |
|---|---|
| `0` (default) | Pi’s built-in exponential backoff, completely unmodified |
| `5000` | Every attempt waits 5s, forever if `nl` is on |

This is not a reimplementation of retry. The extension wraps `_prepareRetry` and,
only in constant mode, hands Pi a `baseDelayMs` pre-divided by the exponent Pi is
about to apply, so Pi’s own formula lands exactly on the configured interval.
Everything else in `_prepareRetry` still runs: budget accounting, removal of the
failed assistant turn, the `auto_retry_start` event, the abortable sleep (Escape
still cancels), and `auto_retry_end`.

Because the fixed interval keeps attempt counts high on long runs, the extension
tracks its own cumulative counter for the budget and rewinds Pi’s `_retryAttempt`
before `2 ** attempt` could overflow. The footer shows the true attempt number and
interval, e.g. `retrying∞ 37 @5s`.

The patch touches `AgentSession.prototype`, which is internal to Pi. It verifies
that `_prepareRetry` exists before installing and otherwise warns once and leaves
Pi’s exponential backoff in force. Other internal implementation changes remain
a compatibility risk, so the wrapper and current retry formula are covered by
tests and should be rechecked after Pi upgrades.

**Important:** Changing `settings.json` mid-session only updates the file. In-memory retry limits refresh on **process start** or **`/reload`**. After `/retry max` or `/retry-nl`, run `/reload` once so the agent uses the new budget.

## Stall flag / env

```bash
pi --retry-stall-timeout-ms 10000
PI_RETRY_STALL_TIMEOUT_MS=10000 pi
```

## Notes

- On `session_shutdown`, stall/status timers and footer status are cleared; throttle clocks reset. No session files are written by this extension.
- Context overflow is **not** turned into auto-retry (Pi compaction path).
- Escape still cancels an in-progress backoff.
- `nl` mode retries *every* `stopReason: "error"`; use carefully.
- Constant mode ignores `baseDelayMs`; that value only matters when `constantDelayMs` is `0`.
- Constant interval is clamped to 1 ms – 1 h. Very small values hammer the provider and can make 429s worse.
- Empty-response retry ignores `aborted` (user cancel) and `length` (partial output cut off by token limit) turns; disable with `/retry empty off` if a provider legitimately returns empty completions.
