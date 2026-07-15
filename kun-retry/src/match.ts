/**
 * Error matching for kun-retry.
 * Built-in Pi already retries many transient strings; we expand that set and
 * inject `provider returned error` so `_prepareRetry` picks them up.
 */

export const RETRYABLE_HINT = "provider returned error";

/**
 * Substrings Pi's built-in classifier treats as NON-retryable (quota/billing),
 * checked BEFORE its retryable patterns. If any survive in errorMessage, the
 * built-in `isRetryableAssistantError` returns false regardless of our injected
 * hint. In nl ("retry any error") mode we neutralize them so the built-in retry
 * path actually engages. Bounded modes leave them intact on purpose so quota
 * exhaustion is not silently retried unless the user opted into nl.
 */
export const NON_RETRYABLE_TOKENS: string[] = [
	"GoUsageLimitError",
	"FreeUsageLimitError",
	"Monthly usage limit reached",
	"available balance",
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
];

const NON_RETRYABLE_RE = new RegExp(NON_RETRYABLE_TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");

/**
 * Break known non-retryable trigger words with a zero-width space so Pi's
 * built-in classifier no longer short-circuits to non-retryable. Text stays
 * human-readable; the marker is invisible.
 */
export function neutralizeNonRetryable(errorMessage: string): { text: string; neutralized: string[] } {
	const neutralized: string[] = [];
	const text = errorMessage.replace(NON_RETRYABLE_RE, (m) => {
		neutralized.push(m);
		return `${m[0]}\u200b${m.slice(1)}`;
	});
	return { text, neutralized };
}

/** Legacy pi-retry patterns (always enabled). */
export const LEGACY_PATTERNS: Array<{ tag: string; label: string; re: RegExp }> = [
	{
		tag: "[unknown-error-retry]",
		label: "empty-detail provider failure",
		re: /Unknown error \(no error details in response\)/i,
	},
	{
		tag: "[codex-websocket-limit-retry]",
		label: "Codex websocket connection limit",
		re: /websocket[_\s-]*connection[_\s-]*limit[_\s-]*reached|create a new websocket connection to continue/i,
	},
];

const CODEX_GENERIC_PROCESSING_RE =
	/Codex error:[\s\S]*An error occurred while processing your request/i;
const CODEX_GENERIC_RETRY_PROMPT_RE = /You can retry your request/i;

export type MatchResult = {
	tag: string;
	label: string;
	notification: string;
};

function compileUserPattern(source: string): RegExp | undefined {
	try {
		return new RegExp(source, "i");
	} catch {
		return undefined;
	}
}

/** Match a status code when it appears as its own token / HTTP status in the text. */
export function matchesStatusCode(errorMessage: string, code: number): boolean {
	const n = String(code);
	// HTTP 403 / status 403 / status code 403 / 403 Forbidden / "403"
	const re = new RegExp(
		`(?:\\bHTTP[_\\s-]*${n}\\b|\\bstatus(?:\\s*code)?[_\\s:=-]+${n}\\b|\\b${n}\\b(?:\\s*(?:Forbidden|Unauthorized|Error|error))?|\\(${n}\\)|\\[${n}\\])`,
		"i",
	);
	return re.test(errorMessage);
}

export function matchRetryableError(
	errorMessage: string,
	opts: {
		nl: boolean;
		statusCodes: number[];
		errorPatterns: string[];
	},
): MatchResult | undefined {
	if (opts.nl) {
		return {
			tag: "[kun-retry-nl]",
			label: "no-limit mode (any error)",
			notification: "nl mode: treating every provider error as retryable.",
		};
	}

	for (const legacy of LEGACY_PATTERNS) {
		if (legacy.re.test(errorMessage)) {
			return {
				tag: legacy.tag,
				label: legacy.label,
				notification: `Matched ${legacy.label}; letting Pi auto-retry this turn.`,
			};
		}
	}

	if (CODEX_GENERIC_PROCESSING_RE.test(errorMessage) && CODEX_GENERIC_RETRY_PROMPT_RE.test(errorMessage)) {
		return {
			tag: "[codex-generic-retry]",
			label: "Codex retryable backend failure",
			notification: "Matched Codex generic retryable backend failure; letting Pi auto-retry this turn.",
		};
	}

	for (const code of opts.statusCodes) {
		if (matchesStatusCode(errorMessage, code)) {
			return {
				tag: `[kun-retry-http-${code}]`,
				label: `HTTP ${code}`,
				notification: `Matched HTTP ${code} in provider error; letting Pi auto-retry this turn.`,
			};
		}
	}

	for (const source of opts.errorPatterns) {
		const re = compileUserPattern(source);
		if (!re) continue;
		if (re.test(errorMessage)) {
			return {
				tag: "[kun-retry-pattern]",
				label: `pattern /${source}/`,
				notification: `Matched error pattern /${source}/; letting Pi auto-retry this turn.`,
			};
		}
	}

	return undefined;
}

export function appendRetryHint(errorMessage: string, match: MatchResult): string {
	if (errorMessage.includes(match.tag) && errorMessage.includes(RETRYABLE_HINT)) {
		return errorMessage;
	}
	return `${errorMessage}\n\n${match.tag} ${RETRYABLE_HINT}; treating ${match.label} as retryable.`;
}
