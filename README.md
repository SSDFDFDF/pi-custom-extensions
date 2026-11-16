# pi-custom-extensions

Personal custom extensions for the [pi coding agent](https://pi.dev), living in
`~/.pi/agent/extensions/`. This repo is a backup of hand-written extensions only;
npm/git package extensions declared in `settings.json` are not tracked here.
Extensions here are auto-loaded by directory discovery unless they opt out;
`session-prune/` opts out (see its README) and is loaded explicitly.

## Extensions

| Extension | Type | Purpose |
|-----------|------|---------|
| `client-mimic/` | dir | Rewrites outgoing provider headers/body to mimic Codex CLI / Claude Code, and owns system-prompt transformation (neutral rewrite or per-profile prompt files). Supersedes the former `neutral-system-prompt.ts`. |
| `kun-retry/` | dir | Configurable retry: override built-in retry count/backoff, extra HTTP status codes and error patterns, stall watchdog, and `/retry-nl` unlimited mode. |
| `session-error-clean/` | dir | Removes persisted error entries and encrypted reasoning signatures (`thinkingSignature`, `\|fc_*`, `msg_*`) from session files with `ctx.switchSession()` live reload, plus outbound Responses `before_provider_request` reasoning compatibility guard (`/clean-errors`). |
| `hybrid-goal/` | dir | Goal-mode state machine (pi-goal lineage) + independent judge + `/goal-evol` self-evolution. |
| `pi-channels/` | dir | Multi-channel companion (Telegram first): queue, progress drafts, media, attach, connect lock. Replaces `@llblab/pi-telegram`. |
| `prompt-cache-key/` | dir | Session-affinity `X-Session-ID` header on every provider request (default on), plus an opt-in `prompt_cache_key` body field for OpenAI-compatible Chat Completions endpoints, with per-provider auto-disable when a gateway rejects a parameter. |
| `session-prune/` | dir (**opt-in**) | Trim the current session context to the messages that still matter: the `session_prune` agent tool + `/prune` command on top of append-only `ContextEditEntry`s (targeted pruning instead of compaction, with undo and tool-call/result safety). **Not auto-discovered** — no `index.ts` and no `pi.extensions` manifest; load it per session with `pi -e ~/.pi/agent/extensions/session-prune/extension.ts`. |

## Layout

Package structure (形态 A, consistent across multi-file extensions):
`package.json` with `pi.extensions: ["./src/index.ts"]` is the single entry —
no root `index.ts` shim (the manifest wins over `index.ts` during discovery,
so a shim is dead code). `session-prune` and `pi-channels` keep their own
special layouts on purpose.

```
~/.pi/agent/extensions/
├── client-mimic/
│   ├── package.json
│   ├── prompts/
│   └── src/
├── prompt-cache-key/
│   ├── index.ts              # pi hooks + /prompt-cache
│   ├── config.ts             # config load/save, presets, provider filters
│   └── test/                 # node:test + esbuild runner (no --strip-types needed)
├── session-prune/
│   ├── extension.ts          # pi hooks + session_prune tool + /prune command
│   │                         #   (named extension.ts on purpose: not discovered)
│   ├── src/plan.ts           # pure planner: selectors + pairing closure
│   ├── src/rows.ts           # session projection -> planner rows
│   ├── src/ops.ts            # ledger records, drafts, undo, appending
│   └── test/                 # node:test via jiti (real SessionManager)
├── kun-retry/
│   ├── package.json
│   ├── src/
│   └── test/
├── session-error-clean/
│   ├── package.json
│   ├── src/
│   └── test/
├── hybrid-goal/
│   ├── index.ts
│   ├── src/
│   └── test/
└── pi-channels/
    ├── index.ts                 # Pi discovery entry (manifest: ./index.ts)
    ├── packages/core/           # channel-agnostic runtime
    ├── packages/telegram/       # Telegram adapter
    └── packages/extension/      # Pi commands/tools wiring
```

Example per-profile prompt files for `client-mimic`'s file mode live inside the
repo at `client-mimic/prompts/` (`codex.md`, `claude-code.md`), so they back up
and restore with the repo. Reference them from the config with a path relative
to `~/.pi/agent`, e.g. `extensions/client-mimic/prompts/codex.md`.

## Not tracked

`node_modules/`, `cache/`, build output, and any secret files (`auth.json`,
`telegram.json`, `channels.json`, `*.key`, `*.pem`, `.env*`) are excluded via `.gitignore`.

## Restore on a new machine

```bash
git clone <this-repo> ~/.pi/agent/extensions
cd ~/.pi/agent/extensions/hybrid-goal && npm install   # if deps are needed
```

Then declare package extensions in `~/.pi/agent/settings.json` as usual.

`pi-channels` needs no npm install (relative TS imports). Configure
`~/.pi/agent/channels.json`, then `/channel-setup` / `/channel-connect`.
