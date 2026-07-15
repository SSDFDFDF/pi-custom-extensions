# pi-custom-extensions

Personal custom extensions for the [pi coding agent](https://pi.dev), living in
`~/.pi/agent/extensions/`. This repo is a backup of hand-written extensions only;
npm/git package extensions declared in `settings.json` are not tracked here.

## Extensions

| Extension | Type | Purpose |
|-----------|------|---------|
| `neutral-system-prompt.ts` | file | Rewrites the built-in system prompt intro to the "kun / π" identity. |
| `kun-retry/` | dir | Configurable retry: override built-in retry count/backoff, extra HTTP status codes and error patterns, stall watchdog, and `/retry-nl` unlimited mode. |
| `hybrid-goal/` | dir | Goal-mode state machine (pi-goal lineage) + independent judge + `/goal-evol` self-evolution. |

## Layout

```
~/.pi/agent/extensions/
├── neutral-system-prompt.ts
├── kun-retry/
│   ├── index.ts
│   ├── src/
│   └── test/
└── hybrid-goal/
    ├── index.ts
    ├── src/
    └── test/
```

## Not tracked

`node_modules/`, `cache/`, build output, and any secret files (`auth.json`,
`telegram.json`, `*.key`, `*.pem`, `.env*`) are excluded via `.gitignore`.

## Restore on a new machine

```bash
git clone <this-repo> ~/.pi/agent/extensions
cd ~/.pi/agent/extensions/hybrid-goal && npm install   # if deps are needed
```

Then declare package extensions in `~/.pi/agent/settings.json` as usual.
