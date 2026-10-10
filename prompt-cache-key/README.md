# prompt-cache-key

Two affinity signals for Pi's provider requests, aimed at **custom `models.json`
endpoints** that pi-ai does not cover:

| Layer | Default | What it sends |
|---|---|---|
| HTTP headers (`before_provider_headers`) | **ON** | `X-Session-ID: <pi session id>` |
| Body field (`before_provider_request`) | **OFF** | `prompt_cache_key: <pi session id>` |

Both use Pi's session id: unique per conversation, stable for its lifetime, and
preserved across resumes.

## Why this exists

pi-ai's `openai-completions` builder only emits affinity data for endpoints it
recognizes:

```js
// pi-ai/dist/api/openai-completions.js
prompt_cache_key: (model.baseUrl.includes("api.openai.com") && cacheRetention !== "none") ||
    (cacheRetention === "long" && compat.supportsLongCacheRetention)
    ? clampOpenAIPromptCacheKey(options?.sessionId)
    : undefined,
...
if (sessionId && compat.sendSessionAffinityHeaders) {   // detected as OpenRouter only
    headers["x-session-id"] = sessionId;
}
```

so a self-hosted gateway or relay gets neither. This extension fills that gap.

## What the field actually does

`prompt_cache_key` is **not** a "session cache" switch and does not store
anything:

- Prompt caching itself is the upstream's automatic **prefix cache**. Any stable
  prefix hits; it works with or without a key. Measured on a relay, the same
  2177-token prefix: 1st call `cached_tokens: 0`, 2nd call `cached_tokens: 1920`
  — **with and without** the key.
- The key only namespaces/buckets cache affinity. On shared relays it is closer
  to a cache salt: changing it between requests can make a hit a miss.
- OpenAI pairs it with `prompt_cache_retention: "24h"`; pi-ai already sends that
  for the providers where it applies.

Therefore the header (vendor-neutral, accepted everywhere tested) is the safe
default, and the OpenAI-specific body field is opt-in.

## Header presets

`headers.presets` selects which header names to send (case-insensitively
de-duplicated, never overwriting a header that is already present):

| Preset | Headers |
|---|---|
| `generic` (default) | `X-Session-ID` |
| `openai` | `session_id`, `x-client-request-id`, `x-session-affinity` |
| `openrouter` | `x-session-id` |
| `opencode` | `x-opencode-session` |

`headers.names` appends literal custom header names.

## Auto-disable on rejection

Strict gateways reject unknown parameters. Observed live on the same relay:

```
POST /nvidia/v1  → 400 {"message":"Validation: Unsupported parameter(s): `prompt_cache_key`"}
POST /nvidia/v1  → 200  (same request with X-Session-ID only)
```

Because Pi retries (with `kun-retry --retry-nl`, effectively forever), one
rejected parameter can burn requests indefinitely. On `message_end` this
extension inspects the provider error and, when it looks like a rejection,
disables **only that parameter, only for that provider**, persists it, and says
so in the UI:

```
prompt-cache-key: custom-jcp-966112-xyz-nvidia rejected prompt_cache_key body field; disabled for this provider.
```

Matching is deliberately strict — a 400/422 status **and** a rejection keyword
**and** the exact parameter name — so a gateway error that merely echoes the
request body does not disable anything.

## Config

`~/.pi/agent/prompt-cache-key.config.json` (created with defaults on first
load; `PI_CODING_AGENT_DIR` relocates it):

```json
{
  "headers": {
    "enabled": true,
    "presets": ["generic"],
    "names": [],
    "apis": [],
    "providers": { "allow": [], "deny": [] }
  },
  "promptCacheKey": {
    "enabled": false,
    "providers": { "allow": [], "deny": [] }
  },
  "autoDisableOnRejection": true,
  "disabled": {
    "promptCacheKeyProviders": [],
    "headerProviders": {}
  }
}
```

- `headers.apis` limits header injection to specific API ids (e.g.
  `["openai-completions"]`); empty = every API.
- `providers.allow` / `providers.deny` accept exact provider ids, `*`, or a
  trailing `*` prefix (`custom-jcp-966112-xyz-*`). `deny` wins over `allow`.
- `disabled.*` is managed automatically (and cleared by `/prompt-cache reset`).

Per-provider opt-in example — headers everywhere, body key only for the
endpoints that accept it:

```json
{
  "promptCacheKey": { "enabled": true, "providers": { "allow": ["custom-jcp-966112-xyz-deepseek"] } }
}
```

## Commands

```
/prompt-cache                    # status
/prompt-cache headers [on|off]   # HTTP header layer
/prompt-cache key [on|off]       # prompt_cache_key body field
/prompt-cache auto [on|off]      # auto-disable on rejection
/prompt-cache reset [provider]   # clear auto-disabled entries
/prompt-cache path               # config file location
```

## Scope and interaction

- Body patches apply only to Chat Completions payloads. OpenAI Responses,
  Azure Responses and Codex Responses build their own `prompt_cache_key`, and
  Anthropic Messages uses `cache_control` instead.
- Never overwrites an existing value: if another extension (e.g. `client-mimic`
  with the `codex` profile, which rewrites `prompt_cache_key` to its Codex
  session id) already set it, this extension leaves it alone.
- Compaction/summarization requests match too. The key is harmless there.

## Tests

```bash
npm test          # 33 tests, via test/run.mjs
npm run check     # bundle the sources + tests without running them
```

`test/run.mjs` bundles with esbuild because this machine's Node build has no
`--experimental-strip-types` (`ERR_NO_TYPESCRIPT`). Tests always run with
`PI_CODING_AGENT_DIR` pointed at a throwaway directory, so they can never touch
the live config.
