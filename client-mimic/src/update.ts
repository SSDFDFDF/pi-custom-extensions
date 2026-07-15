import { loadConfig, saveConfig, type MimicConfig } from "./config.ts";

export interface UpdateResult {
	key: string;
	label: string;
	npmPackage: string;
	previous: string;
	latest: string;
	changed: boolean;
	error?: string;
}

/**
 * Fetch the latest published version for an npm package via the registry
 * "abbreviated" metadata endpoint (small JSON, no full document).
 */
export async function fetchLatestVersion(npmPackage: string, signal?: AbortSignal): Promise<string> {
	const url = `https://registry.npmjs.org/${encodeNpmName(npmPackage)}/latest`;
	// Always bound the request with a timeout; compose with ctx.signal when present
	// so Esc still cancels, but a hung registry can't stall /mimic update forever.
	const timeout = AbortSignal.timeout(10_000);
	const composed =
		signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : (signal ?? timeout);
	const res = await fetch(url, {
		headers: { Accept: "application/vnd.npm.install-v1+json, application/json" },
		signal: composed,
	});
	if (!res.ok) {
		throw new Error(`registry ${res.status} for ${npmPackage}`);
	}
	const body = (await res.json()) as { version?: unknown };
	if (typeof body.version !== "string" || !body.version) {
		throw new Error(`no version field for ${npmPackage}`);
	}
	return body.version;
}

/** Scoped names like @openai/codex must keep the slash unescaped for /latest. */
function encodeNpmName(name: string): string {
	if (name.startsWith("@")) {
		const [scope, rest] = name.slice(1).split("/", 2);
		return `@${encodeURIComponent(scope)}/${encodeURIComponent(rest ?? "")}`;
	}
	return encodeURIComponent(name);
}

/**
 * Update the `version` of one profile (or all profiles with an npmPackage)
 * from the npm registry. Persists changes to the config file.
 */
export async function updateVersions(target: string | undefined, signal?: AbortSignal): Promise<UpdateResult[]> {
	const cfg = loadConfig();
	const keys = pickKeys(cfg, target);
	const results: UpdateResult[] = [];

	for (const key of keys) {
		const p = cfg.profiles[key];
		const base: UpdateResult = {
			key,
			label: p.label,
			npmPackage: p.npmPackage,
			previous: p.version,
			latest: p.version,
			changed: false,
		};
		if (!p.npmPackage) {
			results.push({ ...base, error: "no npmPackage configured" });
			continue;
		}
		try {
			const latest = await fetchLatestVersion(p.npmPackage, signal);
			base.latest = latest;
			base.changed = latest !== p.version;
			if (base.changed) p.version = latest;
			results.push(base);
		} catch (e) {
			results.push({ ...base, error: e instanceof Error ? e.message : String(e) });
		}
	}

	// Persist only if something actually changed. Pass the fully-resolved config
	// (not just the patch) so saveConfig's internal re-read cannot clobber the
	// versions we just fetched with a stale on-disk copy.
	if (results.some((r) => r.changed)) {
		saveConfig(cfg);
	}
	return results;
}

function pickKeys(cfg: MimicConfig, target: string | undefined): string[] {
	const t = (target ?? "").trim();
	if (!t || t === "all") return Object.keys(cfg.profiles);
	if (cfg.profiles[t]) return [t];
	return [];
}

export function formatUpdateResults(results: UpdateResult[]): string {
	if (!results.length) return "No matching profiles to update.";
	return results
		.map((r) => {
			if (r.error) return `  ${r.key}: error — ${r.error}`;
			if (r.changed) return `  ${r.key}: ${r.previous} → ${r.latest} (updated)`;
			return `  ${r.key}: ${r.latest} (already latest)`;
		})
		.join("\n");
}
