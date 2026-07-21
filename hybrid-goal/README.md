# hybrid-goal

Independent Pi **goal** extension:

1. **Session `/goal` runtime** — continuation, pause/resume, token budget, stale-turn guards, settled auto-continue.
2. **Optional independent judge** on `goal_complete` (MiMo-style cold verify), with separate caps for judge rejections vs working turns, plus `neverBlock` for flaky networks.
3. **Context-pressure guards** — do not auto-continue when the Pi footer context window is critically full; cooperate with Pi compact (never cancel threshold compact for goal budget).

## Install (this machine)

```text
~/.pi/agent/extensions/hybrid-goal/
```

Pi auto-discovers `~/.pi/agent/extensions/*/index.ts`.

Disable the old package so commands/tools do not double-register:

```json
// ~/.pi/agent/settings.json packages — remove:
// "npm:@narumitw/pi-goal"
```

Then `/reload` or restart `pi`.

## Commands

### `/goal`

```text
/goal <objective>
/goal --tokens 100k <objective>
/goal edit|pause|resume|clear
```

### `/goal-config`

```text
/goal-config
/goal-config judgeEnabled=false
/goal-config maxContinuations=50 neverBlock=true
/goal-config continueDeferContextPercent=95
```

Writes `~/.pi/agent/hybrid-goal.config.json`. Reload to fully apply runtime options.

### Tools

- `goal_complete({ goal_id, summary })` — local checks, then optional independent judge. Judge **on by default** (session model when `judgeModel` empty). Off: `judgeEnabled=false`.
- `goal_blocked({ goal_id, reason, evidence, repeated_turns })` — true impasse only (≥3 turns).

These tools are **registered always** but **active only while a user `/goal` is usable** (`active` or `budget_limited` wrap-up). Without `/goal`, they are stripped from the model-visible tool set (and their prompt snippets/guidelines). Goal mode is not an always-on agent capability.

## Config

| key | default | meaning |
|-----|---------|---------|
| `judgeEnabled` | `true` | Independent judge on complete |
| `judgeFailPolicy` | `fail-closed` | Judge transport/parse failure handling |
| `judgeModel` | `""` | `provider/model` or session model |
| `maxReact` | `12` | Cap on **judge rejections** before block |
| `maxContinuations` | `0` | Cap on automatic working turns; `0` = unlimited |
| `neverBlock` | `false` | Never auto-`blocked`; keep retrying |
| `judgeTranscriptChars` | `120000` | Transcript budget for judge |
| `continueDeferContextPercent` | `95` | Defer auto-continue when Pi context `%` ≥ this; `0` = off |

Legacy keys `piGoalUpstream` / `mimoUpstream` / `evolCacheDir` in an old config file are ignored.

## Status line

Footer row once a `/goal` has run (`◍ goal …`), persists after complete until next goal or `/goal clear`.

Format: `◍ goal <base> c<continuations>/<cap> [x<judgeRejects>/<cap>] [nb] [j:*] [defer:ctx N%]`

- `c3/∞` — automatic working turns
- `x2/12` — judge rejects (only if > 0)
- `nb` — never-block
- `j:ok` / `j:no` / `j:imp` / `j:err` / `j:off`
- `defer:ctx 119%` — auto-continue held for high context

### Counter semantics

- **`continuationCount`** — normal auto-continue turns (uncapped by default).
- **`judgeRejectCount`** — only judge rejections (`maxReact`).

### Never-block

`neverBlock=true`: judge impossible / caps degrade to keep working; non-retryable agent errors re-queue. Usage limits and `/goal pause` still stop; explicit `goal_blocked` still works.

### Compaction vs goal budget

- Context compact rescues the **window** (Pi). Goal `--tokens` stops **work**.
- Never cancel threshold/manual compact for budget exhaustion.
- Only intentional cancel: `budget_limited` + overflow **`willRetry`** (do not re-drive model after budget stop).
- Billable unit: `max(0, input - cacheRead) + output`; **`tokensUsed` is monotonic** (compact does not refill budget).
- Footer context `%` is **Pi core**, separate from goal budget.

### Context-pressure deferral

When Pi context `%` ≥ `continueDeferContextPercent` (default 95):

- hold automatic continuation
- best-effort `ctx.compact(...)`
- after **2** compact failures while deferred, stop auto-retrying compact and ask for manual `/compact` or a new session
- successful `session_compact` clears deferral and may re-queue continuation
- unknown/`null` percent does not defer (avoids stall right after compact)

## Design notes

| Area | Owner |
|------|--------|
| Orchestration | `src/goal.ts` |
| Types + quiet notify | `src/goal-types.ts` |
| Status line | `src/goal-status.ts` |
| Interrupt classification | `src/goal-interruptions.ts` |
| Compact/budget/defer policy | `src/compact-policy.ts` |
| Accounting | `src/accounting.ts` |
| Command parse | `src/command.ts` |
| Persistence | `src/persistence.ts` |
| Prompts | `src/prompts.ts` |
| Judge | `src/judge.ts` |
| Config | `src/config.ts` |
| Entry | `src/index.ts` (`/goal-config`) |
| Hook harness | `test/hook-harness.test.mjs` |

Single active goal only (no queue).

## Tests

```bash
cd ~/.pi/agent/extensions/hybrid-goal && npm test
```

## Lineage (historical)

Originally merged ideas from `@narumitw/pi-goal` and MiMo-Code Goal. The live package is **standalone** and does not ship upstream sync (`/goal-evol` removed).
