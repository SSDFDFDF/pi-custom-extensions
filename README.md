# pi-custom-extensions

Personal custom extensions for the [pi coding agent](https://pi.dev), living in
`~/.pi/agent/extensions/`. This repo is a backup of hand-written extensions only;
npm/git package extensions declared in `settings.json` are not tracked here.

## Extensions

| Extension | Type | Purpose |
|-----------|------|---------|
| `client-mimic/` | dir | Rewrites outgoing provider headers/body to mimic Codex CLI / Claude Code, and owns system-prompt transformation (neutral rewrite or per-profile prompt files). Supersedes the former `neutral-system-prompt.ts`. |
| `kun-retry/` | dir | Configurable retry: override built-in retry count/backoff, extra HTTP status codes and error patterns, stall watchdog, and `/retry-nl` unlimited mode. |
| `session-error-clean/` | dir | Removes persisted error entries and encrypted reasoning signatures (`thinkingSignature`, `\|fc_*`, `msg_*`) from session files with `ctx.switchSession()` live reload, plus outbound Responses `before_provider_request` reasoning compatibility guard (`/clean-errors`). |
| `hybrid-goal/` | dir | Goal-mode state machine (pi-goal lineage) + independent judge + `/goal-evol` self-evolution. |
| `pi-channels/` | dir | Multi-channel companion (Telegram first): queue, progress drafts, media, attach, connect lock. Replaces `@llblab/pi-telegram`. |

## Layout

```
~/.pi/agent/extensions/
├── client-mimic/
│   ├── index.ts
│   ├── prompts/
│   └── src/
├── kun-retry/
│   ├── index.ts
│   ├── src/
│   └── test/
├── session-error-clean/
│   ├── index.ts
│   ├── src/
│   └── test/
├── hybrid-goal/
│   ├── index.ts
│   ├── src/
│   └── test/
└── pi-channels/
    ├── index.ts                 # Pi discovery entry
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
