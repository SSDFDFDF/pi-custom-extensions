import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPatch, parsePatch, planPatch } from "../extensions/apply-patch.js";

async function workspace() {
  return mkdtemp(join(tmpdir(), "kun-tools-patch-test-"));
}

test("parses and applies add, update, and delete operations", async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, "modify.txt"), "line1\nline2\nline3\nline4\n");
    await writeFile(join(root, "delete.txt"), "obsolete\n");

    const patch = `*** Begin Patch
*** Add File: nested/new.txt
+created
*** Delete File: delete.txt
*** Update File: modify.txt
@@
-line2
+changed2
@@
-line4
+changed4
*** End Patch`;

    const details = await applyPatch(root, patch);
    assert.deepEqual(
      details.changes.map(({ action, path }) => ({ action, path })),
      [
        { action: "A", path: "nested/new.txt" },
        { action: "D", path: "delete.txt" },
        { action: "M", path: "modify.txt" },
      ],
    );
    assert.equal(await readFile(join(root, "nested/new.txt"), "utf8"), "created\n");
    assert.equal(await readFile(join(root, "modify.txt"), "utf8"), "line1\nchanged2\nline3\nchanged4\n");
    await assert.rejects(readFile(join(root, "delete.txt"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("moves and updates a file", async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, "old.txt"), "before\n");
    await applyPatch(
      root,
      `*** Begin Patch
*** Update File: old.txt
*** Move to: nested/new.txt
@@
-before
+after
*** End Patch`,
    );
    assert.equal(await readFile(join(root, "nested/new.txt"), "utf8"), "after\n");
    await assert.rejects(readFile(join(root, "old.txt"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates the full patch before writing", async () => {
  const root = await workspace();
  try {
    const patch = `*** Begin Patch
*** Add File: created.txt
+hello
*** Update File: missing.txt
@@
-old
+new
*** End Patch`;
    await assert.rejects(applyPatch(root, patch), /ENOENT|does not exist/);
    await assert.rejects(readFile(join(root, "created.txt"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects paths that leave the workspace", async () => {
  const root = await workspace();
  try {
    await assert.rejects(
      planPatch(root, `*** Begin Patch\n*** Add File: ../escape.txt\n+bad\n*** End Patch`),
      /escapes the workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symbolic-link paths", async (context) => {
  if (process.platform === "win32") {
    context.skip("symlink creation may require elevated privileges on Windows");
    return;
  }
  const root = await workspace();
  const outside = await workspace();
  try {
    await symlink(outside, join(root, "linked"));
    await assert.rejects(
      planPatch(root, `*** Begin Patch\n*** Add File: linked/escape.txt\n+bad\n*** End Patch`),
      /symbolic links are not allowed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects invalid and empty patches", () => {
  assert.throws(() => parsePatch("not a patch"), /first line/);
  assert.deepEqual(parsePatch("*** Begin Patch\n*** End Patch"), []);
});

test("reports structured failure for missing update context", async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, "modify.txt"), "line1\nline2\n");
    await assert.rejects(
      applyPatch(
        root,
        `*** Begin Patch
*** Update File: modify.txt
@@
-missing
+changed
*** End Patch`,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Failed apply_patch at modify\.txt hunk 1/);
        assert.match(error.message, /expected lines not found/);
        assert.match(error.message, /missing/);
        assert.match(error.message, /hint: re-read the file/);
        return true;
      },
    );
    assert.equal(await readFile(join(root, "modify.txt"), "utf8"), "line1\nline2\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
