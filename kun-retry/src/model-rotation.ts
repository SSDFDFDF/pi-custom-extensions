/**
 * Candidate-model rotation for kun-retry.
 *
 * When the user configures a pool of candidate provider/model pairs, kun-retry
 * counts consecutive retryable errors and, once the streak reaches
 * `switchAfterErrors`, switches the session model to the next usable model in a
 * cyclic rotation over the pool. The pool cycles across both the already-used
 * (active) model and the configured candidates, so a long sequence of failures
 * keeps hopping between every model in the set instead of getting stuck on one.
 *
 * This module holds only the pure, side-effect-free logic (parsing, pool
 * construction, streak accounting, next-model selection). The actual
 * `pi.setModel()` call and registry/auth lookups live in `index.ts`, which
 * supplies an `isUsable` predicate so this module stays testable without a live
 * ModelRegistry.
 */

export interface ModelRef {
	provider: string;
	id: string;
}

/** Canonical "provider/id" string for a model reference. */
export function modelKey(ref: ModelRef): string {
	return `${ref.provider}/${ref.id}`;
}

/**
 * Parse a single "provider/id" token. The provider is everything before the
 * first slash; the id is the remainder (which may itself contain slashes, e.g.
 * `openrouter/anthropic/claude-3.5-sonnet`). Returns undefined when the token
 * has no provider or no id.
 */
export function parseModelKey(token: string): ModelRef | undefined {
	const trimmed = token.trim();
	if (!trimmed) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	const provider = trimmed.slice(0, slash).trim();
	const id = trimmed.slice(slash + 1).trim();
	if (!provider || !id) return undefined;
	return { provider, id };
}

/**
 * Split a command argument into candidate model tokens. Accepts commas and/or
 * whitespace as separators, so all of these work:
 *   openai/gpt-4o anthropic/claude-3-5-sonnet
 *   openai/gpt-4o, anthropic/claude-3-5-sonnet
 * Invalid tokens are dropped; the caller can compare lengths to warn.
 */
export function parseModelList(args: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of args.split(/[\s,]+/)) {
		const ref = parseModelKey(raw);
		if (!ref) continue;
		const key = modelKey(ref);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(key);
	}
	return out;
}

/**
 * Build the cyclic rotation pool. When `includeActive` is true the currently
 * active model is placed at the front so the rotation naturally cycles through
 * "used + candidate" models. Duplicates are removed while preserving order.
 */
export function buildRotationPool(
	candidates: string[],
	activeKey: string | undefined,
	includeActive: boolean,
): string[] {
	const seen = new Set<string>();
	const pool: string[] = [];
	const add = (key: string | undefined) => {
		if (!key || seen.has(key)) return;
		seen.add(key);
		pool.push(key);
	};
	if (includeActive) add(activeKey);
	for (const c of candidates) add(c);
	return pool;
}

export interface StreakDecision {
	/** True when this error pushes the streak to the switch threshold. */
	shouldSwitch: boolean;
	/** Streak to store after this error (reset to 0 on a switch). */
	nextStreak: number;
}

/**
 * Account for one retryable error. Increments the consecutive-error streak and
 * reports whether the switch threshold has been reached. `switchAfter <= 0`
 * disables switching entirely (streak still advances for reporting).
 */
export function accountRetryableError(streak: number, switchAfter: number): StreakDecision {
	const nextStreak = streak + 1;
	if (switchAfter > 0 && nextStreak >= switchAfter) {
		return { shouldSwitch: true, nextStreak: 0 };
	}
	return { shouldSwitch: false, nextStreak };
}

/**
 * Pick the next model key to switch to, cycling forward from the current model.
 *
 * Starts one slot after the current model's position in the pool (or at the
 * front when the current model is not in the pool), wraps around, and returns
 * the first usable key that differs from the current one. Returns undefined
 * when the pool is empty or no other usable model exists.
 */
export function pickNextModelKey(
	pool: string[],
	currentKey: string | undefined,
	isUsable: (key: string) => boolean,
): string | undefined {
	if (pool.length === 0) return undefined;
	const startIdx = currentKey ? pool.indexOf(currentKey) : -1;
	// startIdx is already -1 when the current model is not in the pool, so stepping
	// from it visits index 0 first; when it is in the pool we step to the slot after it.
	const base = startIdx;
	for (let step = 1; step <= pool.length; step++) {
		const idx = (((base + step) % pool.length) + pool.length) % pool.length;
		const key = pool[idx];
		if (key === currentKey) continue;
		if (isUsable(key)) return key;
	}
	return undefined;
}
