/** Stall cancellation stops only the owning provider stream. User abort is NEVER patched. */
import { installSessionRegistry, resolveSession } from "./session-registry.ts";

export type SoftAbortMode = "direct" | "unavailable";
export interface SoftAbortInstallResult { installed: boolean; reason?: string }

export function installSoftAbortPatch(agentSessionClass: unknown): SoftAbortInstallResult {
	// Neutralize retained v1 globals on /reload. Its old abort wrapper becomes
	// a pass-through; removing it mechanically could destroy another extension's wrapper.
	const legacy = globalThis as Record<symbol, unknown>;
	legacy[Symbol.for("kun-retry.softAbort.capture")] = undefined;
	legacy[Symbol.for("kun-retry.softAbort.armed")] = undefined;
	return installSessionRegistry(agentSessionClass);
}

export function canSoftAbort(manager: object | undefined): boolean {
	const session = resolveSession(manager);
	return !!session && !session._agentRunAbortRequested && !session.isCompacting &&
		session.isStreaming !== false && typeof session.agent?.abort === "function";
}

/** No deferred/global armed flag and no hard-abort fallback: unknown ownership fails closed. */
export function beginSoftAbort(manager: object | undefined): SoftAbortMode {
	if (!canSoftAbort(manager)) return "unavailable";
	const session = resolveSession(manager)!;
	session.agent!.abort!.call(session.agent);
	return "direct";
}
