import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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

test("allows outside-workspace paths when requested", async () => {
  const root = await workspace();
  const outside = await workspace();
  try {
    const relativeOutside = relative(root, join(outside, "escape.txt"));
    const details = await applyPatch(
      root,
      `*** Begin Patch
*** Add File: ${relativeOutside}
+allowed-relative
*** Add File: ${join(outside, "absolute.txt")}
+allowed-absolute
*** End Patch`,
      { allowOutsideWorkspace: true },
    );
    assert.equal(details.allowOutsideWorkspace, true);
    assert.equal(await readFile(join(outside, "escape.txt"), "utf8"), "allowed-relative\n");
    assert.equal(await readFile(join(outside, "absolute.txt"), "utf8"), "allowed-absolute\n");
    assert.ok(details.changes.some((change) => change.path === join(outside, "absolute.txt")));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("still rejects absolute paths by default", async () => {
  const root = await workspace();
  try {
    await assert.rejects(
      planPatch(root, `*** Begin Patch\n*** Add File: /tmp/escape.txt\n+bad\n*** End Patch`),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /unsafe patch path/);
        assert.match(error.message, /project root:/);
        assert.match(error.message, /allowOutsideWorkspace=true|cwd-relative path/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("absolute paths inside the workspace get a relative rewrite hint", async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, "inside.txt"), "old\n");
    const absolute = join(root, "inside.txt");
    await assert.rejects(
      planPatch(
        root,
        `*** Begin Patch
*** Update File: ${absolute}
@@
-old
+new
*** End Patch`,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /unsafe patch path/);
        assert.match(error.message, /use "inside\.txt"/);
        return true;
      },
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
  assert.throws(
    () => parsePatch("not a patch"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /first line must be '\*\*\* Begin Patch'/);
      assert.match(error.message, /got: "not a patch"/);
      assert.match(error.message, /hint: do not close the header/);
      return true;
    },
  );
  assert.deepEqual(parsePatch("*** Begin Patch\n*** End Patch"), []);
});

test("accepts fence-style begin/end markers models often emit", () => {
  assert.deepEqual(
    parsePatch("*** Begin Patch ***\n*** End Patch ***"),
    [],
  );
  assert.deepEqual(
    parsePatch(
      `*** Begin Patch ***
*** Add File: nested/new.txt
+created
*** End Patch ***`,
    ),
    [{ kind: "add", path: "nested/new.txt", lines: ["created"] }],
  );
});


test("tolerates intermediate and duplicated end/begin markers", () => {
  const end = "*** End Patch";
  const endFence = "*** End Patch ***";
  const begin = "*** Begin Patch";
  const beginFence = "*** Begin Patch ***";

  assert.deepEqual(
    parsePatch([begin, "*** Add File: nested/new.txt", "+created", endFence, end].join("\n")),
    [{ kind: "add", path: "nested/new.txt", lines: ["created"] }],
  );

  assert.deepEqual(
    parsePatch(
      [
        beginFence,
        begin,
        "*** Add File: a.txt",
        "+one",
        endFence,
        "*** Add File: b.txt",
        "+two",
        endFence,
      ].join("\n"),
    ),
    [
      { kind: "add", path: "a.txt", lines: ["one"] },
      { kind: "add", path: "b.txt", lines: ["two"] },
    ],
  );

  // Leading indentation on control lines is a common model slip.
  assert.deepEqual(
    parsePatch(
      [begin, "  *** Add File: spaced.txt", "+ok", "  " + endFence, end].join("\n"),
    ),
    [{ kind: "add", path: "spaced.txt", lines: ["ok"] }],
  );

  // User-visible failure mode: only fence-style end as the final line is already accepted;
  // intermediate fence end without a second terminator used to throw unsupported hunk header.
  assert.deepEqual(
    parsePatch([begin, "*** Add File: x.txt", "+y", endFence].join("\n")),
    [{ kind: "add", path: "x.txt", lines: ["y"] }],
  );
});

test("still rejects other malformed begin/end markers with got+hint", () => {
  assert.throws(
    () => parsePatch("*** Begin Patch***\n*** End Patch"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /first line must be/);
      assert.match(error.message, /got: "\*\*\* Begin Patch\*\*\*"/);
      return true;
    },
  );
  assert.throws(
    () => parsePatch("*** Begin Patch\n*** End Patch***"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /last line must be/);
      assert.match(error.message, /got: "\*\*\* End Patch\*\*\*"/);
      assert.match(error.message, /hint: do not close the footer/);
      return true;
    },
  );
});

test("ignores unified-diff line-number headers on @@", () => {
  const ops = parsePatch(
    `*** Begin Patch
*** Update File: modify.txt
@@ -2,1 +2,1 @@
-line2
+changed2
*** End Patch`,
  );
  assert.deepEqual(ops, [
    {
      kind: "update",
      path: "modify.txt",
      moveTo: undefined,
      chunks: [{ context: undefined, oldLines: ["line2"], newLines: ["changed2"], endOfFile: false }],
    },
  ]);

  const withSymbol = parsePatch(
    `*** Begin Patch
*** Update File: modify.txt
@@ -10,3 +10,4 @@ function greet
 context
-old
+new
*** End Patch`,
  );
  assert.equal((withSymbol[0] as { chunks: Array<{ context?: string }> }).chunks[0].context, "function greet");
});

test("applies patches that use unified-diff @@ headers", async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, "modify.txt"), "line1\nline2\nline3\n");
    await applyPatch(
      root,
      `*** Begin Patch
*** Update File: modify.txt
@@ -2,1 +2,1 @@
-line2
+changed2
*** End Patch`,
    );
    assert.equal(await readFile(join(root, "modify.txt"), "utf8"), "line1\nchanged2\nline3\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports hints for empty and unprefixed update hunk lines", () => {
  assert.throws(
    () =>
      parsePatch(
        `*** Begin Patch
*** Update File: modify.txt
@@
*** End Patch`,
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /empty update chunk for modify\.txt/);
      assert.match(error.message, /leading space \(context\)/);
      return true;
    },
  );

  assert.throws(
    () =>
      parsePatch(
        `*** Begin Patch
*** Update File: modify.txt
@@
unprefixed context
-old
+new
*** End Patch`,
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /unexpected update line in modify\.txt/);
      assert.match(error.message, /got: "unprefixed context"/);
      assert.match(error.message, /leading space|must start with/);
      return true;
    },
  );
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
