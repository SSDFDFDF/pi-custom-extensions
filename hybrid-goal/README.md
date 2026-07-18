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
/goal-evol apply          # confirm, backup, rewrite apply-safe modules only
/goal-evol apply --force
/goal-evol config
/goal-evol config judgeEnabled=true maxReact=12 judgeFailPolicy=fail-closed
/goal-evol config neverBlock=true          # never auto-block; retry forever (flaky net)
/goal-evol config maxContinuations=0        # 0 = unlimited normal working turns
/goal-evol-reload         # reload extensions after apply
```

**Apply safety**

- Never touches `~/.pi/agent/npm/*`.
- Auto-apply only maps pure shared helpers currently safe to overwrite (`src/accounting.ts`).
- Does **not** overwrite hybrid runtime or forks: `goal.ts`, `command.ts`, `persistence.ts`, `judge.ts`, `evolve.ts`, `config.ts`, `prompts.ts`, `index.ts`.
- Upstream modular pi-goal (`runtime` / `queue` / `settings` / composition `goal.ts`) is cached under `cache/upstream-snapshots/` for review only — not merged live.
- There is no live `src/goal-base.ts` snapshot; use evol cache for upstream diffs.
- Writes backups under `cache/backups/`.
- Runs `npm test` after apply; if tests fail, applied files are rolled back from the backup.
- After check/apply, prunes evol cache to bounds: newest 3 snapshot dirs (+ current), 10 `reports/evol-*.json`, 5 backup dirs. `repos/` clones and `latest-report.*` are kept.
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
has run. Prefixed with a colored `◉goal` marker and **persists after completion**
until the next goal starts or `/goal clear`.

Format: `◉goal <base> c<continuations>/<cap> [x<judgeRejects>/<cap>] [nb] [j:*]`

Colors (theme-aware): `◉` uses a contrasting color (`success`, or `accent` when
status text is already `success`); status text `accent` while active, `success`
on complete/`j:ok`, `warning` on paused/budget/usage/`j:no`, `error` on
blocked/`j:imp`/`j:err`, `dim` for `j:off`, `muted` for counters.

- `◉goal` — always-present prefix (`◉` + `goal`, no space) so the row is easy to spot.
- `c3/∞` — 3 automatic working turns, unlimited cap (default).
- `c3/50` — capped at `maxContinuations=50`.
- `x2/12` — judge rejected completion twice (cap `maxReact=12`); only shown when > 0.
- `nb` — never-block mode on.
- `j:ok` / `j:no` / `j:imp` / `j:err` / `j:off` — last judge verdict.

Examples: `◉goal active 3m c2/∞`, `◉goal active 18k/100k c1/∞ x1/12 j:no`,
`◉goal blocked c50/50`, `◉goal complete` (stays until next goal).

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

### Ownership model (single-goal)

Hybrid is a **single active goal** product. Live runtime is **not** a thin wrapper over upstream `pi-goal` modules:

| Area | Owner | Notes |
|------|--------|--------|
| Lifecycle + tools + events | hybrid `src/goal.ts` | Continuations, budget wrap-up, stale `goal_id`, status line |
| `/goal` parse / completions | hybrid `src/command.ts` | Single-goal only (`start/edit/pause/resume/clear/status`) |
| Session snapshot load/save | hybrid `src/persistence.ts` | `{ goal }` only — no ordered queue |
| Prompts + `GoalStatus` | hybrid `src/prompts.ts` | No `queued` status |
| Independent judge | hybrid `src/judge.ts` | MiMo-style cold verify |
| Config | hybrid `src/config.ts` + `hybrid-goal.config.json` | |
| Shared token helpers | `src/accounting.ts` | Only module auto-applied by `/goal-evol apply` |
| Evol tooling | `src/evolve.ts`, `src/evol-cache.ts` | Check/snapshot/apply gate |

There is **no** live `src/goal-base.ts`. Upstream composition/runtime/queue/settings live only under `cache/upstream-snapshots/` (review). Experimental ordered goals from upstream are **not** wired.

### Capability lineage

| Concern | Source |
|---------|--------|
| Continuation + settled dispatch | pi-goal lineage (reimplemented in hybrid `goal.ts`) |
| Budget wrap-up | pi-goal lineage |
| Stale tool / goal_id rotation | pi-goal lineage |
| Cold independent judge | MiMo |
| Bounded judge-reject retry (`maxReact`) | MiMo |
| Split continuation vs judge-reject counters | hybrid |
| Never-block retry mode | hybrid |
| fail-open/closed policy | hybrid (default closed) |
| Self-evolution (review + narrow apply) | hybrid `/goal-evol` |

Judge reads `sessionManager.buildSessionContext()` → `convertToLlm` → `serializeConversation`, same spirit as MiMo transcript verification.

### Session runtime cleanup

On `session_shutdown`, hybrid-goal flushes any dirty goal snapshot, then drops process-local continuation/recovery/verdict/persist caches and footer status. Session JSONL history is not rewritten or GC'd.

### Optional planning tools

Goal mode owns **lifecycle** (continue / pause / complete / block / judge). It does **not** ship or require a checklist extension.

If the session happens to expose structured planning tools (any package), goal prompts soft-encourage using them for multi-step work and keep “checklist progress ≠ goal complete.” If those tools are absent, the agent should keep going with ordinary notes or files—no package name is hard-coded, so removing a plan/task extension never breaks hybrid-goal.

## Development

```bash
cd ~/.pi/agent/extensions/hybrid-goal
npm install   # typebox
npm test      # node --experimental-strip-types --test ./test/*.test.mjs
```

### Live package layout

```text
src/
  index.ts         # extension entry + /goal-evol
  goal.ts          # live single-goal runtime
  command.ts       # hybrid-owned parser
  persistence.ts   # hybrid-owned session goal snapshot
  prompts.ts       # hybrid prompts + GoalStatus
  judge.ts         # independent completion judge
  accounting.ts    # shared token helpers (apply-safe)
  config.ts        # hybrid-goal.config.json
  evolve.ts        # /goal-evol check|apply
  evol-cache.ts    # cache prune bounds
```

Do not reintroduce a live `goal-base.ts` snapshot; use `cache/repos/` and `cache/upstream-snapshots/` for upstream diffs.
