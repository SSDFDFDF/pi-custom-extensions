/** Internal SDK adapter: identity is the SessionManager object, never an ID or last context. */
export interface RegisteredSession {
	sessionManager?: object;
	agent?: { abort?: () => void };
	_agentRunAbortRequested?: boolean;
	isStreaming?: boolean;
	isCompacting?: boolean;
}
interface SessionRecord { owner: WeakRef<RegisteredSession> }
const REGISTRY = Symbol.for("kun-retry.sessionRegistry.v1");
const PATCH = Symbol.for("kun-retry.sessionRegistry.patch.v1");
interface Registry { sessions: WeakMap<object, SessionRecord> }
const globals = globalThis as typeof globalThis & { [REGISTRY]?: Registry };
const registry = globals[REGISTRY] ??= { sessions: new WeakMap() };

/** Host injection hook for embedders that already own their AgentSession. */
export function registerSession(session: RegisteredSession): void {
	if (session.sessionManager && typeof session.sessionManager === "object") {
		registry.sessions.set(session.sessionManager, { owner: new WeakRef(session) });
	}
}

export function resolveSession(manager: object | undefined): RegisteredSession | undefined {
	if (!manager) return undefined;
	const session = registry.sessions.get(manager)?.owner.deref();
	return session?.sessionManager === manager ? session : undefined;
}

export function forgetSession(session: RegisteredSession): void {
	const manager = session.sessionManager;
	if (manager && registry.sessions.get(manager)?.owner.deref() === session) registry.sessions.delete(manager);
}

/** _bindExtensionCore runs on construction AND reload, before session_start. */
export function installSessionRegistry(agentSessionClass: unknown): { installed: boolean; reason?: string } {
	const proto = (agentSessionClass as { prototype?: Record<PropertyKey, unknown> } | undefined)?.prototype;
	if (!proto) return { installed: false, reason: "AgentSession prototype unavailable" };
	if (Object.hasOwn(proto, PATCH)) return { installed: true };
	const methods = ["_bindExtensionCore", "bindExtensions"].filter(name => typeof proto[name] === "function");
	if (!methods.includes("_bindExtensionCore")) {
		return { installed: false, reason: "AgentSession._bindExtensionCore unavailable; session-scoped watchdog disabled" };
	}
	for (const name of methods) {
		const original = proto[name] as (this: RegisteredSession, ...args: unknown[]) => unknown;
		proto[name] = function (this: RegisteredSession, ...args: unknown[]) {
			const manager = this.sessionManager;
			const previous = manager && registry.sessions.get(manager);
			registerSession(this);
			const registration = manager && registry.sessions.get(manager);
			const rollback = () => {
				if (!manager || registry.sessions.get(manager) !== registration) return;
				if (previous) registry.sessions.set(manager, previous);
				else registry.sessions.delete(manager);
			};
			try {
				const result = original.apply(this, args);
				if (result instanceof Promise) return result.catch(error => { rollback(); throw error; });
				return result;
			} catch (error) { rollback(); throw error; }
		};
	}
	Object.defineProperty(proto, PATCH, { value: true });
	return { installed: true };
}
