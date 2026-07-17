/**
 * Error matching for kun-retry.
 * Built-in Pi already retries many transient strings; we expand that set and
 * inject `provider returned error` so `_prepareRetry` picks them up.
 */

export const RETRYABLE_HINT = "provider returned error";

/** Tag used when rewriting an empty provider response into a retryable error. */
export const EMPTY_RESPONSE_TAG = "[kun-retry-empty-response]";

type ContentBlock = { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown };

/**
 * True when an assistant message carries no usable *final* output: no tool
 * calls and no non-whitespace text. Providers occasionally return HTTP 200 with
 * an empty body / zero content blocks; because the stopReason is not "error",
 * Pi's built-in classifier never treats it as retryable.
 *
 * Thinking is deliberately NOT counted as usable output: a turn that produced
 * only reasoning and no answer text or tool call is a failed turn from the
 * user's perspective, so it is treated as empty (retryable).
 */
export function isEmptyAssistantContent(content: unknown): boolean {
	if (!Array.isArray(content)) return true;
	for (const raw of content) {
		if (typeof raw !== "object" || raw === null) continue;
		const block = raw as ContentBlock;
		if (block.type === "toolCall") return false;
		// Thinking-only turns count as empty: reasoning without an answer or tool
		// call is not usable output, so skip thinking blocks entirely.
		if (block.type === "thinking") continue;
		if (block.type === "text") {
			if (typeof block.text === "string" && block.text.trim()) return false;
			continue;
		}
		// Unknown block type with any content is treated as non-empty to stay safe.
		return false;
	}
	return true;
}

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

/**
 * Built-in transport / stream failures that Pi's classifier misses.
 * Always enabled (not gated on user errorPatterns). Keep these conservative:
 * only transient disconnect / empty-body style errors, not auth or quota.
 */
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
	// Pi builtin covers "ended without" and Anthropic "before message_stop",
	// but not OpenAI Responses' "before a terminal response event".
	{
		tag: "[openai-responses-stream-retry]",
		label: "OpenAI Responses premature stream end",
		re: /stream ended before a terminal(?: response)? event/i,
	},
	// Codex WS: "WebSocket stream closed before response.completed".
	// Builtin has websocket.?closed but that does not match "stream closed".
	{
		tag: "[websocket-stream-closed-retry]",
		label: "WebSocket stream closed before completion",
		re: /(?:web\s*socket\s+)?stream closed before response\.completed|websocket stream closed before/i,
	},
	// Empty HTTP/SSE body from Codex / Anthropic stream iterators.
	{
		tag: "[no-response-body-retry]",
		label: "provider response with no body",
		re: /\bNo response body\b|response with no body|iterate over an?\s+\w+\s+response with no body/i,
	},
	// Generic provider catch-alls that often wrap transient upstream failures.
	{
		tag: "[unknown-error-occurred-retry]",
		label: "generic unknown provider error",
		re: /\bAn unknown error occurred\b|Provider returned an error stop reason/i,
	},
	// Node/undici errno strings that are not wrapped as "connection error".
	{
		tag: "[network-errno-retry]",
		label: "network errno / socket failure",
		re: /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET)\b/i,
	},
	// Plain gateway text without an HTTP status token.
	{
		tag: "[bad-gateway-retry]",
		label: "bad gateway / cloudflare edge failure",
		re: /\bbad\s*gateway\b|\bcloudflare\b.*\b(?:error|timeout|unavailable)\b|\borigin is unreachable\b/i,
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
