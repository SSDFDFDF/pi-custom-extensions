import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

/**
 * Real SDK construction, resource loading, ExtensionRunner dispatch, persistence,
 * agent loop, retry and abort. Only the provider transport is synthetic. No
 * Object.create/prototype-only sessions, fake clocks, or patched core retry.
 *
 * Reference: docs/sdk.md, examples/sdk/06-extensions.ts and docs/extensions.md
 * (inline factories, session lifecycle, stale contexts and provider streams).
 */
const PROVIDER = "test-provider";
const MODEL_ID = "local-sdk-lifecycle";
const BOUND_MS = 3_000;

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

async function bounded(promise, label) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), BOUND_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

// pi-ai need not be a direct dependency of the extension. Resolve the SDK's
// actual installed copy, including import-only package exports (require.resolve
// cannot resolve pi-ai/compat in those versions).
function resolveSdkCompat(sdkUrl) {
	const sdkFile = realpathSync(fileURLToPath(sdkUrl));
	const require = createRequire(sdkFile);
	for (const base of require.resolve.paths("@earendil-works/pi-ai") ?? []) {
		const packageDir = join(base, "@earendil-works/pi-ai");
		const manifest = join(packageDir, "package.json");
		if (!existsSync(manifest)) continue;
		const pkg = JSON.parse(readFileSync(manifest, "utf8"));
		const entry = pkg.exports["./compat"];
		return pathToFileURL(join(packageDir, typeof entry === "string" ? entry : entry.import)).href;
	}
	throw new Error(`Cannot resolve SDK pi-ai/compat from ${dirname(sdkFile)}`);
}

const assistants = (messages) => messages.filter((message) => message.role === "assistant");
const retryStarts = (probe) => probe.events.filter((event) => event.type === "auto_retry_start");

test("kun-retry: complete offline SDK lifecycle", { timeout: 30_000 }, async (t) => {
	// Set isolation BEFORE importing SDK/index.ts: even import-time defaults must
	// not observe the developer's real agent configuration or credential files.
	const root = mkdtempSync(join(tmpdir(), "kun-retry-sdk-lifecycle-"));
	const envNames = ["HOME", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_RETRY_STALL_TIMEOUT_MS"];
	const oldEnv = new Map(envNames.map((name) => [name, process.env[name]]));
	const home = join(root, "home");
	mkdirSync(home);
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = join(root, "bootstrap-agent");
	mkdirSync(process.env.PI_CODING_AGENT_DIR);
	process.env.PI_OFFLINE = "1";
	delete process.env.PI_RETRY_STALL_TIMEOUT_MS;
	let networkCalls = 0;
	const noNetwork = () => {
		networkCalls += 1;
		throw new Error("SDK lifecycle test forbids every network connection/provider HTTP call");
	};
	for (const [target, methods] of [
		[globalThis, ["fetch"]], [http, ["request", "get"]], [https, ["request", "get"]],
		[net, ["connect", "createConnection"]], [tls, ["connect"]],
	]) {
		for (const method of methods) t.mock.method(target, method, noNetwork);
	}
	t.after(() => {
		for (const [name, value] of oldEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(root, { recursive: true, force: true });
		assert.equal(networkCalls, 0, "no HTTP, fetch, TCP or TLS transport was invoked");
	});

	const sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
	const { AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(sdkUrl);
	const { createAssistantMessageEventStream } = await import(resolveSdkCompat(sdkUrl));
	const originalAbort = AgentSession.prototype.abort;
	const { default: kunRetry } = await import("../src/index.ts");
	const { DEFAULT_CONFIG, saveConfig } = await import("../src/config.ts");
	const { installSessionRegistry, registerSession, resolveSession, forgetSession } = await import("../src/session-registry.ts");
	const { installConstantDelayPatch } = await import("../src/retry-patch.ts");
	const { beginSoftAbort, canSoftAbort } = await import("../src/soft-abort.ts");

	function assistant(model, stopReason = "stop", text = "local synthetic success") {
		return {
			role: "assistant", content: text ? [{ type: "text", text }] : [],
			api: model.api, provider: model.provider, model: model.id,
			usage: {
				input: 1, output: text ? 1 : 0, cacheRead: 0, cacheWrite: 0, totalTokens: text ? 2 : 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason, timestamp: Date.now(),
			...(stopReason === "error" ? { errorMessage: "HTTP 401: synthetic local credential rejection" } : {}),
			...(stopReason === "aborted" ? { errorMessage: "Synthetic provider stream aborted" } : {}),
		};
	}

	let fixtureNumber = 0;
	async function fixture(st, config = {}) {
		const dir = join(root, `fixture-${++fixtureNumber}`);
		const agentDir = join(dir, "agent");
		const cwd = join(dir, "workspace");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const cfg = saveConfig({
			...DEFAULT_CONFIG, constantDelayMs: 1, baseDelayMs: 17, maxRetries: 2,
			stallTimeoutMs: 50, nl: false, switchAfterErrors: 0, ...config,
		});
		assert.ok(existsSync(join(agentDir, "kun-retry.config.json")));
		const probes = [];
		const runtimes = [];
		st.after(async () => {
			try {
				for (const probe of probes) {
					try { await bounded(probe.session.abort(), "fixture abort"); }
					finally {
						try { await probe.shutdown(); }
						finally { probe.session.dispose(); forgetSession(probe.session); }
					}
				}
				for (const runtime of runtimes) await runtime.settleCredentialWrites();
				for (const probe of probes) {
					assert.deepEqual(probe.errors, [], "lifecycle/shutdown handlers must not silently fail");
					assert.deepEqual(probe.providerErrors, [], "local provider must not silently fail");
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		async function create({ persist = false, stream = () => ({ kind: "success" }), coreSettings = {} } = {}) {
			const runtime = await ModelRuntime.create({
				refreshOnCreate: false, allowModelNetwork: false, modelsPath: null,
				authPath: join(agentDir, `auth-${runtimes.length}.json`),
				modelsStorePath: join(agentDir, `models-store-${runtimes.length}.json`),
			});
			runtimes.push(runtime);
			const requests = [];
			const providerErrors = [];
			let streamPolicy = stream;
			const fakeStream = (model, context, options = {}) => {
				assert.equal(model.provider, PROVIDER);
				assert.equal(model.id, MODEL_ID);
				const output = createAssistantMessageEventStream();
				const request = {
					messages: structuredClone(context.messages), options,
					started: deferred(), signal: options.signal,
				};
				requests.push(request);
				// Behave like a local provider: forward lifecycle callbacks, never
				// serialize/send HTTP. This exercises the actual SDK callback chain.
				queueMicrotask(async () => {
					try {
						const plan = streamPolicy(requests.length, request);
						await options.onPayload?.({ local: true, attempt: requests.length }, model);
						await options.onResponse?.({ status: 200, headers: {} }, model);
						await options.onProviderStreamEvent?.({ local: true }, model);
						const partial = assistant(model, "stop", "");
						output.push({ type: "start", partial });
						request.started.resolve();
						if (plan.kind === "hold") {
							await new Promise((done) => {
								if (options.signal?.aborted) done();
								else options.signal.addEventListener("abort", done, { once: true });
							});
							const error = assistant(model, "aborted", "");
							output.push({ type: "error", reason: "aborted", error });
							output.end();
							return;
						}
						if (plan.kind === "error") {
							const error = assistant(model, "error", "");
							output.push({ type: "error", reason: "error", error });
						} else {
							partial.content.push({ type: "text", text: "" });
							output.push({ type: "text_start", contentIndex: 0, partial });
							partial.content[0].text = plan.text ?? "local synthetic success";
							output.push({ type: "text_delta", contentIndex: 0, delta: partial.content[0].text, partial });
							output.push({ type: "text_end", contentIndex: 0, content: partial.content[0].text, partial });
							const message = assistant(model, "stop", partial.content[0].text);
							output.push({ type: "done", reason: "stop", message });
						}
						output.end();
					} catch (error) {
						providerErrors.push(error);
						const message = { ...assistant(model, "error", ""), errorMessage: String(error) };
						output.push({ type: "error", reason: "error", error: message });
						output.end();
					}
				});
				return output;
			};
			runtime.registerProvider(PROVIDER, {
				name: "Offline lifecycle provider", api: "openai-completions",
				baseUrl: "http://127.0.0.1:1/never-connect", streamSimple: fakeStream,
				models: [{
					id: MODEL_ID, name: "Local synthetic model", reasoning: false, input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000, maxTokens: 64,
				}],
			});
			await runtime.setRuntimeApiKey(PROVIDER, "fake-test-key");
			assert.equal(runtime.hasConfiguredAuth(PROVIDER), true);
			// Preserve the SDK Agent streamFn and its event/auth wiring; replace
			// the runtime's transport, covering both direct and summary routes.
			runtime.streamSimple = fakeStream;
			const model = runtime.getModel(PROVIDER, MODEL_ID);
			assert.ok(model);
			const settingsManager = SettingsManager.inMemory({
				packages: [], extensions: [], skills: [], defaultProjectTrust: "never",
				cacheWarming: "off", compaction: { enabled: false },
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 17, provider: { maxRetries: 0 }, ...coreSettings },
			});
			const manager = persist ? SessionManager.create(cwd, join(dir, `sessions-${probes.length}`)) : SessionManager.inMemory(cwd);
			const lifecycle = [];
			const errors = [];
			const generations = [];
			const captures = [];
			let shutdown = false;
			const loader = new DefaultResourceLoader({
				cwd, agentDir, settingsManager,
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				systemPrompt: "Offline lifecycle integration test. Never execute tools.", appendSystemPrompt: [],
				extensionFactories: [(pi) => {
					const generation = { pi, contexts: [], stopped: false };
					generations.push(generation);
					// Register before kun-retry: this observer verifies owner capture
					// is already complete when the FIRST session_start handler runs.
					pi.on("session_start", (event, ctx) => {
						const owner = resolveSession(ctx.sessionManager);
						captures.push({ owner, manager: ctx.sessionManager });
						generation.contexts.push(ctx);
						shutdown = false;
						lifecycle.push({ type: event.type, reason: event.reason, generation, ctx });
					});
					pi.on("session_shutdown", (event, ctx) => {
						generation.stopped = true;
						shutdown = true;
						lifecycle.push({ type: event.type, reason: event.reason, generation, ctx });
					});
					kunRetry(pi);
				}],
			});
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, [], "noExtensions still loads non-builtin inline factories");
			assert.equal(loader.getExtensions().extensions.length, 1);
			const result = await createAgentSession({
				cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: "off",
				settingsManager, sessionManager: manager, resourceLoader: loader, noTools: "all",
			});
			const session = result.session;
			const events = [];
			session.subscribe((event) => events.push(event));
			const probe = {
				session, manager, runtime, loader, settingsManager, requests, events, errors,
				providerErrors, generations, lifecycle, captures,
				setStreamPolicy(next) { streamPolicy = next; },
				// SDK dispose invalidates ctx but does not emit shutdown. Embedders
				// emit it through the real runner before dispose (as SDK modes do).
				async shutdown() {
					if (shutdown) return;
					await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				},
				async bind() {
					await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
					assert.equal(captures.at(-1).owner, session);
					assert.equal(captures.at(-1).manager, manager);
				},
				async prompt(text = "Return a local synthetic answer") {
					await bounded(session.prompt(text), "real session.prompt");
					assert.deepEqual(providerErrors, [], "synthetic transport callbacks succeeded");
					assert.deepEqual(errors, [], "no swallowed ExtensionRunner handler failures");
				},
			};
			probes.push(probe);
			assert.ok(session instanceof AgentSession);
			assert.equal(session.sessionManager, manager);
			assert.equal(session.settingsManager, settingsManager);
			assert.equal(lifecycle.length, 0, "construction does not emit session_start");
			assert.equal(resolveSession(manager), session, "real constructor _bindExtensionCore captured owner before bind/start");
			assert.deepEqual(session.getActiveToolNames(), []);
			return probe;
		}
		return { agentDir, cwd, cfg, create };
	}

	await t.test("real construction associates exact manager before first bind/session_start", async (st) => {
		const f = await fixture(st);
		const probe = await f.create();
		assert.equal(canSoftAbort(probe.manager), false, "idle session is not abortable by watchdog");
		assert.equal(resolveSession({ getSessionId: () => probe.manager.getSessionId() }), undefined);
		await probe.bind();
		assert.deepEqual(probe.lifecycle.map(({ type, reason }) => [type, reason]), [["session_start", "startup"]]);
		assert.equal(probe.generations[0].contexts[0].isIdle(), true);
		assert.equal(AgentSession.prototype.abort, originalAbort, "kun-retry never patches user abort");
		const patchedRetry = AgentSession.prototype._prepareRetry;
		assert.equal(installConstantDelayPatch(AgentSession).installed, true);
		assert.equal(installSessionRegistry(AgentSession).installed, true);
		assert.equal(AgentSession.prototype._prepareRetry, patchedRetry, "one wrapper per prototype");
		forgetSession(probe.session);
		assert.equal(resolveSession(probe.manager), undefined);
		registerSession(probe.session);
		assert.equal(resolveSession(probe.manager), probe.session, "host injection restores exact owner");
		assert.equal(probe.requests.length, 0, "construction and binding made no model request");
	});

	await t.test("failed real bind rolls back capture; a successful bind restores it", async (st) => {
		const f = await fixture(st);
		const probe = await f.create();
		forgetSession(probe.session);
		// Invalid public bindings reject in the actual SDK async method. No
		// replacement _bindExtensionCore/bindExtensions body is used here.
		await assert.rejects(probe.session.bindExtensions(null), TypeError);
		assert.equal(resolveSession(probe.manager), undefined, "failed bind must not retain a new capture");
		assert.equal(probe.lifecycle.length, 0);
		registerSession(probe.session);
		await assert.rejects(probe.session.bindExtensions(null), TypeError);
		assert.equal(resolveSession(probe.manager), probe.session, "failed bind preserves prior successful/host capture");
		forgetSession(probe.session);
		await probe.bind();
		assert.equal(resolveSession(probe.manager), probe.session);
		assert.equal(probe.requests.length, 0);
	});

	await t.test("real reload preserves manager/session, recaptures registry and invalidates old ctx/pi", async (st) => {
		const f = await fixture(st);
		const probe = await f.create({
			coreSettings: { enabled: false, maxRetries: 0 },
			stream: (attempt) => ({ kind: attempt === 1 ? "error" : "success" }),
		});
		await probe.bind();
		const old = probe.generations[0];
		const oldContext = old.contexts[0];
		const retryWrapper = AgentSession.prototype._prepareRetry;
		forgetSession(probe.session);
		assert.equal(resolveSession(probe.manager), undefined);
		await bounded(probe.session.reload(), "real session.reload");
		assert.equal(probe.session.sessionManager, probe.manager);
		assert.equal(resolveSession(probe.manager), probe.session, "reload _bindExtensionCore restores capture without new manager");
		assert.equal(probe.generations.length, 2);
		assert.equal(old.stopped, true);
		assert.deepEqual(probe.lifecycle.map(({ type, reason }) => [type, reason]), [
			["session_start", "startup"], ["session_shutdown", "reload"], ["session_start", "reload"],
		]);
		const fresh = probe.generations[1].contexts[0];
		assert.notEqual(fresh, oldContext);
		assert.equal(fresh.sessionManager, probe.manager);
		assert.equal(fresh.isIdle(), true);
		assert.throws(() => oldContext.sessionManager, /stale/i);
		assert.throws(() => oldContext.isIdle(), /stale/i);
		assert.throws(() => old.pi.appendEntry("stale-write", {}), /stale/i);
		probe.generations[1].pi.appendEntry("fresh-write", { reload: true });
		assert.ok(probe.manager.getEntries().some((entry) => entry.customType === "fresh-write"));
		assert.equal(AgentSession.prototype._prepareRetry, retryWrapper, "reload does not stack retry wrappers");
		// New factory hooks must be usable even though in-memory core retry is
		// disabled: syncSettings supplies live policy without file-backed settings.
		await probe.prompt();
		assert.equal(probe.requests.length, 2);
		assert.deepEqual(retryStarts(probe).map((event) => event.delayMs), [1]);
		assert.equal(probe.settingsManager.getRetrySettings().enabled, false, "temporary retry settings shadow is restored");
	});

	await t.test("interleaved SDK sessions retain separate factories, live policies and shutdown resources", async (st) => {
		const f = await fixture(st, { syncSettings: false });
		const a = await f.create({ stream: (attempt) => ({ kind: attempt === 1 ? "error" : "success" }) });
		const b = await f.create({ stream: (attempt) => ({ kind: attempt === 1 ? "error" : "success" }) });
		assert.notEqual(a.manager, b.manager);
		// Config is intentionally a shared persisted file. Pin the watchdog
		// flag so its periodic config refresh does not reload A's policy from
		// B's command; this assertion isolates manager-scoped live retry hooks.
		for (const probe of [a, b]) probe.loader.getExtensions().runtime.flagValues.set("retry-stall-timeout-ms", "0");
		await b.bind();
		await a.bind();
		await b.session.prompt('/retry config {"syncSettings":false,"constantDelayMs":3}');
		await Promise.all([a.prompt("Session A"), b.prompt("Session B")]);
		assert.deepEqual(retryStarts(a).map((event) => event.delayMs), [1], "B command does not overwrite A live policy");
		assert.deepEqual(retryStarts(b).map((event) => event.delayMs), [3]);
		assert.equal(resolveSession(a.manager), a.session);
		assert.equal(resolveSession(b.manager), b.session);
		await b.shutdown();
		b.session.dispose();
		assert.throws(() => b.generations[0].contexts[0].isIdle(), /stale/i);
		assert.equal(a.generations[0].contexts[0].isIdle(), true);
		a.setStreamPolicy((attempt) => ({ kind: attempt === 3 ? "error" : "success" }));
		await a.prompt("A still retries after B shutdown");
		assert.deepEqual(retryStarts(a).map((event) => event.delayMs), [1, 1]);
		assert.equal(b.requests.length, 2, "shutdown B receives no A continuation");
		assert.equal(b.lifecycle.filter((event) => event.type === "session_shutdown").length, 1, "shutdown/disposal cleanup is idempotent");
	});

	await t.test("local error -> real core retry -> success keeps failed history and persists context_edit omission", async (st) => {
		const f = await fixture(st);
		const probe = await f.create({ persist: true, stream: (attempt) => ({ kind: attempt === 1 ? "error" : "success" }) });
		await probe.bind();
		await probe.prompt();
		assert.equal(probe.requests.length, 2);
		assert.deepEqual(retryStarts(probe).map(({ attempt, delayMs, maxAttempts }) => ({ attempt, delayMs, maxAttempts })), [
			{ attempt: 1, delayMs: 1, maxAttempts: 2 },
		]);
		const entries = probe.manager.getEntries();
		const failed = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error");
		assert.ok(failed, "failed assistant remains in append-only raw history");
		assert.match(failed.message.errorMessage, /kun-retry/);
		assert.ok(entries.some((entry) => entry.type === "context_edit" && entry.targetId === failed.id && entry.replacement === null));
		const projection = probe.manager.buildSessionProjection();
		assert.deepEqual(projection.entries.find((entry) => entry.sourceEntry.id === failed.id).messages, []);
		assert.deepEqual(assistants(projection.messages).map((message) => message.stopReason), ["stop"]);
		assert.equal(assistants(probe.requests[1].messages).length, 0, "next actual local provider request omits failed attempt");
		assert.deepEqual(assistants(probe.session.messages).map((message) => message.stopReason), ["stop"]);
		assert.equal(probe.events.at(-1).type, "agent_settled");
		assert.equal(probe.events.at(-1).aborted, false);
		assert.ok(probe.events.some((event) => event.type === "auto_retry_end" && event.success));
		const sessionFile = probe.manager.getSessionFile();
		assert.ok(sessionFile.startsWith(root));
		const restored = SessionManager.open(sessionFile, dirname(sessionFile));
		assert.ok(restored.getEntries().some((entry) => entry.id === failed.id));
		assert.deepEqual(assistants(restored.buildSessionProjection().messages).map((message) => message.stopReason), ["stop"]);
	});

	await t.test("small real retry budget exhausts, retaining only the final failure in projection", async (st) => {
		const f = await fixture(st, { maxRetries: 1 });
		const probe = await f.create({ stream: () => ({ kind: "error" }) });
		await probe.bind();
		await probe.prompt();
		assert.equal(probe.requests.length, 2, "one initial attempt plus one retry, never an unbounded loop");
		assert.deepEqual(retryStarts(probe).map((event) => event.delayMs), [1]);
		const rawFailures = probe.manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant");
		assert.equal(rawFailures.length, 2);
		const projection = probe.manager.buildSessionProjection();
		assert.deepEqual(projection.entries.find((entry) => entry.sourceEntry.id === rawFailures[0].id).messages, []);
		assert.deepEqual(assistants(projection.messages).map((message) => message.stopReason), ["error"]);
		assert.equal(probe.events.at(-1).type, "agent_settled");
		assert.equal(probe.events.at(-1).aborted, false);
		assert.ok(probe.events.some((event) => event.type === "auto_retry_end" && !event.success));
	});

	await t.test("two live SDK streams: direct soft abort never cancels the other owner", async (st) => {
		const f = await fixture(st, { stallTimeoutMs: 0 });
		const aStarted = deferred();
		const bStarted = deferred();
		const a = await f.create({ stream: (attempt, request) => {
			if (attempt === 1) request.started.promise.then(aStarted.resolve);
			return { kind: attempt === 1 ? "hold" : "success" };
		} });
		const b = await f.create({ stream: (_attempt, request) => {
			request.started.promise.then(bStarted.resolve);
			return { kind: "hold" };
		} });
		await a.bind();
		await b.bind();
		const aPending = a.prompt("held A");
		const bPending = b.prompt("held B");
		await bounded(Promise.all([aStarted.promise, bStarted.promise]), "both live local streams");
		assert.equal(canSoftAbort(a.manager), true);
		assert.equal(canSoftAbort(b.manager), true);
		assert.equal(beginSoftAbort(a.manager), "direct");
		await aPending;
		assert.equal(a.requests[0].signal.aborted, true);
		assert.equal(a.session._agentRunAbortRequested, false, "direct abort never sets the user-cancel flag");
		assert.equal(b.requests[0].signal.aborted, false, "B is still actively streaming");
		assert.equal(b.session.isStreaming, true);
		// A direct host soft abort has no watchdog marker and is deliberately
		// not rewritten/retried; only a confirmed watchdog abort owns that marker.
		assert.deepEqual(retryStarts(a), []);
		await a.shutdown();
		a.session.dispose();
		assert.equal(b.generations[0].contexts[0].isIdle(), false, "A shutdown does not invalidate B ctx");
		await bounded(b.session.abort(), "cancel remaining B stream");
		await bPending;
		assert.equal(b.requests.length, 1);
		assert.deepEqual(retryStarts(b), []);
	});

	await t.test("short bounded watchdog aborts only the owning real stream and core retries it", async (st) => {
		const f = await fixture(st, { stallTimeoutMs: 20 });
		const idle = await f.create();
		const stalled = await f.create({ stream: (attempt) => ({ kind: attempt === 1 ? "hold" : "success" }) });
		await stalled.bind();
		await idle.bind();
		await stalled.prompt();
		assert.equal(stalled.requests.length, 2);
		assert.equal(stalled.requests[0].signal.aborted, true);
		assert.equal(idle.requests.length, 0, "other session remains untouched");
		assert.equal(idle.session.isIdle, true);
		const failed = stalled.manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error");
		assert.match(failed.message.errorMessage, /stall-watchdog-retry/);
		assert.deepEqual(retryStarts(stalled).map((event) => event.delayMs), [1]);
		assert.equal(stalled.events.at(-1).aborted, false, "soft provider abort is not user cancellation");
		assert.equal(AgentSession.prototype.abort, originalAbort);
	});

	await t.test("real user abort during local stream is not rewritten or retried", async (st) => {
		const f = await fixture(st, { stallTimeoutMs: 250 });
		const started = deferred();
		const probe = await f.create({ stream: (_attempt, request) => {
			request.started.promise.then(started.resolve);
			return { kind: "hold" };
		} });
		await probe.bind();
		const pending = probe.prompt();
		await bounded(started.promise, "local held stream start");
		assert.equal(canSoftAbort(probe.manager), true);
		await bounded(probe.session.abort(), "real user abort");
		await pending;
		assert.equal(probe.requests.length, 1);
		assert.deepEqual(retryStarts(probe), []);
		const aborted = assistants(probe.manager.buildSessionProjection().messages).at(-1);
		assert.equal(aborted.stopReason, "aborted");
		assert.doesNotMatch(aborted.errorMessage, /stall-watchdog-retry|kun-retry/);
		assert.equal(probe.events.at(-1).type, "agent_settled");
		assert.equal(probe.events.at(-1).aborted, true);
		assert.equal(beginSoftAbort(probe.manager), "unavailable", "settled cancelled owner fails closed");
	});

	await t.test("real user abort cancels core retry backoff immediately without a second request", async (st) => {
		const f = await fixture(st, { constantDelayMs: 250, maxRetries: 1 });
		const probe = await f.create({ stream: () => ({ kind: "error" }) });
		await probe.bind();
		const scheduled = deferred();
		const unsubscribe = probe.session.subscribe((event) => {
			if (event.type === "auto_retry_start") scheduled.resolve();
		});
		try {
			const pending = probe.prompt();
			await bounded(scheduled.promise, "real retry scheduled");
			assert.equal(probe.session.isRetrying, true);
			await bounded(probe.session.abort(), "abort real retry backoff");
			await pending;
			assert.equal(probe.requests.length, 1);
			assert.deepEqual(retryStarts(probe).map((event) => event.delayMs), [250]);
			assert.equal(probe.session.isRetrying, false);
			assert.equal(probe.events.at(-1).aborted, true);
			assert.ok(probe.events.some((event) => event.type === "auto_retry_end" && !event.success));
		} finally { unsubscribe(); }
	});
});
