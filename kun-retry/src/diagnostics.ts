export interface RetryDiagnostic {
	at: string;
	phase: string;
	sessionId?: string;
	[key: string]: unknown;
}

type SimpleValue = string | number | boolean | null;
type MetadataValue = SimpleValue | SimpleValue[];

const DEFAULT_LIMIT = 100;
const MAX_FIELDS = 32;
const MAX_KEY_LENGTH = 64;
const MAX_STRING_LENGTH = 256;
const MAX_ARRAY_LENGTH = 20;

function cleanString(value: string): string {
	// Keep traces single-line and prevent provider-controlled terminal escapes.
	return value.slice(0, MAX_STRING_LENGTH).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function sensitiveKey(key: string): boolean {
	const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
	if (normalized === "at" || normalized === "phase" ||
		/^(?:__proto__|prototype|constructor)$/.test(key) ||
		/(?:payload|content|apikey|token|headers?|errormessage|password|secret|credential|authorization|cookie|prompt|stack)/.test(normalized)) return true;
	if (/^(?:textlength|messageid|requestid|responseid|responsestatus|errorname|errorcount)$/.test(normalized)) return false;
	return /(?:text|message|body|raw)/.test(normalized) || /^(?:request|response|error|data)/.test(normalized);
}

function simpleValue(value: unknown): SimpleValue | undefined {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") return cleanString(value);
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return undefined;
}

/** Only flat, bounded JSON metadata: no Error, nested provider objects, getters or toJSON. */
function sanitize(data: Record<string, unknown> | undefined): Record<string, MetadataValue> {
	const clean: Record<string, MetadataValue> = {};
	if (!data || typeof data !== "object") return clean;
	try {
		let count = 0;
		for (const key of Reflect.ownKeys(data)) {
			if (count >= MAX_FIELDS) break;
			if (typeof key !== "string" || key.length > MAX_KEY_LENGTH || /[\u0000-\u001f\u007f-\u009f]/.test(key) || sensitiveKey(key)) continue;
			try {
				const descriptor = Object.getOwnPropertyDescriptor(data, key);
				if (!descriptor?.enumerable || !("value" in descriptor)) continue;
				const value = descriptor.value;
				let cleaned: MetadataValue | undefined = simpleValue(value);
				if (Array.isArray(value)) {
					const items: SimpleValue[] = [];
					for (let i = 0; i < Math.min(value.length, MAX_ARRAY_LENGTH); i++) {
						const item = Object.getOwnPropertyDescriptor(value, String(i));
						const primitive = item && "value" in item ? simpleValue(item.value) : undefined;
						if (primitive !== undefined) items.push(primitive);
					}
					cleaned = items;
				}
				if (cleaned !== undefined) {
					// sessionId's public type remains a string even for malformed runtime data.
					if (key === "sessionId" && typeof cleaned !== "string") continue;
					clean[key] = cleaned;
					count++;
				}
			} catch {
				// Ignore hostile proxies or descriptors without losing other safe metadata.
			}
		}
	} catch {
		// A proxy may throw even while enumerating keys.
	}
	return clean;
}

function copyEntry(entry: RetryDiagnostic): RetryDiagnostic {
	const copy = { ...entry };
	for (const key of Object.keys(copy)) {
		if (Array.isArray(copy[key])) copy[key] = [...copy[key]];
	}
	return copy;
}

/**
 * In-memory recording is always on; enabled only controls opt-in trace persistence.
 * Callers must supply runtime metadata, not provider data disguised as metadata:
 * reason is a short runtime-owned classification, never a raw error.message.
 */
export function createRetryDiagnostics(persist?: (entry: RetryDiagnostic) => void, limit = DEFAULT_LIMIT) {
	const capacity = Number.isSafeInteger(limit) && limit >= 0 ? limit : DEFAULT_LIMIT;
	const ring: RetryDiagnostic[] = [];
	let start = 0;
	let traceOn = false;
	let disposed = false;

	function entries(): RetryDiagnostic[] {
		return Array.from({ length: ring.length }, (_, index) => copyEntry(ring[(start + index) % ring.length]));
	}

	return {
		get enabled() {
			return traceOn;
		},
		set enabled(value: boolean) {
			if (!disposed) traceOn = Boolean(value);
		},
		record(phase: string, data?: Record<string, unknown>) {
			if (disposed) return;
			const metadata = sanitize(data);
			// A getter/proxy could have called dispose() while metadata was being inspected.
			if (disposed) return;
			const entry: RetryDiagnostic = {
				...metadata,
				at: new Date().toISOString(),
				phase: typeof phase === "string" ? cleanString(phase) : "unknown",
			};
			if (capacity > 0) {
				if (ring.length < capacity) ring.push(entry);
				else {
					ring[start] = entry;
					start = (start + 1) % capacity;
				}
			}
			if (traceOn && persist && !disposed) {
				try {
					// Persistence must not be able to mutate the private in-memory ring.
					persist(copyEntry(entry));
				} catch {
					// Old session appendEntry callbacks can throw after shutdown/reload.
				}
			}
		},
		entries,
		clear() {
			ring.length = 0;
			start = 0;
		},
		format() {
			const recent = entries().slice(-20);
			const heading = `kun-retry trace ${traceOn ? "ON" : "OFF"} — ${ring.length} retained, latest ${recent.length}`;
			if (recent.length === 0) return `${heading}\n(no diagnostic entries)`;
			return [heading, ...recent.map((entry) => {
				const metadata = Object.entries(entry)
					.filter(([key]) => key !== "at" && key !== "phase")
					.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
					.join(" ");
				return `${entry.at} ${entry.phase}${metadata ? ` ${metadata}` : ""}`;
			})].join("\n");
		},
		dispose() {
			disposed = true;
			traceOn = false;
		},
	};
}
