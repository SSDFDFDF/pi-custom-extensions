/**
 * Test runner.
 *
 * This Node build has no working `--experimental-strip-types`
 * (ERR_NO_TYPESCRIPT), so tests load the TypeScript sources through jiti (see
 * `load.mjs`). Run `npm test` for everything and `npm run check` for a syntax
 * check without executing anything.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(here)
	.filter((name) => name.endsWith(".test.mjs"))
	.map((name) => join(here, name));

if (tests.length === 0) {
	console.error("no test files found");
	process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...tests], { stdio: "inherit" });
process.exit(result.status ?? 1);
