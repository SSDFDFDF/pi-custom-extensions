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
      "Codex-compatible patch text starting with *** Begin Patch and ending with *** End Patch.",
  }),
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
}

export interface ApplyPatchDetails {
  root: string;
  changes: Array<{ action: string; path: string; sourcePath?: string }>;
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const EOF = "*** End of File";

function parseError(message: string): Error {
  return new Error(`Invalid apply_patch: ${message}`);
}

function parseFileLines(lines: string[], start: number, path: string): { lines: string[]; next: number } {
  const content: string[] = [];
  let index = start;
  while (index < lines.length && !lines[index].startsWith("*** ")) {
    const line = lines[index];
    if (!line.startsWith("+")) throw parseError(`add hunk for ${path} contains a non-add line`);
    content.push(line.slice(1));
    index += 1;
  }
  if (content.length === 0) throw parseError(`add hunk for ${path} is empty`);
  return { lines: content, next: index };
}

function isPatchBoundary(line: string): boolean {
  return (
    line.startsWith(ADD) ||
    line.startsWith(DELETE) ||
    line.startsWith(UPDATE) ||
    line.startsWith("*** Environment ID: ") ||
    line.trim() === END
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
    if (chunks.length === 0 && !current && line.startsWith(MOVE)) {
      moveTo = line.slice(MOVE.length).trim();
      if (!moveTo) throw parseError(`move destination for ${path} is empty`);
      index += 1;
      continue;
    }
    if (line === "@@" || line.startsWith("@@ ")) {
      if (current && current.oldLines.length === 0 && current.newLines.length === 0) {
        throw parseError(`empty update chunk for ${path}`);
      }
      current = { context: line.slice(2).trim() || undefined, oldLines: [], newLines: [], endOfFile: false };
      chunks.push(current);
      index += 1;
      continue;
    }
    if (line === EOF) {
      ensureChunk();
      if (current!.oldLines.length === 0 && current!.newLines.length === 0) {
        throw parseError(`empty update chunk for ${path}`);
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
      throw parseError(`unexpected update line in ${path}: ${line}`);
    }
    index += 1;
  }

  if (current && current.oldLines.length === 0 && current.newLines.length === 0) {
    throw parseError(`empty update chunk for ${path}`);
  }
  if (chunks.length === 0) throw parseError(`update hunk for ${path} is empty`);
  return { chunks, moveTo, next: index };
}

export function parsePatch(patch: string): PatchOperation[] {
  const lines = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
  if (lines[0]?.trim() !== BEGIN) throw parseError(`first line must be '${BEGIN}'`);
  if (lines.at(-1)?.trim() !== END) throw parseError(`last line must be '${END}'`);

  const operations: PatchOperation[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index].trimEnd();
    if (!line.trim()) {
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
    throw parseError(`unsupported hunk header: ${line}`);
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

function safeRelativePath(root: string, rawPath: string): string {
  const value = rawPath.trim();
  if (!value || value.includes("\0") || value.includes("\\") || isAbsolute(value)) {
    throw new Error(`unsafe patch path: ${rawPath}`);
  }
  const normalized = normalize(value);
  const target = resolve(root, normalized);
  const escaped = relative(root, target);
  if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    throw new Error(`patch path escapes the workspace: ${rawPath}`);
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

export async function planPatch(rootInput: string, patch: string): Promise<PatchPlan> {
  const root = await realpath(rootInput);
  const operations = parsePatch(patch);
  if (operations.length === 0) throw new Error("apply_patch contains no file changes");

  const affected = new Set<string>();
  const changes: FileChange[] = [];
  for (const operation of operations) {
    const source = safeRelativePath(root, operation.path);
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
      const destination = safeRelativePath(root, operation.moveTo);
      await assertNoSymlinkPath(root, destination);
      if (affected.has(destination)) throw new Error(`patch references the same path more than once: ${operation.moveTo}`);
      affected.add(destination);
      changes.push({ path: source, action: "R", content: null, mode: existing.mode, sourcePath: operation.moveTo });
      changes.push({ path: destination, action: "R", content: updatedContent, mode: existing.mode, sourcePath: operation.path });
    } else {
      changes.push({ path: source, action: "M", content: updatedContent, mode: existing.mode });
    }
  }
  return { root, changes };
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

export async function applyPatch(rootInput: string, patch: string): Promise<ApplyPatchDetails> {
  const plan = await planPatch(rootInput, patch);
  await withFileMutationQueue(plan.root, async () => {
    // Re-plan inside the queue so concurrent writes cannot invalidate matching context.
    const currentPlan = await planPatch(plan.root, patch);
    await commitPatch(currentPlan);
  });
  const summary = plan.changes
    .filter((change) => change.content !== null || change.action !== "R")
    .map((change) => ({ action: change.action, path: relative(plan.root, change.path), sourcePath: change.sourcePath }));
  return { root: plan.root, changes: summary };
}

export function registerApplyPatchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "apply_patch",
    label: "apply_patch",
    description:
      "Apply one validated Codex-style multi-file patch inside the current project. Supports Add File, Update File, Delete File, Move to, multiple hunks, and context matching.",
    promptSnippet: "Apply a validated multi-file source patch",
    promptGuidelines: [
      "Use apply_patch as the only direct source-editing tool; shell may run formatters and generators.",
      "Include enough context in apply_patch update hunks to identify the target uniquely.",
      "On apply_patch failure, read the file again before regenerating the patch.",
    ],
    parameters: applyPatchSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const details = await applyPatch(ctx.cwd, params.patch);
      const lines = details.changes.map((change) => `${change.action} ${change.path}`);
      return {
        content: [{ type: "text", text: `Applied patch:\n${lines.join("\n")}` }],
        details,
      };
    },
  });
}
