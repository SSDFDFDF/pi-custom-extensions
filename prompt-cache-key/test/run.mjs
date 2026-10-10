/**
 * Test runner for this extension.
 *
 * Pi loads extensions through jiti, and the Node build on this machine has no
 * `--experimental-strip-types` support (ERR_NO_TYPESCRIPT), so `node --test`
 * cannot import the `.ts` sources directly. Instead: bundle each test file with
 * esbuild (resolved from this package, then from the installed pi package) and
 * run the bundles through Node's test runner.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
const require = createRequire(import.meta.url);

function resolveEsbuild() {
	for (const specifier of ["esbuild/package.json", "esbuild"]) {
		for (const paths of [
			packageDir,
			join(packageDir, ".."),
			"/home/xjc/.local/lib/node_modules/@earendil-works/pi-coding-agent",
		]) {
			try {
				return require.resolve(specifier, { paths: [paths] });
			} catch {
				// try the next location
			}
		}
	}
	const global = spawnSync("sh", ["-c", "command -v esbuild"], { encoding: "utf8" });
	const found = global.stdout?.trim();
	if (global.status === 0 && found) return found;
	throw new Error("esbuild not found; install it in this package or use a Pi install that ships it");
}

const esbuildEntry = resolveEsbuild();
const esbuildBin = esbuildEntry.includes("package.json")
	? join(dirname(esbuildEntry), "bin/esbuild")
	: esbuildEntry;

const tests = readdirSync(here).filter((name) => name.endsWith(".test.mjs"));
if (tests.length === 0) {
	console.error("no test files found");
	process.exit(1);
}

/** Bundle the test files (and, transitively, the extension sources). Returns the output dir. */
function bundleTests(outDir) {
	const bundle = spawnSync(
		process.execPath,
		[
			esbuildBin,
			...tests.map((name) => join("test", name)),
			"--bundle",
			"--platform=node",
			"--format=esm",
			`--outdir=${outDir}`,
			"--log-level=warning",
		],
		{ cwd: packageDir, stdio: "inherit" },
	);
	return bundle.status ?? 1;
}

if (process.argv.includes("--check")) {
	const dir = mkdtempSync(join(tmpdir(), "prompt-cache-key-check-"));
	try {
		const status = bundleTests(dir);
		if (status !== 0) process.exit(status);
		console.log(`ok: bundled ${tests.length} test file(s) and the extension sources`);
		process.exit(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const outDir = mkdtempSync(join(tmpdir(), "prompt-cache-key-test-"));
try {
	const status = bundleTests(outDir);
	if (status !== 0) process.exit(status);

	const outputs = readdirSync(outDir).map((name) => join(outDir, name));
	// Safety net: never let a test touch the live agent dir, even if it forgets to
	// point PI_CODING_AGENT_DIR at its own temp directory.
	const sandboxAgentDir = mkdtempSync(join(tmpdir(), "prompt-cache-key-agent-"));
	try {
		const result = spawnSync(process.execPath, ["--test", ...outputs], {
			stdio: "inherit",
			env: { ...process.env, PI_CODING_AGENT_DIR: sandboxAgentDir },
		});
		process.exit(result.status ?? 1);
	} finally {
		rmSync(sandboxAgentDir, { recursive: true, force: true });
	}
} finally {
	rmSync(outDir, { recursive: true, force: true });
}
