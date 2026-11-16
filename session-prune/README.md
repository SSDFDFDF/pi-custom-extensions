# session-prune

Pi extension that lets the **agent** (and the user) trim the *current session
context* down to the messages that still matter — the intentional "keep only
these" counterpart to compaction, which summarizes everything.

```text
/prune list                      see the numbered context rows
/prune drop role:toolResult      hide every tool result
/prune keep turns:1              keep only the last user turn
/prune undo                      put the last prune back
```

The agent gets the same power through the `session_prune` tool, so it can drop
noise as it works instead of waiting for a summary to swallow the whole thread.

## Loading (opt-in — nothing loads by default)

Pi discovers `~/.pi/agent/extensions/<dir>/index.ts` and directories whose
`package.json` declares a `pi.extensions` entry. This extension has **neither**
on purpose, so a normal `pi` session does not load it: no tool in the prompt, no
command, no handlers, no tokens spent.

Enable it when you want it:

```bash
# one session
pi -e ~/.pi/agent/extensions/session-prune/extension.ts

# handy alias
alias piprune='pi -e ~/.pi/agent/extensions/session-prune/extension.ts'
```

```json
// every session: add the file to settings.json
{ "extensions": ["~/.pi/agent/extensions/session-prune/extension.ts"] }
```

```bash
# one project (project-local extensions need project trust)
mkdir -p .pi/extensions
ln -s ~/.pi/agent/extensions/session-prune/extension.ts .pi/extensions/session-prune.ts
```

To make it load by default again, give it an `index.ts` entry (or add
`"pi": { "extensions": ["./extension.ts"] }` to `package.json`).

## Why this is not compaction

| | compaction | session-prune |
|---|---|---|
| what happens | the whole (older) conversation becomes one LLM summary | the *specified* messages are omitted, everything else stays verbatim |
| cost | an extra summarization request | none, purely local edits |
| reversibility | the raw messages stay on disk but leave the model context | any prune is restorable with `undo` |
| granularity | a cut point | per message, per tool result, per role, per regex |

## How it works (and why it is safe)

Pi's session format is an append-only tree and it ships the right primitive for
this: **`ContextEditEntry`**. `buildSessionProjection()` overlays those edits on
the raw entries to produce the exact message list a provider request uses, while
history, the transcript, exports and cost accounting keep every raw message.

So a prune appends, in one batch:

1. a `custom` **ledger entry** (`customType: "session-prune"`) recording what it
   did — that is what `undo` reads, so it never guesses which edits were ours;
2. one `context_edit` per changed message: `replacement: null` omits it, a
   replacement resets its content (used to restore);
3. a short `custom_message` **marker** so the model knows the context was
   trimmed and how to undo it (`marker: false` disables it).

Nothing is deleted, edits are branch-relative (navigating in `/tree` before a
prune reveals the original messages again), and compaction keeps working: it
summarizes the *projected*, trimmed context and recomputes `tokensBefore` from it.

### Pairing and protection rules

Trimming must never produce a transcript a provider rejects, so the planner
enforces:

- **tool calls and their results travel together** — hiding a result removes the
  call from the assistant message (its text is kept); hiding an assistant message
  hides its orphan results; a message whose calls are all gone loses the empty
  shell; `restore` re-inserts the call block from the stored original content;
- **the running turn is protected** — the assistant message that called
  `session_prune` and its own result are never hidden (they may lose sibling
  calls), and a nested call (from codemode) protects the whole current user turn;
- **the newest user message is never hidden by a whitelist** (`keep`), so a
  "keep only what I name" request cannot silently delete the task;
- **non-editable entries** (compaction checkpoints/summaries, branch summaries,
  `bashExecution` messages, the system prompt) are listed but never touched.

As a last line of defence, Pi's `turn_end` boundary reports the entries of the
finishing turn. If a plan would omit one of them anyway, the whole batch is
refused (a note goes into the context) instead of being applied partially — a
half-applied plan could leave a tool result without its call.

## Agent tool: `session_prune`

| action | what it does |
|---|---|
| `list` | numbered context rows: id, state (`live`/`hidden`/`locked`), role, tokens, preview, plus a `snapshot` number |
| `apply` | `keep` (whitelist), `restore` (put back with original content), `drop` (blacklist, wins) with optional `dryRun`, `note`, `snapshot` |
| `undo` | restore the newest prune, or the one named by `opId` |
| `status` | config, live/hidden counts, prune history |

Selectors are the same JSON shape everywhere: **fields AND, arrays OR**.

```json
{ "drop": { "roles": ["toolResult"] } }
{ "keep": { "turns": 1 } }
{ "keep": { "indices": [-4, -3, -2, -1] } }
{ "drop": { "tools": ["read"], "match": "node_modules" } }
{ "restore": { "entryIds": ["a1b2c3"] } }
```

Fields: `entryIds` (prefixes allowed), `indices` (negative counts from the end),
`range`, `roles`, `tools`, `match` (regex over the preview), `lastMessages`,
`turns`, `beforeIndex`, `afterIndex`.

`apply` lands at the end of the current turn through Pi's `turn_end` boundary —
the documented way for an extension to append context edits — so the very next
model request already sees the trimmed context. The `snapshot` number from
`list` is accepted by `apply` and rejects stale row numbers after another prune.

## Command: `/prune`

```
/prune list [N] [text:…]      show context rows (default 20)
/prune keep <selector…>       hide everything the selector does not name
/prune drop <selector…>       hide matching rows
/prune restore <selector…>    put rows back with their original content
/prune undo [opId]            undo the newest prune
/prune status
/prune help
```

Selectors are space-separated tokens (space = AND, comma = OR):

```
id:abc123,def456     entry ids from the listing (prefixes work)
#3  #3-7  #-3        row numbers, ranges, negative from the end
role:toolResult,user
tool:read,grep       tool results of these tools, or calls to them
text:/regex/         match the message preview (text:word is literal)
last:5               the last 5 rows
turns:2              from the second-last user message onwards
before:#5 after:#5   rows before/after a row number
```

The command waits for the agent to go idle, shows a diff-style preview and asks
for confirmation before writing. Unlike the tool it writes the edits directly to
the session (there is no turn boundary while idle); model requests always read
the rebuilt projection, so the next prompt already sees the result.

## Config

`~/.pi/agent/session-prune.config.json` (created with defaults on first use):

```json
{
  "marker": true,
  "previewChars": 90,
  "maxListed": 60,
  "protectLastUser": true
}
```

- `marker` — append the model-visible `[session-prune] …` notice after a prune.
- `previewChars` — characters of each message in the listing.
- `maxListed` — rows shown by `list` when `all` is not set.
- `protectLastUser` — never hide the newest user message in whitelist mode.

## Notes & limits

- **This is a soft trim**: raw history is kept on purpose so prunes stay
  reversible and `/tree` navigation stays coherent. It saves context tokens, not
  disk. If you want the file itself rewritten, that is a different operation
  (see `session-error-clean`); it is only safe for idle sessions.
- A prune is invisible in the transcript by design (the TUI keeps showing raw
  entries); the ledger row renders as `[prune …] hid N row(s)` and the marker
  appears in the model context.
- Undo restores the entries recorded by that prune. If you later prune the same
  entries again, the newest edit wins — undo the newer operation first.
- Auto-compaction may still fire on a trimmed context; that is intentional, the
  trim only removes what you asked it to. A summary also replaces the entries
  before its cut, so undoing a prune that happened before a compaction may report
  a restore that is already outside the context window.

## Development

```bash
npm test       # node:test via jiti (this Node build has no type stripping)
               # the wiring test loads extension.ts, so it runs without Pi
npm run check  # syntax check every source file
npm run typecheck  # needs a tsc on PATH (tested with TypeScript 7); tsconfig.json ships here
```
