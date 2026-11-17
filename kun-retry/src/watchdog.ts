export interface StallWatchdogOptions {
	getTimeoutMs(): number;
	isEnabled(): boolean;
	/**
	 * The caller owns session binding and user-abort guards. Never fall back to ctx.abort().
	 * A direct abort may synchronously emit message_end; unavailable must not abort anything.
	 */
	abort(): "direct" | "unavailable";
	/** Called only after a direct abort succeeds. */
	onStall?(): void;
	/** Notification only: an unavailable route must not produce a retryable message. */
	onUnavailable?(): void;
	record?: (phase: string, data?: Record<string, unknown>) => void;
}

export interface StallWatchdog {
	/** Begin a provider request, discarding any previous abort marker. */
	start(): void;
	/** Record real activity without allocating or clearing a timer. */
	touch(): void;
	/** Stop timing, preserving the marker for message_end. */
	stop(): void;
	/** Read and clear the one-shot watchdog-abort marker. */
	consumeAbort(): boolean;
	/** Permanently shut down this watchdog and discard its marker. */
	dispose(): void;
}

// Node clamps larger delays to 1ms. Keep the real deadline and check it in chunks.
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Independent inactivity timer; no Pi context, configuration files, or message mutation. */
export function createStallWatchdog(options: StallWatchdogOptions): StallWatchdog {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastActivity = 0;
	let active = false;
	let disposed = false;
	let generation = 0;
	let pendingAbort = false;

	// Observers must not break control flow, even if a void callback returns a promise.
	function observe(callback: (() => void) | undefined): void {
		try {
			const result: unknown = callback?.();
			if (result && typeof (result as PromiseLike<unknown>).then === "function") {
				void Promise.resolve(result).catch(() => {});
			}
		} catch {
			// Logging/UI failures are deliberately non-fatal.
		}
	}

	function record(phase: string, data?: Record<string, unknown>): void {
		observe(() => options.record?.(phase, data));
	}

	function sameRequest(expected: number): boolean {
		return !disposed && generation === expected;
	}

	function isActive(expected: number): boolean {
		return active && sameRequest(expected);
	}

	function stop(): void {
		active = false;
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	}

	function timeoutMs(): number {
		if (!options.isEnabled()) return 0;
		const value = options.getTimeoutMs();
		return Number.isFinite(value) && value > 0 ? value : 0;
	}

	function timerFailed(expected: number, error: unknown): void {
		if (!isActive(expected)) return;
		stop();
		record("timer_failed", { errorName: error instanceof Error ? error.name : "unknown" });
	}

	function schedule(expected: number, delayMs: number): void {
		timer = setTimeout(() => {
			// A cleared/queued callback cannot affect a stopped, replaced, or disposed request.
			if (!isActive(expected)) return;
			timer = undefined;
			try {
				check(expected);
			} catch (error) {
				timerFailed(expected, error);
			}
		}, Math.min(MAX_TIMER_MS, Math.max(1, Math.ceil(delayMs))));
		timer.unref?.();
	}

	function check(expected: number): void {
		// Re-read dynamic configuration at every deadline check, not every token.
		const timeout = timeoutMs();
		if (!isActive(expected)) return;
		if (timeout === 0) {
			stop();
			return;
		}
		const idleMs = Date.now() - lastActivity;
		const remainingMs = timeout - idleMs;
		if (remainingMs > 0) {
			schedule(expected, remainingMs);
			return;
		}

		record("stall", { timeoutMs: timeout, idleMs });
		if (!isActive(expected)) return;
		stop(); // One abort attempt per provider request, including failure/unavailability.

		// Provisional until abort returns: direct abort may synchronously emit message_end,
		// whose handler calls stop() and consumeAbort(). Never re-arm an already consumed marker.
		pendingAbort = true;
		let route: "direct" | "unavailable";
		try {
			route = options.abort();
		} catch (error) {
			if (!sameRequest(expected)) return;
			pendingAbort = false;
			record("abort_failed", { errorName: error instanceof Error ? error.name : "unknown" });
			return;
		}
		if (!sameRequest(expected)) return;
		if (route === "unavailable") {
			pendingAbort = false;
			record("abort_unavailable");
			if (sameRequest(expected)) observe(() => options.onUnavailable?.());
		} else {
			record("abort_direct");
			if (sameRequest(expected)) observe(() => options.onStall?.());
		}
	}

	return {
		start() {
			stop();
			pendingAbort = false;
			const expected = ++generation;
			if (disposed) return;
			lastActivity = Date.now();
			active = true;
			try {
				const timeout = timeoutMs();
				if (!isActive(expected)) return;
				if (timeout === 0) stop();
				else schedule(expected, timeout);
			} catch (error) {
				timerFailed(expected, error);
			}
		},
		touch() {
			if (active && !disposed) lastActivity = Date.now();
		},
		stop,
		consumeAbort() {
			const pending = pendingAbort;
			pendingAbort = false;
			return pending;
		},
		dispose() {
			stop();
			disposed = true;
			pendingAbort = false;
			generation++;
		},
	};
}
