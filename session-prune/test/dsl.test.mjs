/**
 * `/prune` selector syntax tests.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { load } from "./load.mjs";

const { parseSelector } = await load("../src/dsl.ts");

test("ids, rows and ranges", () => {
	assert.deepEqual(parseSelector(["id:abc123,def"]), { entryIds: ["abc123", "def"] });
	assert.deepEqual(parseSelector(["#3"]), { indices: [3] });
	assert.deepEqual(parseSelector(["#3-5"]), { indices: [3, 4, 5] });
	assert.deepEqual(parseSelector(["#-2"]), { indices: [-2] });
});

test("roles, tools and text", () => {
	assert.deepEqual(parseSelector(["role:toolResult,assistant"]), { roles: ["toolResult", "assistant"] });
	assert.deepEqual(parseSelector(["tool:read,grep"]), { tools: ["read", "grep"] });
	assert.deepEqual(parseSelector(["text:/a.c/"]), { match: "a.c" });
	assert.deepEqual(parseSelector(["text:a.c"]), { match: "a\\.c" });
	// Multiple text tokens are ANDed with lookaheads.
	assert.equal(parseSelector(["text:foo", "text:bar"]).match, "(?=[\\s\\S]*?foo)(?=[\\s\\S]*?bar)");
});

test("relative selectors", () => {
	assert.deepEqual(parseSelector(["last:5"]), { lastMessages: 5 });
	assert.deepEqual(parseSelector(["turns:2"]), { turns: 2 });
	assert.deepEqual(parseSelector(["before:#5"]), { beforeIndex: 5 });
	assert.deepEqual(parseSelector(["after:#5"]), { afterIndex: 5 });
});

test("tokens combine like the JSON selectors", () => {
	assert.deepEqual(parseSelector(["role:assistant", "tool:read", "last:3"]), {
		roles: ["assistant"],
		tools: ["read"],
		lastMessages: 3,
	});
	assert.deepEqual(parseSelector(["", "  "]), {});
});

test("bad tokens fail loudly", () => {
	assert.throws(() => parseSelector(["wat"]), /unknown selector "wat"/);
	assert.throws(() => parseSelector(["colour:red"]), /unknown selector "colour:red"/);
	assert.throws(() => parseSelector(["last:soon"]), /needs a number/);
});
