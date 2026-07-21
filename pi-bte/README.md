# pi-bte — Board & Task Extension

Structured task/board tools for Pi agents. **No plan mode, no tool locks, no goal binding.**

## Default path

```text
task create / update / list   ← primary (writes use items[])
```

## Advanced: multi-board

```text
board create | switch | list    ← optional named boards
task.boardId
board_doc                       ← optional design notes on a board
```

## Model

```text
tasks[]           flat task items (work alone)
boards[]          optional containers (id b1, b2, …)
activeBoardId?    default scope when set
task.boardId?     optional link to a board
```

Rules:

- At most one `in_progress` **per scope** (per board, or among standalone tasks).
- **All write shapes use `items[]` only** (length 1 = single item). No parallel single-field create/update.
- `create` = **append** (never deletes).
- `update` = **patch by taskId** (omitted tasks kept; `status:"deleted"` removes a task).
- `clear` = **wipe a scope** (the only bulk delete).
- No hybrid-goal coupling.

## Tools

| Tool | Role |
|------|------|
| **task** | Primary: create / update / get / list / clear |
| **board** | Optional multi-board CRUD |
| **board_doc** | Optional markdown on a board |

### Scope (`boardId`)

| Value | Meaning |
|-------|---------|
| omit | active board, or standalone if none |
| `bN` | that board |
| `""` / `none` / `standalone` | standalone tasks |
| `*` / `all` | list/clear only: all tasks |

### `task create` (append)

```json
{
  "action": "create",
  "items": [
    { "subject": "Map auth", "status": "pending" },
    { "subject": "Add tests", "status": "in_progress" }
  ]
}
```

### `task update` (patch)

```json
{
  "action": "update",
  "items": [
    { "taskId": "t1", "status": "completed" },
    { "taskId": "t2", "status": "in_progress" }
  ]
}
```

### `task update` (delete)

Removal is an explicit patch — set `status` to `deleted`:

```json
{
  "action": "update",
  "items": [
    { "taskId": "t3", "status": "deleted" }
  ]
}
```

To wipe a whole scope, use `task clear` (optionally `boardId`).

### Tool `details`

| Field | Meaning |
|-------|---------|
| `tasks` | **Full** task list (all scopes) — required for session reconstruction |
| `scopedTasks` | Active/default scope, **or** the scope of a `task list` call |
| `focusTasks` / `focusBoardId` | Last write focus |
| `boards` / `activeBoardId` / sequences / `doc` | Board metadata |

## Command

```text
/bte status|show
/bte boards
/bte clear [--all] [--doc]
/bte config [key=value]
```

## UI

- Footer: board id + `done/total`
- Widget: `board: b1 Auth` + prioritized tasks (see below)

### Widget layout (≤10 lines total)

Pi hard-caps each extension widget at **10 lines**. bte uses that budget only (no extra soft cap):

```text
[0–1] board: b1 Auth · +1 boards
[0–N] tasks (normal list order)
[0–1] … 3 done not shown
```

- Multi-board hint stays on the **same** header line (`· +N boards`).
- Over budget: squeeze **finished** first (small ids first); open tasks keep order; then drop open **tail**.
- Footer is **display hide** (`not shown`), not “more work”.

Full list: `/bte status` or `task list` (not limited to the widget).

```text
/bte config showWidget=false
```

## Persistence

Session custom entry `bte-state` + tool-result `details`. Rebuilt from the active branch.

Config: `~/.pi/agent/pi-bte.config.json`

```json
{ "injectContext": true, "showWidget": true }
```

## Install

```bash
cd ~/.pi/agent/extensions/pi-bte
npm install
npm test
```

`/reload` or restart Pi after changes.
