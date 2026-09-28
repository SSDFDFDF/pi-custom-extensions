# kun-retry

Local Pi extension that replaces `@narumitw/pi-retry`.

## Features

- **maxRetries / baseDelayMs override** — written into `~/.pi/agent/settings.json` so Pi’s built-in `_prepareRetry` uses your budget
- **Constant retry interval** — opt-in fixed wait between attempts instead of Pi’s uncapped exponential backoff (`constantDelayMs`, off by default)
- **Extra HTTP status codes** in provider `errorMessage` (e.g. 401, 403, Cloudflare 520–524)
- **Extra error regex patterns**
- **Legacy transport matchers** (empty-detail Unknown error, Codex WS limit, OpenAI Responses premature stream end, WebSocket stream closed before completion, no response body, network errno, bad gateway)
- **Stall stream watchdog** (default 90s) — aborts only the stalled provider stream
  (never `ctx.abort()`), so Pi's auto-retry still engages instead of treating the
  stall as a user cancel
- **Empty-response retry** — a completed-but-empty assistant turn (HTTP 200, no answer text and no tool calls; thinking-only turns count as empty too) is rewritten into a retryable error so Pi retries it
- **Candidate-model rotation** — set a pool of provider/model candidates and kun-retry switches the session model after N consecutive retryable errors, cycling through the used + candidate models (see below)
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
  "syncSettings": true,
  "switchAfterErrors": 3,
  "includeActiveInRotation": true,
  "rotationThinkingLevel": "max"
}
```

> The model-rotation **candidate list is session-scoped** and is not written to
> this file; it is set per session with `/retry-models` and cleared when the
> session ends. Only the two behavioral rotation knobs (`switchAfterErrors`,
> `includeActiveInRotation`) are persisted here.

## Commands

### `/retry` — retry behavior

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

### `/retry-models` — candidate-model rotation

| Command | Meaning |
|---------|---------|
| `/retry-models` | Show pool, active model, and rotation state |
| `/retry-models <p/id> ...` | Set the candidate list + enable rotation |
| `/retry-models add <p/id> ...` | Add candidates (available models only) |
| `/retry-models remove <p/id> ...` | Remove candidates |
| `/retry-models clear` | Drop all candidates and disable rotation |
| `/retry-models available` | List models usable in this session |
| `/retry-models switch <n>` | Consecutive retryable errors before switching (`0` disables) |
| `/retry-models rotate on` / `off` | Pause / resume rotation without clearing the list |
| `/retry-models active on` / `off` | Fold the used (current) model into the cycle (default on) |
| `/retry-models thinking <level>` | Thinking level applied after a switch: `inherit` or a concrete level (default `max`) |

## How it works

1. On match (legacy / status / pattern / nl), `message_end` appends  
   `provider returned error` so Pi’s `isRetryableAssistantError` accepts it.
   Empty responses (non-error stopReason, no usable content) are rewritten with
   `stopReason: "error"` + the same hint so the built-in classifier sees them.
2. Pi’s agent auto-retry removes the failed assistant turn and `continue()`s after a backoff.
3. Attempt budget is **Pi settings** `retry.maxRetries` — this extension keeps that in sync with its config (and uses a large number when `nl` is on).

### Why the watchdog must not call `ctx.abort()`

`AgentSession.abort()` is Pi's *user-cancelled* path: it sets
`_agentRunAbortRequested = true`, and `_handlePostAgentRun()` checks that flag before
anything else and returns immediately, so `_prepareRetry()` is never called. A stall
watchdog built on `ctx.abort()` therefore writes a perfectly retryable-looking error
message and Pi still refuses to retry it — which looked like "matched but never
retried".

The watchdog instead captures the live session (via a one-time wrap of
`AgentSession.prototype.bindExtensions`) and aborts only the underlying agent run,
leaving the cancel flag false so auto-retry runs. This also avoids a second side
effect of `ctx.abort()`: interactive mode restores queued steering/follow-up messages
back into the editor, which must not happen during an auto-retry. Every other abort
(Escape, Ctrl+C, session switch) is untouched and still cancels the run as before.
If the session cannot be captured, the watchdog falls back to `ctx.abort()` and warns
once that the stalled stream will not be auto-retried.

## Backoff: exponential vs constant

Pi computes its agent-level delay in `AgentSession._prepareRetry` as
`min(baseDelayMs * 2 ** (attempt - 1), retry.maxAgentDelayMs)` — the exponential
curve is capped by `retry.maxAgentDelayMs` (default 60000, i.e. 60s). As of Pi
0.86.0 there is **no unbounded growth**, so the old "reaches days between attempts
and degenerates into a hot loop past 2^31ms" hazard no longer applies.

`constantDelayMs > 0` replaces that curve with a fixed interval:

| `constantDelayMs` | Behavior |
|---|---|
| `0` (default) | Pi's built-in exponential backoff, completely unmodified |
| `5000` | Every attempt waits 5s, forever if `nl` is on |

This is not a reimplementation of retry. The extension wraps `_prepareRetry` and,
only in constant mode, hands Pi a `baseDelayMs` pre-divided by the exponent Pi is
about to apply, so Pi's own formula lands exactly on the configured interval.
Everything else in `_prepareRetry` still runs: budget accounting, removal of the
failed assistant turn, the `auto_retry_start` event, the abortable sleep (Escape
still cancels), and `auto_retry_end`.

Because the fixed interval keeps attempt counts high on long runs, the extension
tracks its own cumulative counter for the budget and rewinds Pi's `_retryAttempt`
before `2 ** attempt` could overflow. The footer shows the true attempt number and
interval, e.g. `retrying∞ 37 @5s`.

### The delay cap matters above 60s

Because Pi clamps the delay at `retry.maxAgentDelayMs`, a `constantDelayMs` larger
than that cap would be **silently truncated**. The extension therefore syncs
`retry.maxAgentDelayMs` in settings.json up to at least `constantDelayMs` whenever
constant mode is on (it never lowers a larger user value, and leaves it alone when
constant mode is off). `/retry constant` reports the effective cap, and warns if it
is still below the requested interval.

The patch touches `AgentSession.prototype`, which is internal to Pi. It verifies
that `_prepareRetry` exists before installing and otherwise warns once and leaves
Pi's exponential backoff in force. Other internal implementation changes remain
a compatibility risk, so the wrapper and the real `AgentSession` are both covered
by tests and should be rechecked after Pi upgrades.

**Important:** Changing `settings.json` mid-session only updates the file. In-memory retry limits refresh on **process start** or **`/reload`**. After `/retry max` or `/retry-nl`, run `/reload` once so the agent uses the new budget.

## Stall flag / env

```bash
pi --retry-stall-timeout-ms 10000
PI_RETRY_STALL_TIMEOUT_MS=10000 pi
```

## Notes

- On `session_shutdown`, stall/status timers, footer status and the captured session reference are cleared; throttle clocks reset. No session files are written by this extension.
- Context overflow is **not** turned into auto-retry (Pi compaction path).
- Escape still cancels an in-progress backoff.
- `nl` mode retries *every* `stopReason: "error"`; use carefully.
- Constant mode ignores `baseDelayMs`; that value only matters when `constantDelayMs` is `0`.
- Constant interval is clamped to 1 ms – 1 h. Very small values hammer the provider and can make 429s worse.
- A constant interval above `retry.maxAgentDelayMs` needs that cap raised too; the
  extension syncs it automatically when `constantDelayMs` is set.
- Empty-response retry ignores `aborted` (user cancel) and `length` (partial output cut off by token limit) turns; disable with `/retry empty off` if a provider legitimately returns empty completions.

## Candidate-model rotation

When a provider or model keeps failing, kun-retry can automatically move the
session to another model instead of retrying the same one forever.

### Setup

```text
/retry-models openai/gpt-4o anthropic/claude-3-5-sonnet xai/grok-4
/retry-models switch 3          # switch after 3 consecutive retryable errors (default)
```

Setting a non-empty candidate list with `/retry-models` enables rotation and
resets the streak. Commas or spaces both work as separators. Each candidate is a
`provider/id` string; the id may itself contain slashes (e.g.
`openrouter/anthropic/claude-3.5-sonnet`).

**Candidates are session-scoped.** The list lives in memory for the current
session only and is cleared on session shutdown; it is never written to
`kun-retry.config.json`. Models that are not currently configured/available are
rejected at set time, so only usable models enter the pool. Use
`/retry-models available` to see what can be added.

### How the cycle works

1. Every retryable error (status code, pattern, empty response, stall, or `nl`)
   increments a consecutive-error streak.
2. When the streak reaches `switchAfterErrors`, the session model switches to the
   **next usable model** in the rotation pool and the streak resets to `0`.
3. A genuinely successful assistant turn resets the streak, so a model that
   starts working is kept until it begins failing again.

The rotation pool is built once from the **used (base) model** plus the
candidate list, in a fixed order, so the cycle visits every model in turn rather
than bouncing between two:

```text
candidates: [claude, gpt-4o, grok],  base (in use): gpt-4o
pool:       [gpt-4o, claude, grok]
cycle:      gpt-4o → claude → grok → gpt-4o → …
```

The base model is captured at session start (and whenever you run
`/retry-models`), so switching between models does not reshuffle the cycle. Set
`/retry-models active off` to stop auto-folding the used model into the pool.
Note this only removes the *auto-added* base model: if the model you are on is
already listed as a candidate, it stays in the cycle because you listed it
explicitly.

### Skipping unusable models

Each candidate is checked against the model registry before a switch: unknown
models and providers without configured auth are skipped, and the cycle advances
to the next usable one. If no other usable model exists, the current model is
kept and a warning is shown.

### Thinking level after a switch

Pi's own model switch picks a thinking level in this order: explicit level →
per-model override → **global `defaultThinkingLevel`** → current session level →
`medium`. That means a manually raised level (e.g. `/thinking max`) can be
silently **downgraded** to the settings default when the rotation switches model.

kun-retry therefore re-asserts the level after every successful switch:

- `rotationThinkingLevel: "max"` (default) — apply `max`. Pi clamps it to the
  **strongest level the target model supports**, so a model without `max` falls
  back to its own highest level (e.g. `xhigh`, `high`, or `off` for
  non-reasoning models). This is "always go as strong as the model allows".
- `rotationThinkingLevel: "inherit"` — restore the level the session had before
  the switch, so a manual `/thinking` choice survives rotation.
- any concrete level (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`) —
  apply it, clamped to the model.

```text
/retry-models thinking max      # default: strongest the model supports
/retry-models thinking inherit  # keep whatever you set with /thinking
/retry-models thinking high     # pin a fixed level
```

### Notes

- Rotation counts the same retryable errors kun-retry already handles, so make
  sure `retry.maxRetries` (see `/retry max`) is high enough to allow several
  switches — e.g. with `switch 3` and three candidates you want at least ~9
  retries to visit them all once.
- `/retry-models switch 0` disables switching (rotation stays idle) without
  clearing the candidate list.
- `/retry-models rotate off` pauses rotation while keeping the list;
  `/retry-models rotate on` resumes it.
- The footer shows `rot/<n>` (or `nl∞ rot/<n>`) while rotation is active.
- Model switches use `pi.setModel`, which only affects the current session and
  never changes the configured default for new sessions.
