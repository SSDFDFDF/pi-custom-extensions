# pi-bte — Board & Task Extension

Structured checklist tools for Pi agents. **No plan mode, no tool locks, no goal binding.**

## Default path (simple)

```text
task create / update / list     ← primary
checklist                       ← open or fully rewrite a list (rare)
```

## Advanced: multi-board

```text
board create | switch | list    ← optional named boards
task.boardId / checklist.boardId
board_doc                       ← optional design notes on a board
```

## Model

```text
tasks[]           flat checklist items (work alone)
boards[]          optional containers (id b1, b2, …)
activeBoardId?    default scope when set
task.boardId?     optional link to a board
```

Rules:

- At most one `in_progress` **per scope** (per board, or among standalone tasks).
- `checklist` is a **full replace** of one scope; omitted steps are deleted; **empty list rejected** (use `task clear`).
- No hybrid-goal coupling.

## Tools

| Tool | Role |
|------|------|
| **task** | Primary: create / update / get / list / clear |
| **checklist** | Full replace of one scope (`items[]`, non-empty) |
| **board** | Optional multi-board CRUD |
| **board_doc** | Optional markdown on a board |

### Scope (`boardId`)

| Value | Meaning |
|-------|---------|
| omit | active board, or standalone if none |
| `bN` | that board |
| `""` / `none` / `standalone` | standalone tasks |
| `*` / `all` | list/clear only: all tasks |

### `checklist` example

```json
{
  "boardId": "b1",
  "explanation": "Auth milestone",
  "items": [
    { "id": "t1", "step": "Map auth", "status": "completed" },
    { "step": "Add tests", "status": "pending" }
  ]
}
```

### Tool `details`

| Field | Meaning |
|-------|---------|
| `tasks` | **Full** task list (all scopes) — required for session reconstruction |
| `scopedTasks` | Active/default scope, **or** the scope of a `task list` call |
| `focusTasks` / `focusBoardId` / `removedCount` | Last checklist write (or list focus) |
| `explanation` | **Scope display note**: active board’s `note`, or standalone `state.note` when no active board; tool may override |
| `note` | **Standalone-only** persisted note (`state.note`); may be set even when a board is active — do **not** treat as the active board’s caption |
| `boards` / `activeBoardId` / sequences / `doc` | Board metadata |

Prefer **`explanation`** for “what note to show for this result.” Use **`note`** only if you need the standalone-scope persisted field.

## Command

```text
/bte status|show
/bte boards
/bte clear [--all] [--doc]
/bte config [key=value]
```

## UI

- Footer: board id + `done/total`
- Widget: `board: b1 Auth` + `[x] t1 …`

## Persistence

Session custom entry `bte-state` + tool-result `details`. Rebuilt from the active branch.

Config: `~/.pi/agent/pi-bte.config.json`

```json
{ "injectContext": true, "showWidget": true, "widgetMaxTasks": 12 }
```

## Install

```bash
cd ~/.pi/agent/extensions/pi-bte
npm install
npm test
```

`/reload` or restart Pi after changes.
