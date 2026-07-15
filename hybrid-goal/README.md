# hybrid-goal

Hybrid Pi goal extension that merges:

1. **`@narumitw/pi-goal`** — session-scoped `/goal` continuation state machine (pause/resume, token budget, stale-turn guards, settled auto-continue).
2. **MiMo-Code Goal** — independent **judge** model on completion + separate hard caps for judge rejections and auto-continuations, with an optional **never-block** mode for flaky networks.
3. **`/goal-evol`** — controlled self-evolution from upstream pi-goal + MiMo-Code sources.

## Install (this machine)

Already placed at:

```text
~/.pi/agent/extensions/hybrid-goal/
```

Pi auto-discovers `~/.pi/agent/extensions/*/index.ts` via package `pi.extensions`.

**Disable the old package** so commands/tools do not double-register:

```json
// ~/.pi/agent/settings.json packages — remove or leave disabled:
// "npm:@narumitw/pi-goal"
```

Then `/reload` or restart `pi`.

## Commands

### `/goal` (from pi-goal lineage)

```text
/goal <objective>
/goal --tokens 100k <objective>
/goal edit|pause|resume|clear
```

### Tools

- `goal_complete({ goal_id, summary })` — after local checks, runs an **independent judge** on the transcript to reject optimistic completions. Judge is **on by default** and uses the current session model when `judgeModel` is empty (no extra config needed). Turn it off with `judgeEnabled=false`.
- `goal_blocked({ goal_id, reason, evidence, repeated_turns })` — true impasse only (≥3 turns).

### `/goal-evol` (new)

```text
/goal-evol status
/goal-evol check          # fetch upstream clones, write cache/latest-report.md
/goal-evol apply          # confirm, backup, rewrite base modules only
/goal-evol apply --force
/goal-evol config
/goal-evol config judgeEnabled=true maxReact=12 judgeFailPolicy=fail-closed
/goal-evol config neverBlock=true          # never auto-block; retry forever (flaky net)
/goal-evol config maxContinuations=0        # 0 = unlimited normal working turns
/goal-evol-reload         # reload extensions after apply
```

**Apply safety**

- Never touches `~/.pi/agent/npm/*`.
- Only rewrites mapped **base** modules from upstream pi-goal.
- Does **not** overwrite hybrid layers: `index.ts`, `judge.ts`, `evolve.ts`, `config.ts`.
- Writes backups under `cache/backups/`.
- Requires explicit confirmation.

## Config

`~/.pi/agent/hybrid-goal.config.json` (auto-created on first `config` write):

| key | default | meaning |
|-----|---------|---------|
| `judgeEnabled` | `true` | Run independent judge on complete (uses session model when `judgeModel` empty) |
| `judgeFailPolicy` | `fail-closed` | `fail-closed` rejects on judge errors; `fail-open` allows complete (MiMo-like) |
| `judgeModel` | `""` | `provider/model` or empty = session model |
| `maxReact` | `12` | Cap on **judge rejections** before block (not normal turns) |
| `maxContinuations` | `0` | Cap on **automatic working turns**; `0` = unlimited |
| `neverBlock` | `false` | Never auto-transition to `blocked`; keep retrying (good for flaky networks). Explicit `goal_blocked` still works. |
| `judgeTranscriptChars` | `120000` | Transcript budget for judge |
| `piGoalUpstream` | narumiruna/pi-extensions | git URL |
| `mimoUpstream` | XiaomiMiMo/MiMo-Code | git URL |

## Status line

Shown in the footer (extension status line, below the model row) once a `/goal`
has run. Prefixed with a colored `◆ goal` marker and **persists after completion**
until the next goal starts or `/goal clear`.

Format: `◆ goal <base> c<continuations>/<cap> [x<judgeRejects>/<cap>] [nb] [j:*]`

Colors (theme-aware): `accent` while active, `success` on complete/`j:ok`,
`warning` on paused/budget/usage/`j:no`, `error` on blocked/`j:imp`/`j:err`,
`dim` for `j:off`, `muted` for counters.

- `◆ goal` — always-present prefix so the row is easy to spot.
- `c3/∞` — 3 automatic working turns, unlimited cap (default).
- `c3/50` — capped at `maxContinuations=50`.
- `x2/12` — judge rejected completion twice (cap `maxReact=12`); only shown when > 0.
- `nb` — never-block mode on.
- `j:ok` / `j:no` / `j:imp` / `j:err` / `j:off` — last judge verdict.

Examples: `◆ goal active 3m c2/∞`, `◆ goal active 18k/100k c1/∞ x1/12 j:no`,
`◆ goal blocked c50/50`, `◆ goal complete` (stays until next goal).

> Pi renders extension statuses on their own footer line, not inline with the
> model name. Putting it literally beside the model would require replacing the
> entire footer via `setFooter` (fragile; re-implements token/context/git stats),
> so hybrid-goal uses the standard colored status row instead.

### Counter semantics (why two counters)

pi-goal calls its continuation path on **every** normal working turn. Folding
that into MiMo's `MAX_GOAL_REACT` would block any goal needing more than N
turns even with zero judge rejections. So hybrid-goal splits them:

- **`continuationCount`** — normal auto-continue turns. Uncapped by default so long tasks run to completion.
- **`judgeRejectCount`** — only increments when the independent judge rejects a `goal_complete`. This is the MiMo-style bounded verify/retry loop (`maxReact`).

### Never-block mode

`neverBlock=true` makes the goal retry forever instead of entering `blocked`:

- judge `impossible` → treated as a normal rejection, keep working;
- `maxReact` / `maxContinuations` caps → ignored (no hard stop);
- non-retryable agent errors → re-queued as a continuation instead of blocking.

Usage limits and user `/goal pause` still stop (hard external caps / explicit
intent), and the agent can still call `goal_blocked` deliberately. Use this when
transient network/provider failures should never end a long run.

## Design notes

| Concern | Source |
|---------|--------|
| Continuation + settled dispatch | pi-goal |
| Budget wrap-up | pi-goal |
| Stale tool / goal_id rotation | pi-goal |
| Cold independent judge | MiMo |
| Bounded judge-reject retry (`maxReact`) | MiMo |
| Split continuation vs judge-reject counters | hybrid |
| Never-block retry mode | hybrid |
| fail-open/closed policy | hybrid (default closed) |
| Self-evolution | hybrid `/goal-evol` |

Judge reads `sessionManager.buildSessionContext()` → `convertToLlm` → `serializeConversation`, same spirit as MiMo transcript verification.

## Development

```bash
cd ~/.pi/agent/extensions/hybrid-goal
npm install   # typebox
node --test ./test/*.test.mjs
```
