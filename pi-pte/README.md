# pi-pte — Plan-Task Extension

Structured plan/task tools for Pi agents. This package does **not** implement a plan mode, restrict file or shell tools, or control agent continuation.

Inspired by:

- OpenAI Codex `update_plan`: replace the full checklist and allow at most one `in_progress` step.
- Claude Code task tools: create, update, read, list, and delete individual tasks.
- Codex ExecPlans: optionally keep a living markdown plan alongside the executable checklist.

## Scope

```text
optional goal lifecycle extension  -> continue / pause / verify / complete
pi-pte                            -> structured plan and task state
Pi built-in tools                 -> read / edit / write / bash
```

`pi-pte` owns only the middle layer. It has no dependency on a goal extension, and goal extensions do not need to depend on it.

## Tools

### `update_plan`

Replaces the complete checklist:

```json
{
  "explanation": "Implementing refresh token support",
  "plan": [
    { "step": "Map the current auth flow", "status": "completed" },
    { "step": "Add refresh-token rotation", "status": "in_progress" },
    { "step": "Add integration tests", "status": "pending" }
  ]
}
```

Statuses: `pending`, `in_progress`, `completed`, `cancelled`.

Rules:

- At most one item can be `in_progress`.
- Matching step text preserves stable task ids across full replacements.
- Omitted tasks are removed; dependency references to removed tasks are pruned.

### `task`

Granular task operations:

- `create`: `subject`, optional `description`, `activeForm`, status and dependency ids.
- `update`: `taskId` plus fields to patch. Set `status: "deleted"` to remove the task.
- `get`: read one task by id.
- `list`: read the complete board.
- `clear`: remove all tasks.

Task ids are session-scoped (`t1`, `t2`, ...). At most one task may be `in_progress`.

### `plan_doc`

Stores a living markdown design document independently from the checklist:

- `get`
- `set` with optional `title` and required `body`
- `clear`

Use this for design context, decisions, acceptance criteria, and discoveries. Use `update_plan` or `task` for executable progress.

## Command

```text
/pte                 # same as status
/pte status          # show current board
/pte show            # show current board
/pte clear           # clear tasks
/pte clear --doc     # clear tasks and living plan
/pte config          # show configuration
/pte config key=value
```

There is no `/plan`, `/todos`, mode flag, shortcut, or shell guard.

## UI

When tasks exist, the extension shows:

- a footer status (`completed/total`, plus active count), and
- a task widget above the editor.

The current board and plan document are injected into the per-turn system prompt.

On `session_shutdown`, UI status/widget and process-local persist fingerprints are cleared. Task state remains in the session JSONL for resume.

## Persistence and branching

State is stored in session custom entries (`pte-state`) and repeated in tool-result `details`. On session start and tree navigation, state is reconstructed chronologically from the active branch. This makes task state follow Pi branches instead of using a global file.

Only configuration is global:

```json
{
  "injectContext": true,
  "showWidget": true,
  "widgetMaxTasks": 12
}
```

Location: `~/.pi/agent/pi-pte.config.json`.

## Coexistence

- Do not load Pi's example `todo` extension at the same time unless you intentionally want two independent boards.
- A goal lifecycle extension may generically encourage structured planning tools when available, but checklist completion is not proof that the overall goal is complete.
- Removing `pi-pte` leaves other extensions functional; no package imports or named tool dependency are required.

## Install

The package is already located at:

```text
~/.pi/agent/extensions/pi-pte/
```

Pi auto-discovers `extensions/*/index.ts`.

```bash
cd ~/.pi/agent/extensions/pi-pte
npm install
npm test
```

Run `/reload` or restart Pi after changes.
