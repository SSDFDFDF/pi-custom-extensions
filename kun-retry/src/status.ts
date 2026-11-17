import { formatDelay } from "./retry-patch.ts";

export interface RetryStatusConfig {
	enabled: boolean;
	nl: boolean;
	constantDelayMs: number;
}

export interface RetryStatusContext {
	hasUI: boolean;
	ui: { setStatus(key: string, text: string | undefined): void };
}

export interface RetryStatusInfo {
	attempt: number;
	delayMs: number;
	maxRetries?: number;
}

const STATUS_KEY = "kun-retry";
const RECEIVING_MS = 1_500;
const RETRY_MS = 8_000;
const MAX_TIMER_MS = 2_147_483_647;

/** Session-scoped footer state. dispose() is terminal; create a new instance on reload. */
export function createRetryStatus(
	getConfig: () => RetryStatusConfig,
	getRotationSuffix: () => string = () => "",
) {
	let disposed = false;
	let writer: ((text: string | undefined) => void) | undefined;
	let transient: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let generation = 0;
	let lastText: string | undefined;
	let hasWritten = false;

	function cancelTimer() {
		generation++;
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	}

	function writeStatus(text: string | undefined) {
		if (disposed || !writer || (hasWritten && lastText === text)) return;
		const currentWriter = writer;
		const currentGeneration = generation;
		try {
			currentWriter(text);
			if (!disposed && writer === currentWriter && generation === currentGeneration) {
				lastText = text;
				hasWritten = true;
			}
		} catch {
			// Stale raw UI objects and unsupported UI implementations are best-effort.
		}
	}

	function stableText(config: RetryStatusConfig): string | undefined {
		const rotation = getRotationSuffix().trim();
		const suffix = rotation ? ` ${rotation}` : "";
		if (config.nl) {
			const delay = config.constantDelayMs > 0 ? ` @${formatDelay(config.constantDelayMs)}` : "";
			return `nl∞${delay}${suffix}`;
		}
		return rotation ? `retry${suffix}` : undefined;
	}

	function refresh() {
		if (disposed) return;
		try {
			const config = getConfig();
			if (!config.enabled) {
				cancelTimer();
				transient = undefined;
				writeStatus(undefined);
			} else {
				writeStatus(transient ?? stableText(config));
			}
		} catch {
			// Config/suffix callbacks must not turn a footer update into a runtime error.
		}
	}

	function clear() {
		if (disposed) return;
		cancelTimer();
		transient = undefined;
		refresh();
	}

	function restoreAfter(visibleMs: number) {
		const currentGeneration = generation;
		// Chunk very long waits rather than letting Node clamp an overflowing timer to 1ms.
		const schedule = (remaining: number) => {
			const chunk = Math.min(remaining, MAX_TIMER_MS);
			timer = setTimeout(() => {
				if (disposed || generation !== currentGeneration) return;
				timer = undefined;
				if (remaining > chunk) {
					schedule(remaining - chunk);
				} else {
					transient = undefined;
					refresh();
				}
			}, chunk);
			timer.unref?.();
		};
		schedule(visibleMs);
	}

	function show(text: string, visibleMs: number) {
		if (disposed || !writer) return;
		cancelTimer();
		const currentGeneration = generation;
		transient = text;
		refresh();
		if (!disposed && generation === currentGeneration && transient !== undefined) restoreAfter(visibleMs);
	}

	return {
		capture(ctx: RetryStatusContext) {
			if (disposed) return;
			writer = undefined;
			hasWritten = false;
			try {
				if (!ctx.hasUI) return;
				// Read each lifecycle-guarded getter once; never retain ctx in a closure.
				const ui = ctx.ui;
				const setStatus = ui.setStatus;
				if (typeof setStatus !== "function" || disposed) return;
				writer = (text) => setStatus.call(ui, STATUS_KEY, text);
			} catch {
				// hasUI, ui, and even setStatus may be throwing getters after shutdown.
			}
		},
		clear,
		receiving() {
			show("receiving", RECEIVING_MS);
		},
		retry(info?: RetryStatusInfo) {
			if (disposed) return;
			try {
				const config = getConfig();
				const base = config.nl ? "retrying∞" : "retrying";
				if (!info) {
					show(base, RETRY_MS);
					return;
				}
				const delayMs = Number.isFinite(info.delayMs) ? Math.max(0, info.delayMs) : 0;
				const budget = !config.nl && info.maxRetries !== undefined ? `/${info.maxRetries}` : "";
				show(`${base} ${info.attempt}${budget} @${formatDelay(delayMs)}`, delayMs + RETRY_MS);
			} catch {
				// A failing config getter must not interfere with retry itself.
			}
		},
		refresh,
		dispose() {
			if (disposed) return;
			disposed = true;
			cancelTimer();
			transient = undefined;
			writer = undefined;
			hasWritten = false;
		},
	};
}
