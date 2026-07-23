# kun-tools

A compact, shell-first tool surface for the Pi coding agent.

## Tool surface

When the package loads, it keeps Pi's built-in `read` and `write`, adds `shell` and `apply_patch`, and deactivates overlapping built-in tools (`bash`, `edit`, `grep`, `find`, `ls`). Tools from unrelated extensions remain active. To drop another extension's tools, remove that extension.

| Tool | Purpose |
|---|---|
| `shell` | Run one coherent command-line task with explicit `workdir` and millisecond timeout. |
| `read` | Pi's built-in exact, paginated text/image reader. |
| `write` | Pi's built-in full-file writer for new files or complete rewrites. |
| `apply_patch` | Apply precise Codex-style add/update/delete/move patches to existing files. Prefer this for local edits; use `write` for large new files or full rewrites. |

## Local loading

The extension lives at `~/.pi/agent/extensions/kun-tools/` and is discovered automatically. Run `/reload` after changing its source. Use `/kun-tools` to inspect the active core tools.

## Patch format

`apply_patch` receives a JSON object with a `patch` string and optional `allowOutsideWorkspace`:

```text
*** Begin Patch
*** Add File: src/new.ts
+export const value = 1;
*** Update File: src/old.ts
@@
-export const old = true;
+export const old = false;
*** Delete File: src/unused.ts
*** End Patch
```

The envelope is **not markdown**. First line must be exactly `*** Begin Patch` and last line exactly `*** End Patch`. Do **not** write fence-style `*** Begin Patch ***` / `*** End Patch ***` (the parser accepts that common model slip, but the canonical form omits the trailing ` ***`).

Supported headers:

- `*** Add File: path`
- `*** Update File: path`
- `*** Delete File: path`
- `*** Move to: path` immediately after an update header
- `@@` or `@@ context line` for update chunks
- `@@ -12,3 +12,4 @@` unified-diff line numbers are accepted but **ignored** (optional trailing symbol after the second `@@` is kept as context)
- `*** End of File` for an end-anchored chunk

Rules that prevent the most common failures:

- Paths are **relative to the project cwd**. Absolute paths are rejected unless `allowOutsideWorkspace=true`. If the absolute path is still inside the project, the error suggests the relative form.
- Every update/add content line must start with ` ` (context), `+` (add), or `-` (remove). Unprefixed text is invalid.
- Prefer `write` when editing docs that embed `*** Begin Patch` examples, so sample markers are not parsed as live syntax.

All operations are parsed and validated before writes begin. By default, patch paths must remain under the active project directory and may not traverse symbolic links. Set `allowOutsideWorkspace=true` only when intentionally editing outside the project root.

## Execution model

- `shell` defaults to a 60 second timeout and accepts up to 30 minutes explicitly.
- Pi's local shell backend supplies platform shell selection, environment handling, abort behavior, and process-tree termination.
- Output is capped at Pi's standard 50KB / 2000 line budget. Large output preserves a small head and larger tail, with the full log written to a temporary file.
- Shell results end with a stable footer: `exit`, `duration_ms`, `timed_out`, `truncated`, optional `reduced` (when compression saved bytes), and optional `full_output`.
- `apply_patch` is sequential and uses Pi's file mutation queue. Match failures include file, hunk index, expected lines, and a re-read hint.

## Output compression

`shell` can run its output through a deterministic, local reducer chain before it
reaches the model context. It never summarizes with an LLM, never changes
`exit`/`duration_ms`/`timed_out`, and always tees the raw output to `full_output`
so nothing is lost.

Pipeline: `\n`/`\r` line split → ANSI strip → progress/spinner drop → consecutive
dedup + blank collapse → (aggressive) per-tool noise filter. An importance
classifier protects lines with errors, warnings, file paths, stack frames, test
results, and exit codes — those are never dropped. JSON output (`--json` flags or
`{`/`[` first byte) and binary output are passed through untouched.

Detection is streaming-safe: JSON is classified from the first non-whitespace
byte across chunk boundaries, and a NUL byte anywhere in the decision window
marks the stream binary. When reduction is active the presented text normalizes
line endings to `\n`; the raw artifact in `full_output` always keeps the
original bytes (including CRLF and non-UTF-8) untouched. An unterminated final
line is presented without a synthetic trailing newline.

When compression saves meaningful bytes the footer gains a line:

```text
reduced: 5.6KB→1.2KB (-78%, ~1430→~310 tok) [ansi,progress,dedup]
```

Token counts are a deterministic `chars/4` estimate, marked approximate.

### Config

Stored in `~/.pi/agent/kun-tools.config.json` (auto-created on first write):

```json
{
  "compress": { "mode": "off", "minBytes": 2048, "commandFilters": true }
}
```

| Field | Default | Meaning |
|---|---|---|
| `compress.mode` | `off` | `off` / `safe` / `aggressive` |
| `compress.minBytes` | `2048` | Output below this size passes through untouched |
| `compress.commandFilters` | `true` | Enable per-tool noise filters (aggressive only) |

Manage it from the TUI with `/kun-tools`:

| Command | Meaning |
|---|---|
| `/kun-tools` / `/kun-tools status` | Show tool surface + compression config |
| `/kun-tools compress off` / `safe` / `aggressive` | Set compression mode |
| `/kun-tools compress min <bytes>` | Set `minBytes` |
| `/kun-tools compress filters on` / `off` | Toggle per-tool noise filters |

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `KUN_ALLOW_OUTSIDE_WORKDIR` | unset/false | When truthy (`1`/`true`/`yes`), `shell.workdir` may leave the project root. |
| `KUN_TOOLS_CONFIG` | unset | Override the config file path (used by tests). |

## Security boundary

This package is intended for trusted local development. It does not provide a sandbox. Shell commands run with the same operating-system permissions as Pi. By default, `shell.workdir` and patch paths must stay under the project root.
