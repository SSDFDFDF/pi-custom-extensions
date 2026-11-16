/**
 * Cross-extension outbound-rewrite service.
 *
 * `client-mimic` normally applies its client identity through pi's
 * `before_provider_headers` / `before_provider_request` hooks. Those hooks only
 * run on the agent's own request path. Out-of-band provider calls — most
 * importantly context compaction (`completeSummarization` -> provider
 * `streamSimple`) and extension-issued probe requests — bypass them, so a
 * gateway that gates on the client fingerprint rejects those requests while
 * normal turns succeed.
 *
 * This module publishes the same rewrite logic on a process-global symbol so
 * other extensions can apply it to their own outbound requests. The contract is
 * intentionally tiny and versioned; consumers resolve it defensively and keep
 * working when client-mimic is absent, disabled, or reloaded.
 *
 * Pattern matches `kun-retry`'s `Symbol.for(...)` hook registry: no import
 * coupling between extension packages, and reloads replace rather than stack.
 */

/** Process-global key. Consumers must use the same string via `Symbol.for`. */
export const REWRITE_SERVICE_KEY = Symbol.for("pi.client-mimic.rewrite-service");

/** Contract version; bump when the method signatures change. */
export const REWRITE_SERVICE_VERSION = 1;

export type RewritePhase = "turn" | "compaction" | "test";

/** Model coordinates; all fields may be empty strings when unknown. */
export interface RewriteModelInfo {
	provider: string;
	api: string;
	id: string;
}

export interface RewriteOutcome {
	/** Active profile key that applied, or null when nothing was applied. */
	profile: string | null;
	/** Reason nothing applied, for diagnostics. */
	skipped?: string;
}

export interface PatchOutcome extends RewriteOutcome {
	/** Payload after body patches (the original object when unchanged). */
	payload: unknown;
}

/**
 * Service surface exposed to other extensions.
 *
 * Ordering contract: `rewriteHeaders` mints the per-request identity (Codex
 * turn id), so callers that send a payload must call it *before*
 * `patchPayload` — exactly like pi's two hooks run for a normal turn.
 */
export interface ClientMimicRewriteService {
	version: typeof REWRITE_SERVICE_VERSION;
	/** Active profile key, or null when mimic is disabled or set to "off". */
	activeProfile(): string | null;
	/** Rewrite headers in place. Mints one per-request identity. */
	rewriteHeaders(headers: Record<string, string | null>, model: RewriteModelInfo): RewriteOutcome;
	/** Patch a provider payload using the identity minted by `rewriteHeaders`. */
	patchPayload(payload: unknown, model: RewriteModelInfo): PatchOutcome;
}

type GlobalWithService = typeof globalThis & {
	[key: symbol]: unknown;
};

/**
 * What the extension supplies; the factory adds the safety and diagnostics that
 * out-of-band consumers rely on (never throw, never mutate on failure).
 */
export interface RewriteHooks {
	/** Active profile key, or null when disabled / "off". */
	activeProfile(): string | null;
	/** Why no profile is active (diagnostics). */
	inactiveReason(): string;
	/** Apply header rewrites in place. May mint the per-request identity. */
	applyHeaders(headers: Record<string, string | null>): void;
	/** Apply payload patches; return the payload (the same object when unchanged). */
	applyPayload(payload: unknown): unknown;
}

/**
 * Build the published service from the extension's hooks. Header/payload
 * failures are contained: the request still goes out, unrewritten.
 */
export function createRewriteService(hooks: RewriteHooks): ClientMimicRewriteService {
	const profileOf = (): string | null => {
		try {
			return hooks.activeProfile();
		} catch {
			return null;
		}
	};
	const skipped = (): string => {
		try {
			return hooks.inactiveReason();
		} catch {
			return "inactive";
		}
	};
	const failure = (step: string, err: unknown): string =>
		`${step} failed: ${err instanceof Error ? err.message : String(err)}`;

	return {
		version: REWRITE_SERVICE_VERSION,
		activeProfile: profileOf,
		rewriteHeaders(headers) {
			const profile = profileOf();
			if (!profile) return { profile: null, skipped: skipped() };
			try {
				hooks.applyHeaders(headers);
				return { profile };
			} catch (err) {
				return { profile: null, skipped: failure("header rewrite", err) };
			}
		},
		patchPayload(payload) {
			const profile = profileOf();
			if (!profile) return { profile: null, payload, skipped: skipped() };
			if (payload === null || typeof payload !== "object") return { profile, payload };
			try {
				return { profile, payload: hooks.applyPayload(payload) };
			} catch (err) {
				return { profile: null, payload, skipped: failure("body rewrite", err) };
			}
		},
	};
}

/** Publish (or replace) the service for the current process. */
export function publishRewriteService(service: ClientMimicRewriteService): void {
	(globalThis as GlobalWithService)[REWRITE_SERVICE_KEY] = service;
}

/** Remove the service, but only when `service` is still the published one. */
export function clearRewriteService(service: ClientMimicRewriteService): void {
	const holder = globalThis as GlobalWithService;
	if (holder[REWRITE_SERVICE_KEY] === service) delete holder[REWRITE_SERVICE_KEY];
}
