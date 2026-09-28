# session-error-clean

Pi extension that removes persisted **error entries** from pi session files —
assistant messages with `stopReason: "error"` such as the 503 bursts kun-retry's
`/retry-nl` can leave behind. pi's session format is an append-only JSONL tree
and pi itself offers no API to delete entries, so this extension rewrites the
session file directly:

- matched error entries are dropped
- every surviving entry's `parentId` is relinked to its nearest surviving
  ancestor (chains of consecutive errors collapse cleanly)
- the file is rewritten atomically (`.clean-tmp` + rename), optionally with a
  `.jsonl.bak` backup (default on)
- for the **current** session, `/clean-errors` also reloads the cleaned file
  into the live agent via `ctx.switchSession()`, so the in-memory context drops
  the errors too

Verified against pi's own `SessionManager`: a cleaned file loads with the
original session id, a valid leaf pointer, and an error-free context.

## Commands

```
/clean-errors              default: clean current session file + reload live context
/clean-errors help         usage
/clean-errors dry          preview what would be removed (no write)
/clean-errors <id-prefix>  clean another session file by session-id prefix
                           (looked up under ~/.pi/agent/sessions/**)
/clean-errors pattern <re> default regex filter on errorMessage, e.g. 503
                           ('' = all error entries)
/clean-errors auto on|off  auto-clean the file on session_start (file-level;
                           live context needs /clean-errors or a resume)
/clean-errors status       show config
```

`dry`, `pattern`, and `auto` all compose with the id-prefix form except `dry`,
which previews the current session only.

## Config

`~/.pi/agent/session-error-clean.config.json`:

```json
{
  "autoClean": false,
  "pattern": "",
  "backup": true
}
```

- `autoClean` — rewrite the current session file on `session_start` when it
  contains error entries. File-only: the in-memory context still contains the
  errors until `/clean-errors` (which reloads) or the next session resume.
- `pattern` — default `errorMessage` regex filter. Empty removes every error
  entry; `503` removes only those mentioning 503.
- `backup` — write `<file>.bak` before rewriting.

## Notes & limits

- Only `stopReason: "error"` assistant messages are ever removed; aborted and
  normal messages are never touched.
- The id-prefix lookup matches `_<id>.jsonl` suffixes exactly first, then
  falls back to substring matches (ambiguous prefixes are rejected).
- Cleaning another session's file while some pi instance still has it open is
  safe for the file (pi appends by path, no long-held fd), but that instance's
  in-memory tree may write removed entries back on branch/label operations.
  Clean idle sessions when possible.
- `/clean-errors` needs `ctx.switchSession` (TUI/RPC command contexts). In
  other modes the file is still cleaned; the live context refresh waits for
  the next resume.

## Development

```
npm run check   # node --experimental-strip-types --check on all sources
npm test        # node:test over test/*.mjs (needs node with TS support,
                # or bundle first: esbuild test/clean.test.mjs --bundle
                # --platform=node --format=esm --outfile=/tmp/t.mjs && node --test /tmp/t.mjs)
```
