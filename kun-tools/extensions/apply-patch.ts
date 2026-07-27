import { chmod, lstat, mkdir, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

export const applyPatchSchema = Type.Object({
  patch: Type.String({
    description:
      "Codex-compatible patch text. First line MUST be exactly *** Begin Patch and last line MUST be exactly *** End Patch. This is not markdown: never write *** Begin Patch *** or *** End Patch ***. File paths are relative to the project cwd (no absolute paths unless allowOutsideWorkspace=true). Update hunk lines must start with ' ', '+', or '-'. Use @@ or @@ symbolName — not unified-diff line numbers.",
  }),
  allowOutsideWorkspace: Type.Optional(
    Type.Boolean({
      description:
        "When true, allow absolute paths and paths outside the current project directory. Defaults to false. Prefer cwd-relative paths whenever possible.",
    }),
  ),
});

export type ApplyPatchInput = Static<typeof applyPatchSchema>;

type PatchOperation =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; chunks: PatchChunk[] };

interface PatchChunk {
  context?: string;
  oldLines: string[];
  newLines: string[];
  endOfFile: boolean;
}

interface FileChange {
  path: string;
  action: "A" | "M" | "D" | "R";
  content: string | null;
  mode?: number;
  sourcePath?: string;
}

interface PatchPlan {
  root: string;
  changes: FileChange[];
  allowOutsideWorkspace: boolean;
}

export interface ApplyPatchDetails {
  root: string;
  changes: Array<{ action: string; path: string; sourcePath?: string }>;
  allowOutsideWorkspace: boolean;
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const EOF = "*** End of File";
/** Models sometimes close headers like markdown fences: `*** Begin Patch ***`. */
const BEGIN_FENCE = "*** Begin Patch ***";
const END_FENCE = "*** End Patch ***";
/** Models often emit unified-diff headers like `@@ -12,3 +12,4 @@`; ignore the line numbers. */
const UNIFIED_DIFF_HUNK_HEADER =
  /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s*@@(?:\s+(.*))?$/;

function parseError(message: string): Error {
  return new Error(`Invalid apply_patch: ${message}`);
}

function formatGot(line: string | undefined): string {
  if (line === undefined) return "<missing>";
  const preview = line.length > 80 ? `${line.slice(0, 77)}...` : line;
  return JSON.stringify(preview);
}

function normalizeBoundaryLine(line: string | undefined, kind: "begin" | "end"): string | undefined {
  if (line === undefined) return undefined;
  const trimmed = line.trim();
  if (kind === "begin") {
    if (trimmed === BEGIN || trimmed === BEGIN_FENCE) return BEGIN;
    return trimmed;
  }
  if (trimmed === END || trimmed === END_FENCE) return END;
  return trimmed;
}

function isEndMarker(line: string | undefined): boolean {
  return normalizeBoundaryLine(line, "end") === END;
}

function isBeginMarker(line: string | undefined): boolean {
  return normalizeBoundaryLine(line, "begin") === BEGIN;
}

function parseChangeContext(headerLine: string): string | undefined {
  if (headerLine === "@@" || headerLine === "@@ ") return undefined;
  const unified = headerLine.match(UNIFIED_DIFF_HUNK_HEADER);
  if (unified) {
    const rest = unified[1]?.trim();
    return rest || undefined;
  }
  if (headerLine.startsWith("@@ ")) {
    return headerLine.slice(3).trim() || undefined;
  }
  // Fallback for odd variants such as "@@foo"
  if (headerLine.startsWith("@@")) {
    return headerLine.slice(2).trim() || undefined;
  }
  return undefined;
}

function emptyUpdateChunkError(path: string): Error {
  return parseError(
    [
      `empty update chunk for ${path}`,
      "hint: each @@ hunk needs at least one line with a leading space (context), '+' (add), or '-' (remove)",
    ].join("\n"),
  );
}

function unexpectedUpdateLineError(path: string, line: string, lineNumber: number): Error {
  return parseError(
    [
      `unexpected update line in ${path} at patch line ${lineNumber}: ${line}`,
      `got: ${formatGot(line)}`,
      "hint: every hunk line must start with ' ' (context), '+' (add), or '-' (remove); unprefixed text is invalid",
    ].join("\n"),
  );
}

function parseFileLines(lines: string[], start: number, path: string): { lines: string[]; next: number } {
  const content: string[] = [];
  let index = start;
  while (index < lines.length && !isPatchBoundary(lines[index])) {
    const line = lines[index];
    if (!line.startsWith("+")) {
      throw parseError(
        [
          `add hunk for ${path} contains a non-add line at patch line ${index + 1}`,
          `got: ${formatGot(line)}`,
          "hint: every line in an Add File hunk must start with '+'",
        ].join("\n"),
      );
    }
    content.push(line.slice(1));
    index += 1;
  }
  if (content.length === 0) {
    throw parseError(
      [
        `add hunk for ${path} is empty`,
        "hint: include one or more lines starting with '+' for the new file contents",
      ].join("\n"),
    );
  }
  return { lines: content, next: index };
}

function isPatchBoundary(line: string): boolean {
  // Control lines may be indented; content lines keep their original prefix
  // (' ', '+', '-') so trimming is only safe for structural headers.
  const trimmed = line.trim();
  return (
    trimmed.startsWith(ADD) ||
    trimmed.startsWith(DELETE) ||
    trimmed.startsWith(UPDATE) ||
    trimmed.startsWith("*** Environment ID: ") ||
    isEndMarker(trimmed) ||
    isBeginMarker(trimmed)
  );
}

function parseUpdateChunks(lines: string[], start: number, path: string): {
  chunks: PatchChunk[];
  moveTo?: string;
  next: number;
} {
  const chunks: PatchChunk[] = [];
  let current: PatchChunk | undefined;
  let moveTo: string | undefined;
  let index = start;

  const ensureChunk = () => {
    current ??= { oldLines: [], newLines: [], endOfFile: false };
    if (!chunks.includes(current)) chunks.push(current);
  };

  while (index < lines.length && !isPatchBoundary(lines[index])) {
    const line = lines[index];
    const trimmedLine = line.trim();
    if (chunks.length === 0 && !current && trimmedLine.startsWith(MOVE)) {
      moveTo = trimmedLine.slice(MOVE.length).trim();
      if (!moveTo) throw parseError(`move destination for ${path} is empty`);
      index += 1;
      continue;
    }
    // Do not trim @@ / EOF lines: a context line " @@..." is valid file content
    // (leading space + "@@..."), while hunk headers must start at column 0.
    if (line === "@@" || line.startsWith("@@ ") || line.startsWith("@@")) {
      if (current && current.oldLines.length === 0 && current.newLines.length === 0) {
        throw emptyUpdateChunkError(path);
      }
      current = {
        context: parseChangeContext(line),
        oldLines: [],
        newLines: [],
        endOfFile: false,
      };
      chunks.push(current);
      index += 1;
      continue;
    }
    if (line === EOF || trimmedLine === EOF) {
      ensureChunk();
      if (current!.oldLines.length === 0 && current!.newLines.length === 0) {
        throw emptyUpdateChunkError(path);
      }
      current!.endOfFile = true;
      index += 1;
      continue;
    }

    if (current?.endOfFile && !line.trim()) {
      index += 1;
      continue;
    }

    ensureChunk();
    if (line === "") {
      current!.oldLines.push("");
      current!.newLines.push("");
    } else if (line.startsWith(" ")) {
      const value = line.slice(1);
      current!.oldLines.push(value);
      current!.newLines.push(value);
    } else if (line.startsWith("+")) {
      current!.newLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      current!.oldLines.push(line.slice(1));
    } else {
      throw unexpectedUpdateLineError(path, line, index + 1);
    }
    index += 1;
  }

  if (current && current.oldLines.length === 0 && current.newLines.length === 0) {
    throw emptyUpdateChunkError(path);
  }
  if (chunks.length === 0) {
    throw parseError(
      [
        `update hunk for ${path} is empty`,
        "hint: after *** Update File, include at least one @@ hunk with ' '/'+'/'-' lines (optional *** Move to: first)",
      ].join("\n"),
    );
  }
  return { chunks, moveTo, next: index };
}

export function parsePatch(patch: string): PatchOperation[] {
  const lines = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
  const first = normalizeBoundaryLine(lines[0], "begin");
  const last = normalizeBoundaryLine(lines.at(-1), "end");
  if (first !== BEGIN) {
    throw parseError(
      [
        `first line must be '${BEGIN}'`,
        `got: ${formatGot(lines[0])}`,
        "hint: do not close the header with trailing ' ***'; this is not markdown",
      ].join("\n"),
    );
  }
  if (last !== END) {
    throw parseError(
      [
        `last line must be '${END}'`,
        `got: ${formatGot(lines.at(-1))}`,
        "hint: do not close the footer with trailing ' ***'; this is not markdown",
      ].join("\n"),
    );
  }
  // Canonicalize accepted fence-style begin/end so the rest of the parser sees exact markers.
  lines[0] = BEGIN;
  lines[lines.length - 1] = END;

  const operations: PatchOperation[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    // Models sometimes indent headers or emit per-file / duplicated End markers.
    // Normalize whitespace for control lines; keep original content lines elsewhere.
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }
    // Intermediate *** End Patch / *** End Patch *** (and accidental duplicates) are
    // no-ops: the real terminator is validated as the final line above.
    if (isEndMarker(line)) {
      index += 1;
      continue;
    }
    // Ignore a duplicated begin marker inside the body (same class of model slip).
    if (isBeginMarker(line)) {
      index += 1;
      continue;
    }
    if (line.startsWith("*** Environment ID: ")) {
      index += 1;
      continue;
    }
    if (line.startsWith(ADD)) {
      const path = line.slice(ADD.length).trim();
      const parsed = parseFileLines(lines, index + 1, path);
      operations.push({ kind: "add", path, lines: parsed.lines });
      index = parsed.next;
      continue;
    }
    if (line.startsWith(DELETE)) {
      const path = line.slice(DELETE.length).trim();
      if (!path) throw parseError("delete path is empty");
      operations.push({ kind: "delete", path });
      index += 1;
      continue;
    }
    if (line.startsWith(UPDATE)) {
      const path = line.slice(UPDATE.length).trim();
      if (!path) throw parseError("update path is empty");
      const parsed = parseUpdateChunks(lines, index + 1, path);
      operations.push({ kind: "update", path, moveTo: parsed.moveTo, chunks: parsed.chunks });
      index = parsed.next;
      continue;
    }
    throw parseError(
      [
        `unsupported hunk header: ${line}`,
        `got: ${formatGot(line)}`,
        "hint: expected *** Add File: / *** Delete File: / *** Update File: (or a blank / Environment ID line). If this text was meant as file content, it belongs inside a hunk with a leading ' ', '+', or '-'",
      ].join("\n"),
    );
  }
  return operations;
}

function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, " ");
}

function findSequence(lines: string[], pattern: string[], start: number, endOfFile: boolean): number | undefined {
  if (pattern.length === 0) return endOfFile ? lines.length : start;
  const first = endOfFile ? Math.max(start, lines.length - pattern.length) : start;
  const matches = (candidate: number, mode: "exact" | "trim") =>
    pattern.every((line, offset) => {
      const current = lines[candidate + offset];
      if (current === undefined) return false;
      return mode === "exact" ? current === line : normalizeForMatch(current) === normalizeForMatch(line);
    });

  for (let position = first; position <= lines.length - pattern.length; position += 1) {
    if (matches(position, "exact")) return position;
  }
  for (let position = first; position <= lines.length - pattern.length; position += 1) {
    if (matches(position, "trim")) return position;
  }
  return undefined;
}

function splitContent(content: string): { lines: string[]; trailingNewline: boolean } {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) lines.pop();
  if (lines.length === 1 && lines[0] === "") return { lines: [], trailingNewline };
  return { lines, trailingNewline };
}

function previewLines(lines: string[], max = 8): string {
  if (lines.length === 0) return "  <insertion / empty old side>";
  const body = lines.slice(0, max).map((line) => `  ${line}`);
  if (lines.length > max) body.push(`  ... (${lines.length - max} more lines)`);
  return body.join("\n");
}

function formatHunkFailure(path: string, hunkIndex: number, reason: string, expected: string[]): Error {
  return new Error(
    [
      `Failed apply_patch at ${path} hunk ${hunkIndex}:`,
      reason,
      "expected:",
      previewLines(expected),
      "hint: re-read the file with read and regenerate the patch with more unique context",
    ].join("\n"),
  );
}

function applyChunks(content: string, chunks: PatchChunk[], path: string): string {
  const split = splitContent(content);
  const lines = [...split.lines];
  let cursor = 0;

  for (let hunkIndex = 0; hunkIndex < chunks.length; hunkIndex += 1) {
    const chunk = chunks[hunkIndex];
    let searchStart = cursor;
    if (chunk.context) {
      const contextIndex = findSequence(lines, [chunk.context], cursor, false);
      if (contextIndex === undefined) {
        throw formatHunkFailure(
          path,
          hunkIndex + 1,
          `context marker not found: ${chunk.context}`,
          [chunk.context],
        );
      }
      searchStart = contextIndex + 1;
    }
    const position = findSequence(lines, chunk.oldLines, searchStart, chunk.endOfFile);
    if (position === undefined) {
      throw formatHunkFailure(
        path,
        hunkIndex + 1,
        chunk.endOfFile ? "end-of-file expected lines not found" : "expected lines not found",
        chunk.oldLines,
      );
    }
    lines.splice(position, chunk.oldLines.length, ...chunk.newLines);
    cursor = position + chunk.newLines.length;
  }

  if (lines.length === 0) return "";
  // Codex apply_patch writes a trailing newline after successful text updates.
  return `${lines.join("\n")}\n`;
}

export interface ApplyPatchOptions {
  allowOutsideWorkspace?: boolean;
}

function resolvePatchPath(root: string, rawPath: string, allowOutsideWorkspace: boolean): string {
  const value = rawPath.trim();
  if (!value || value.includes("\0") || value.includes("\\")) {
    throw new Error(
      [
        `unsafe patch path: ${rawPath}`,
        `project root: ${root}`,
        "hint: use a non-empty path relative to the project root; backslashes and NUL are not allowed",
      ].join("\n"),
    );
  }
  if (isAbsolute(value)) {
    if (!allowOutsideWorkspace) {
      const resolved = resolve(value);
      const rel = relative(root, resolved);
      const inside =
        rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
      throw new Error(
        [
          `unsafe patch path: ${rawPath}`,
          `project root: ${root}`,
          inside
            ? `hint: paths must be relative to the project root; use ${JSON.stringify(rel || ".")} instead of an absolute path`
            : "hint: absolute paths are rejected by default; rewrite as a cwd-relative path, or set allowOutsideWorkspace=true only for intentional outside-project edits",
        ].join("\n"),
      );
    }
    return resolve(value);
  }
  const normalized = normalize(value);
  const target = resolve(root, normalized);
  if (!allowOutsideWorkspace) {
    const escaped = relative(root, target);
    if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
      throw new Error(
        [
          `patch path escapes the workspace: ${rawPath}`,
          `project root: ${root}`,
          "hint: use a path under the project root, or set allowOutsideWorkspace=true for intentional outside-project edits",
        ].join("\n"),
      );
    }
  }
  return target;
}

async function assertNoSymlinkPath(root: string, target: string) {
  let current = target;
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`symbolic links are not allowed in patch paths: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === root) return;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function readRegularFile(path: string, required: boolean): Promise<{ content: string; mode: number } | undefined> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`not a regular file: ${path}`);
    return { content: await readFile(path, "utf8"), mode: info.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !required) return undefined;
    throw error;
  }
}

export async function planPatch(
  rootInput: string,
  patch: string,
  options: ApplyPatchOptions = {},
): Promise<PatchPlan> {
  const root = await realpath(rootInput);
  const allowOutsideWorkspace = options.allowOutsideWorkspace === true;
  const operations = parsePatch(patch);
  if (operations.length === 0) throw new Error("apply_patch contains no file changes");

  const affected = new Set<string>();
  const changes: FileChange[] = [];
  for (const operation of operations) {
    const source = resolvePatchPath(root, operation.path, allowOutsideWorkspace);
    await assertNoSymlinkPath(root, source);
    if (affected.has(source)) throw new Error(`patch references the same path more than once: ${operation.path}`);
    affected.add(source);

    if (operation.kind === "add") {
      changes.push({ path: source, action: "A", content: `${operation.lines.join("\n")}\n` });
      continue;
    }
    if (operation.kind === "delete") {
      const existing = await readRegularFile(source, true);
      changes.push({ path: source, action: "D", content: null, mode: existing?.mode });
      continue;
    }

    const existing = await readRegularFile(source, true);
    if (!existing) throw new Error(`file to update does not exist: ${operation.path}`);
    const updatedContent = applyChunks(existing.content, operation.chunks, operation.path);
    if (operation.moveTo) {
      const destination = resolvePatchPath(root, operation.moveTo, allowOutsideWorkspace);
      await assertNoSymlinkPath(root, destination);
      if (affected.has(destination)) throw new Error(`patch references the same path more than once: ${operation.moveTo}`);
      affected.add(destination);
      changes.push({ path: source, action: "R", content: null, mode: existing.mode, sourcePath: operation.moveTo });
      changes.push({ path: destination, action: "R", content: updatedContent, mode: existing.mode, sourcePath: operation.path });
    } else {
      changes.push({ path: source, action: "M", content: updatedContent, mode: existing.mode });
    }
  }
  return { root, changes, allowOutsideWorkspace };
}

async function snapshot(path: string): Promise<{ content: string; mode: number } | undefined> {
  return readRegularFile(path, false);
}

async function commitPatch(plan: PatchPlan): Promise<void> {
  const snapshots = new Map<string, { content: string; mode: number } | undefined>();
  for (const change of plan.changes) snapshots.set(change.path, await snapshot(change.path));
  const temporaryFiles: Array<{ temporary: string; target: string; mode?: number }> = [];

  try {
    for (const change of plan.changes) {
      if (change.content === null) continue;
      await mkdir(dirname(change.path), { recursive: true });
      const temporary = join(dirname(change.path), `.kun-tools-${process.pid}-${Math.random().toString(16).slice(2)}`);
      await writeFile(temporary, change.content, { encoding: "utf8", mode: change.mode ?? 0o644 });
      temporaryFiles.push({ temporary, target: change.path, mode: change.mode });
    }

    for (const change of plan.changes) {
      if (change.content === null) {
        await unlink(change.path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
    for (const temporary of temporaryFiles) {
      await rm(temporary.target, { force: true });
      await rename(temporary.temporary, temporary.target);
      if (temporary.mode !== undefined) await chmod(temporary.target, temporary.mode);
    }
  } catch (error) {
    for (const temporary of temporaryFiles) await rm(temporary.temporary, { force: true }).catch(() => undefined);
    for (const change of plan.changes) await rm(change.path, { force: true }).catch(() => undefined);
    for (const [path, previous] of snapshots) {
      if (!previous) continue;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, previous.content, { encoding: "utf8", mode: previous.mode });
    }
    throw error;
  }
}

function summarizePath(root: string, path: string, allowOutsideWorkspace: boolean): string {
  if (!allowOutsideWorkspace) return relative(root, path);
  const escaped = relative(root, path);
  if (escaped === "" || (!escaped.startsWith(`..${sep}`) && escaped !== ".." && !isAbsolute(escaped))) {
    return escaped;
  }
  return path;
}

export async function applyPatch(
  rootInput: string,
  patch: string,
  options: ApplyPatchOptions = {},
): Promise<ApplyPatchDetails> {
  const plan = await planPatch(rootInput, patch, options);
  await withFileMutationQueue(plan.root, async () => {
    // Re-plan inside the queue so concurrent writes cannot invalidate matching context.
    const currentPlan = await planPatch(plan.root, patch, options);
    await commitPatch(currentPlan);
  });
  const summary = plan.changes
    .filter((change) => change.content !== null || change.action !== "R")
    .map((change) => ({
      action: change.action,
      path: summarizePath(plan.root, change.path, plan.allowOutsideWorkspace),
      sourcePath: change.sourcePath,
    }));
  return { root: plan.root, changes: summary, allowOutsideWorkspace: plan.allowOutsideWorkspace };
}

export function registerApplyPatchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "apply_patch",
    label: "apply_patch",
    description:
      "Apply precise Codex-style multi-file edits inside the current project. Best for local updates, small adds/deletes, and renames with context matching. Prefer write for new files, complete rewrites, or docs that embed apply_patch markers. First line MUST be exactly *** Begin Patch and last line exactly *** End Patch (never fence-style *** Begin Patch ***). Paths are relative to the project cwd — no absolute paths unless allowOutsideWorkspace=true. Hunk lines must start with ' ', '+', or '-'. Use @@ / @@ symbolName, not unified-diff line numbers.",
    promptSnippet: "Apply precise multi-file source patches",
    promptGuidelines: [
      "Use apply_patch for precise edits to existing files; use write for new files or complete rewrites.",
      "Patch envelope is not markdown: first line exactly *** Begin Patch, last line exactly *** End Patch. Never write *** Begin Patch *** or *** End Patch ***.",
      "Patch paths are relative to the current project cwd. Never use absolute paths unless allowOutsideWorkspace=true.",
      "In update hunks, every content line must start with a leading space (context), '+' (add), or '-' (remove). Unprefixed text is invalid.",
      "Use @@ or @@ symbolName for context anchors. Do not rely on unified-diff line numbers like @@ -12,3 +12,4 @@ (they are ignored if present).",
      "If editing docs that embed apply_patch examples (*** markers / sample hunks), prefer write for that file.",
      "Prefer small, focused apply_patch hunks with unique context over large whole-file patches.",
      "Include enough context in apply_patch update hunks to identify the target uniquely.",
      "On apply_patch failure, read the file again before regenerating the patch.",
      "Set allowOutsideWorkspace=true only when intentionally editing files outside the current project directory.",
    ],
    parameters: applyPatchSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const details = await applyPatch(ctx.cwd, params.patch, {
        allowOutsideWorkspace: params.allowOutsideWorkspace === true,
      });
      const lines = details.changes.map((change) => `${change.action} ${change.path}`);
      return {
        content: [{ type: "text", text: `Applied patch:\n${lines.join("\n")}` }],
        details,
      };
    },
  });
}
