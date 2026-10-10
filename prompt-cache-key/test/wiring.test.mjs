import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import install from "../index.ts";
import { configPath } from "../config.ts";

/** Run `fn` against a fresh, empty agent dir. Sequential tests, so env swapping is safe. */
async function withAgentDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "prompt-cache-key-wiring-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		return await fn(dir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Minimal stand-in for Pi's ExtensionAPI plus the context the handlers need. */
function createHarness() {
	const handlers = new Map();
	const commands = new Map();
	const notifications = [];
	const statuses = [];
	install({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, options) => commands.set(name, options),
	});

	const base = {
		hasUI: true,
		sessionManager: { getSessionId: () => "session-1" },
		ui: {
			notify: (message, type) => notifications.push({ type, message }),
			setStatus: (key, text) => statuses.push({ key, text }),
		},
	};
	const ctx = { ...base, model: { provider: "custom-a", api: "openai-completions" } };

	return {
		notifications,
		statuses,
		ctx,
		withProvider: (provider, api = "openai-completions") => ({ ...base, model: { provider, api } }),
		fire: (name, event, context = ctx) => handlers.get(name)(event, context),
		run: (args, context = ctx) => commands.get("prompt-cache").handler(args, context),
		start: () => handlers.get("session_start")({ type: "session_start" }, ctx),
	};
}

const readConfigFile = () => JSON.parse(readFileSync(configPath(), "utf8"));

test("session_start creates the default config file", async () => {
	await withAgentDir(() => {
		const { start } = createHarness();
		start();
		const raw = readConfigFile();
		assert.equal(raw.headers.enabled, true);
		assert.deepEqual(raw.headers.presets, ["generic"]);
		assert.equal(raw.promptCacheKey.enabled, false);
	});
});

test("injects X-Session-ID by default and keeps the body key off", async () => {
	await withAgentDir(() => {
		const { start, fire, ctx } = createHarness();
		start();

		const headers = { "User-Agent": "pi" };
		fire("before_provider_headers", { type: "before_provider_headers", headers }, ctx);
		assert.deepEqual(headers, { "User-Agent": "pi", "X-Session-ID": "session-1" });

		// Default config: no prompt_cache_key in the body.
		assert.equal(
			fire("before_provider_request", { type: "before_provider_request", payload: { messages: [] } }, ctx),
			undefined,
		);
	});
});

test("existing headers are never overwritten", async () => {
	await withAgentDir(() => {
		const { start, fire, ctx } = createHarness();
		start();
		const headers = { "x-session-id": "gateway-provided" };
		fire("before_provider_headers", { type: "before_provider_headers", headers }, ctx);
		assert.deepEqual(headers, { "x-session-id": "gateway-provided" });
	});
});

test("headers go out on every API, not just openai-completions", async () => {
	await withAgentDir(() => {
		const { start, fire, withProvider } = createHarness();
		start();
		const anthropic = {};
		fire("before_provider_headers", { type: "before_provider_headers", headers: anthropic }, withProvider("cc", "anthropic-messages"));
		assert.equal(anthropic["X-Session-ID"], "session-1");

		const responses = {};
		fire("before_provider_headers", { type: "before_provider_headers", headers: responses }, withProvider("oai", "openai-responses"));
		assert.equal(responses["X-Session-ID"], "session-1");
	});
});

test("/prompt-cache key on enables the body field and the footer", async () => {
	withAgentDir(async () => {
		const { start, fire, run, notifications, statuses, ctx } = createHarness();
		start();

		await run("key on");
		assert.equal(readConfigFile().promptCacheKey.enabled, true);
		assert.deepEqual(statuses.at(-1), { key: "prompt-cache-key", text: "cache-key" });
		assert.match(notifications.at(-1).message, /prompt_cache_key: on/);

		assert.deepEqual(
			fire("before_provider_request", { type: "before_provider_request", payload: { messages: [] } }, ctx),
			{ messages: [], prompt_cache_key: "session-1" },
		);

		// Other APIs still get no body key.
		assert.equal(
			fire(
				"before_provider_request",
				{ type: "before_provider_request", payload: { messages: [] } },
				{ ...ctx, model: { provider: "custom-a", api: "anthropic-messages" } },
			),
			undefined,
		);
	});
});

test("a rejected prompt_cache_key is disabled for that provider only", async () => {
	await withAgentDir(async () => {
		const { start, fire, run, notifications, ctx, withProvider } = createHarness();
		start();
		await run("key on");

		const rejection = {
			role: "assistant",
			provider: "custom-a",
			errorMessage:
				'400: {"message":"Validation: Unsupported parameter(s): `prompt_cache_key`","type":"bad_response_status_code"}',
		};
		fire("message_end", { type: "message_end", message: rejection }, ctx);

		assert.equal(notifications.at(-1).type, "warning");
		assert.match(notifications.at(-1).message, /custom-a rejected prompt_cache_key body field/);
		assert.deepEqual(readConfigFile().disabled.promptCacheKeyProviders, ["custom-a"]);

		// Disabled provider: no body key, headers still injected.
		assert.equal(
			fire("before_provider_request", { type: "before_provider_request", payload: { messages: [] } }, ctx),
			undefined,
		);
		const headersA = {};
		fire("before_provider_headers", { type: "before_provider_headers", headers: headersA }, ctx);
		assert.equal(headersA["X-Session-ID"], "session-1");

		// Other providers keep the body key.
		assert.deepEqual(
			fire(
				"before_provider_request",
				{ type: "before_provider_request", payload: { messages: [] } },
				withProvider("custom-b"),
			),
			{ messages: [], prompt_cache_key: "session-1" },
		);

		// Repeats do not duplicate the disabled entry.
		fire("message_end", { type: "message_end", message: rejection }, ctx);
		assert.deepEqual(readConfigFile().disabled.promptCacheKeyProviders, ["custom-a"]);
	});
});

test("a rejected header is disabled for that provider only", async () => {
	await withAgentDir(() => {
		const { start, fire, notifications, ctx, withProvider } = createHarness();
		start();

		fire(
			"message_end",
			{
				type: "message_end",
				message: {
					role: "assistant",
					provider: "custom-c",
					errorMessage: "400: unknown header X-Session-ID",
				},
			},
			ctx,
		);
		assert.equal(notifications.at(-1).type, "warning");
		assert.deepEqual(readConfigFile().disabled.headerProviders, { "custom-c": ["x-session-id"] });

		const headersC = {};
		fire("before_provider_headers", { type: "before_provider_headers", headers: headersC }, withProvider("custom-c"));
		assert.deepEqual(headersC, {});

		const headersA = {};
		fire("before_provider_headers", { type: "before_provider_headers", headers: headersA }, ctx);
		assert.equal(headersA["X-Session-ID"], "session-1");
	});
});

test("a gateway 500 echoing the body does not disable anything", async () => {
	await withAgentDir(async () => {
		const { start, fire, run, notifications, ctx } = createHarness();
		start();
		await run("key on");
		fire(
			"message_end",
			{
				type: "message_end",
				message: {
					role: "assistant",
					provider: "custom-a",
					errorMessage: '500 gateway_error: {"prompt_cache_key":"session-1","x-session-id":"session-1"}',
				},
			},
			ctx,
		);
		assert.deepEqual(readConfigFile().disabled.promptCacheKeyProviders, []);
		assert.equal(
			notifications.some((entry) => /rejected/.test(entry.message)),
			false,
		);
	});
});

test("/prompt-cache reset clears disabled entries", async () => {
	await withAgentDir(async () => {
		const { start, fire, run, ctx } = createHarness();
		start();
		await run("key on");
		fire(
			"message_end",
			{
				type: "message_end",
				message: { role: "assistant", provider: "custom-a", errorMessage: "400: unsupported prompt_cache_key" },
			},
			ctx,
		);
		assert.deepEqual(readConfigFile().disabled.promptCacheKeyProviders, ["custom-a"]);

		await run("reset");
		assert.deepEqual(readConfigFile().disabled.promptCacheKeyProviders, []);
		assert.deepEqual(readConfigFile().disabled.headerProviders, {});
	});
});

test("/prompt-cache headers off stops header injection persistently", async () => {
	await withAgentDir(async () => {
		const { start, fire, run, ctx } = createHarness();
		start();
		await run("headers off");

		const headers = {};
		fire("before_provider_headers", { type: "before_provider_headers", headers }, ctx);
		assert.deepEqual(headers, {});

		// A fresh instance in the same agent dir reads the persisted setting.
		const next = createHarness();
		next.start();
		const headers2 = {};
		next.fire("before_provider_headers", { type: "before_provider_headers", headers: headers2 }, next.ctx);
		assert.deepEqual(headers2, {});
	});
});
