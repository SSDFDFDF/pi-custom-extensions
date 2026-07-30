# client-mimic

Make pi's outgoing provider requests look like another client — **OpenAI Codex
CLI** (`codex_cli_rs`) or **Anthropic Claude Code** (`claude-cli` / `tengu`) — so
pi can talk to a self-hosted gateway/relay that gates on a specific client
fingerprint.

## What it does (and does not do)

- **Does:** rewrite outgoing HTTP headers (`before_provider_headers`), optionally
  patch top-level request-body fields (`before_provider_request`), and optionally
  swap/rewrite pi's system prompt per profile (`before_agent_start`).
- **Does not:** touch OAuth/login, TLS/JA3, or HTTP2 framing. Those transport-layer
  fingerprints are out of reach for an extension. If your gateway validates
  transport-level fingerprints, header rewriting alone will not satisfy it.

Intended for **interop with your own gateway**, not for evading a third-party
service's client checks.

## Architecture

```
src/
  index.ts                 # pi hooks + /mimic commands only
  config.ts                # profiles, config load/save, resolveTemplate
  codex-identity.ts        # Codex session/thread/window/turn + store + body inject
  claude-identity.ts       # Claude session v4 + device_id
  claude-body.ts           # Claude metadata.user_id + billing system + beta merge
  fs-util.ts               # atomic write + exclusive lockfile
  ids.ts                   # shared UUID helpers
  *.test.ts                # unit tests (node:test)
  system-prompt.ts         # neutral / file prompt modes
  update.ts                # /mimic update via npm registry
prompts/
  codex.md
  claude-code.md
```

| module | responsibility |
|--------|----------------|
| `codex-identity.ts` | UUIDv7, tree resolve, window chain, locked store I/O, `ensureCodexIdentity` |
| `claude-identity.ts` / `claude-body.ts` | Claude session/device + body helpers |
| `fs-util.ts` | Atomic write + cross-process lock (`.lock` via `O_EXCL`) |
| `config.ts` | Profile schema, defaults, placeholder resolution |
| `index.ts` | Wire `pi.on(...)` and commands only |

Identity stores use **atomic write** and **exclusive lockfiles** (with merge-on-write
for the Codex identity map) so parallel pi/subagent processes are less likely to
clobber mappings.

Codex runtime state is a single `CodexIdentityState` object (session/thread/window/turn).
Mapping is persisted under:

| path | purpose |
|------|---------|
| `~/.pi/agent/client-mimic.identity.json` | pi session id → Codex session/thread/window chain |
| `~/.pi/agent/client-mimic.device_id` | Claude Code device_id (64 hex, machine-stable) |
| `~/.pi/agent/client-mimic.claude-sessions.json` | pi session id → Claude session UUIDv4 when pi is not v4 |
| `~/.codex/installation_id` (preferred) or `~/.pi/agent/client-mimic.installation_id` | machine-stable installation id |

Identity store writes use temp file + `rename` (atomic on the same filesystem).

### Dev commands

```bash
cd ~/.pi/agent/extensions/client-mimic
npm test    # node --test codex-identity tests
npm run check
```

## Profiles

Two built-in profiles (default `active` may be set in your live config):

| key           | client                          | notable behavior |
|---------------|---------------------------------|------------------|
| `codex`       | OpenAI Codex CLI (`codex_cli_rs`) | Full identity stack (below) + UA / originator / version / OpenAI-Beta |
| `claude-code` | Anthropic Claude Code           | CLI-shaped headers + Stainless set + body `metadata.user_id` + billing system blocks |

### Codex identity model (aligned with openai/codex)

Modeled on codex-rs `AgentControl` + `AutoCompactWindowIds` + Responses client headers:

| id | meaning | stability |
|----|---------|-----------|
| `session_id` | Agent tree / cache key | Shared by root + child threads; used as `prompt_cache_key` |
| `thread_id` | One conversation/agent | Root: equals `session_id`. Child (fork/parentSession): **new** id |
| `parent_thread_id` | Parent agent thread | Set only on children → header `x-codex-parent-thread-id` |
| `window_id` | Context window segment | Advances on pi `session_compact` |
| `first_window_id` / `previous_window_id` / `window_number` | Window chain | First fixed for thread life; previous set after compact |
| `turn_id` | One outbound LLM request | New UUIDv7 per provider call |
| `installation_id` | This machine | Stable; prefers real Codex file |

**Tree rules**

| event | session_id | thread_id | window |
|-------|------------|-----------|--------|
| `session_start` root (startup/new) | = this pi session (UUIDv7) | = session_id | fresh chain `#0` |
| fork / parentSession child | **inherit parent** | **new** (this pi session) | fresh chain for child |
| resume / reload | restore from store | restore | **reuse** last chain (no new window) |
| `session_compact` | unchanged | unchanged | advance: prev←cur, new cur, number++ |

**Wire surface (codex and codex-lite profiles)**

Headers (defaults):

- `originator: codex_cli_rs`
- `User-Agent: codex_cli_rs/{version} ({os_type} {os_version}; {uname_arch}) {terminal}`
- `OpenAI-Beta: responses=experimental`
- `version: {version}`
- `session-id`, `thread-id`
- `x-codex-installation-id`, `x-codex-window-id`
- `x-codex-parent-thread-id` only when child (empty → header removed)

Body when `ensureCodexIdentity: true`:

- `prompt_cache_key` = `session_id` (if missing)
- `metadata`: `session_id`, `thread_id`, `x-codex-installation-id`, `x-codex-window-id`,
  `first_window_id`, `previous_window_id` (if any), `window_number`, `turn_id`,
  optional `x-codex-parent-thread-id`

The `codex-lite` profile follows the current Codex Responses Lite contract used
by models such as `gpt-5.6-sol`. In addition to the Codex identity headers, it:

- sends `x-openai-internal-codex-responses-lite: true`
- moves top-level `tools` to a leading developer `additional_tools` input item
- moves top-level `instructions` to a developer input message when present
- removes `max_output_tokens`, forces `tool_choice: auto` and
  `parallel_tool_calls: false`
- sets `reasoning.context: all_turns`, defaults `text.verbosity` to `low`, and
  includes `reasoning.encrypted_content`
- writes current Codex identity fields to `client_metadata`

Do **not** force `stream` / `store` via `bodyPatch` — mismatches break pi response parsing.

### Claude Code identity model

Aligned with local Claude Code **2.1.198** (telemetry + restored source maps).
Unlike Codex, Claude uses **one session_id (UUIDv4)** per conversation — no
thread/window chain.

| id | shape | notes |
|----|-------|-------|
| `session_id` | **UUIDv4** | Header `X-Claude-Code-Session-Id` + `metadata.user_id.session_id`. If pi's session is already v4, reuse it; if pi uses UUIDv7, map to a stable v4 in `client-mimic.claude-sessions.json`. |
| `device_id` | 64 hex | Persisted in `client-mimic.device_id` (sha256 seed once). |
| `account_uuid` | empty string by default | Real CLI fills from OAuth; we leave `""`. |
| `parent_session_id` | optional | Real CLI sets on teammate/sidechain; not emitted yet. |

**Default `anthropic-beta` (core set, merged with pi):**
`claude-code-20250219`, `interleaved-thinking-2025-05-14`,
`redact-thinking-2026-02-12`, `thinking-token-count-2026-05-13`,
`context-management-2025-06-27`, `prompt-caching-scope-2026-01-05`,
`mid-conversation-system-2026-04-07`, `effort-2025-11-24`.

Optional flags seen on the wire (`context-1m-…`, `advisor-tool-…`,
`advanced-tool-use-…`) can be appended in live config if a gateway requires them.

Body helpers:

| flag | effect |
|------|--------|
| `ensureMetadataUserId` | Inject Claude Code `metadata.user_id` JSON string when missing |
| `prependBillingSystem` | Prepend billing-header + Agent SDK identity system blocks when missing |

See [Claude Code gateways](#claude-code-gateways-triage--upgrade-playbook) for triage.

### Placeholders

Header values support placeholders resolved at request time:

| placeholder | value |
|-------------|-------|
| `{version}` | profile `version` (client version) |
| `{session_id}` | Codex session id (tree root id; shared by children) |
| `{thread_id}` | thread id (root: = session_id; child: this pi session) |
| `{parent_thread_id}` | parent thread; empty on root (header omitted) |
| `{window_id}` | current context-window id (advances on compact) |
| `{first_window_id}` | first window in this thread's chain |
| `{previous_window_id}` | previous window after compact; empty before first compact |
| `{window_number}` | monotonic window index (0-based) |
| `{turn_id}` | per outbound request UUIDv7 |
| `{installation_id}` | machine-stable installation id |
| `{uuid}` | fresh random UUID per request |
| `{uuid_v7}` | fresh UUIDv7 per request |
| `{os}` / `{stainless_os}` | Stainless OS token: `Linux`, `MacOS`, `Windows` |
| `{arch}` / `{stainless_arch}` | Stainless arch: `x64`, `arm64`, `x32` |
| `{os_type}` | Codex OS type: `Linux`, `Mac OS`, `Windows` |
| `{os_version}` | kernel/OS version (`os.release()`) |
| `{uname_arch}` | uname machine: `x86_64`, `arm64`/`aarch64` |
| `{terminal}` | `TERM_PROGRAM`/`TERM`, else `unknown` |
| `{node_version}` | `process.version` |
| `{platform}` | raw `process.platform` |
| any key in `templateVars` | profile constant (overrides built-ins) |

A header value of `null` deletes the header. Empty resolved values also delete
(e.g. parent on root). `stripHeaders` removes pi headers case-insensitively
before profile headers apply; profile spelling wins on case collisions.

## Commands

```
/mimic                    show status + active profile
/mimic on | off           master switch
/mimic use <profile>      activate codex | codex-lite | claude-code | off
/mimic list               list profiles
/mimic show [profile]     print resolved headers + ids + body flags + prompt mode
/mimic prompt                                show system-prompt config (all levels)
/mimic prompt <off|neutral>                  set the global default
/mimic prompt <profile> <inherit|off|neutral|file> [path]   set per-profile mode
/mimic update [name|all]  pull latest version from npm and refresh {version}
/mimic help
```

Launch flag (session-only, does not rewrite the config file):

```
pi --mimic codex
```

## Auto-update from npm

`/mimic update` queries the npm registry `/latest` for each profile's
`npmPackage` (`@openai/codex`, `@anthropic-ai/claude-code`) and refreshes
`version` → `{version}` in headers.

```
/mimic update
/mimic update codex
```

## Config

Live file: `~/.pi/agent/client-mimic.config.json` (not git-tracked).  
Template: `config.example.json` in this directory.

### bodyPatch safety

Default `bodyPatch: {}`. Do not force `stream`/`store` unless you know pi's
request mode and the provider accepts those fields.

Claude body fingerprints → use `ensureMetadataUserId` / `prependBillingSystem`.  
Codex body identity → use `ensureCodexIdentity` (default true on codex profiles).
Responses Lite body conversion → use `codexResponsesLite` (default true only on
the built-in `codex-lite` profile).

## System prompt

Two levels of `SystemPromptSpec`:

- **Global** `systemPrompt` — default when profile uses `inherit` (ships `neutral`)
- **Per-profile** — ships `inherit` unless you set `file` / `off` / `neutral`

| mode | effect |
|------|--------|
| `inherit` | (profile only) use global |
| `off` | leave pi's built-in prompt |
| `neutral` | "kun / π" rewrite; keep tools/guidelines/skills/context |
| `file` | load `file` with `apply`: `replace` \| `prepend` \| `append` |

Seeds: `prompts/codex.md`, `prompts/claude-code.md` (paths relative to `~/.pi/agent`
when referenced as `extensions/client-mimic/prompts/...`).

```
/mimic prompt
/mimic prompt neutral
/mimic prompt codex file
/mimic prompt codex inherit
```

## Caveats

- Header/body sets model real clients for **gateway checks**, not byte-perfect
  parity with official backends.
- Not mimicked: Codex ChatGPT account headers, full Claude beta/thinking matrix,
  tool naming quirks, TLS/HTTP2 fingerprints.
- Parallel pi/subagent processes share `client-mimic.identity.json` without a
  cross-process lock; rare races can drop a mapping (see Future work).
- `turn_id` is minted in `before_provider_headers`; body hook reuses the same
  in-memory state. If hook ordering ever changes, revisit request-scoped ids.

## Future work (backlog)

Ordered by likely value. **Do not implement until a gateway or bug forces it.**

### Done recently

- Cross-process lock + merge-on-write for Codex identity / Claude session map / device id
- Claude body helpers extracted to `claude-body.ts`
- Shared `ids.ts` + `fs-util.ts`

### Medium priority (remaining)

1. **`originator` by entrypoint**  
   Real Codex uses `codex_cli_rs` / `codex-tui` / `codex_exec`. Today the profile
   hardcodes `codex_cli_rs`. Add a config/template switch if the gateway cares.

2. **Subagent marker header**  
   Emit a light marker for child threads only when a target gateway distinguishes them.

3. **Request-scoped `turn_id`**  
   Bind turn id once per logical provider request (headers + body) if hook order changes.

### Low priority

4. `/mimic tree` — print identity store parent/child chains for debugging.
5. Optional headers for `first_window_id` / `previous_window_id` (body already has them).
6. Richer `x-codex-turn-metadata` JSON blob (only if a gateway validates the full shape).
7. Hooks-level integration tests (mock `before_provider_*` end-to-end).

### Out of scope

- TLS/JA3, HTTP2 framing, OAuth account binding  
- Full multi-agent v2 / guardian protocol parity  
- Forcing Responses-only body fields that break pi streaming  

## Claude Code gateways: triage & upgrade playbook

Generic guide for gateways that gate on Claude Code fingerprints.
Header-only mimic is often not enough — many checks are **body-aware**.

### 1. Capture the real client

Point installed Claude Code at a local dump server and send one request:

```bash
claude -p "hi" --settings /tmp/claude-dump-settings.json --dangerously-skip-permissions
# settings.env:
#   ANTHROPIC_BASE_URL=http://127.0.0.1:<dump-port>
#   ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN = dummy
```

Typical wire shape:

| field | notes |
|-------|-------|
| `User-Agent` | `claude-cli/<ver> (external, cli)` |
| `x-app` | `cli` |
| `X-Claude-Code-Session-Id` | session UUID |
| `anthropic-beta` | includes `claude-code-20250219` (+ thinking/context flags) |
| `X-Stainless-Package-Version` | bundled SDK version, **not** CLI version |
| body `metadata.user_id` | JSON **string**: `device_id` / `account_uuid` / `session_id` |
| body `system[0]` | `x-anthropic-billing-header: cc_version=…; cc_entrypoint=cli;` |
| body `system[1]` | `You are a Claude agent, built on Anthropic's Claude Agent SDK.` |

### 2. Find what the gateway actually checks

A/B one field at a time. Common hard gates: non-empty Claude-shaped `system`,
`metadata.user_id`, `anthropic-beta`, `x-app` + CLI User-Agent.

### 3. How client-mimic covers it

| hook | does |
|------|------|
| `before_provider_headers` | UA / `x-app` / session / Stainless / merge `anthropic-beta` |
| `before_provider_request` | `ensureMetadataUserId`, `prependBillingSystem`, `bodyPatch` |
| `before_agent_start` | seed system prompt (`prompts/claude-code.md`) |

`prependBillingSystem` only skips when a **leading** system block *starts with*
`x-anthropic-billing-header:`. Do not put that literal in seed-prompt notes.

### 4. Config footguns

- `systemPrompt.file` is relative to `~/.pi/agent`
- two versions: CLI → `version` / `/mimic update`; Stainless → `templateVars.stainless_version` (manual)
- `anthropic-beta` is **merged** with pi’s betas (do not wipe thinking flags)

### 5. Upgrade checklist

1. Capture one real request and diff against pi+mimic.
2. `/mimic update claude-code` (CLI `{version}`).
3. Update `templateVars.stainless_version` if the wire SDK version changed.
4. Append new required beta flags if needed.
5. Update `prompts/claude-code.md` if identity text changed.
6. `/reload` or restart pi; smoke the real gateway.

### 6. Files

| path | role |
|------|------|
| `~/.pi/agent/client-mimic.config.json` | live config |
| `~/.pi/agent/client-mimic.identity.json` | Codex session/thread/window map |
| `extensions/client-mimic/config.example.json` | tracked template |
| `src/index.ts` / `src/config.ts` / `src/codex-identity.ts` | hooks + identity |
| `prompts/claude-code.md` / `prompts/codex.md` | seed system prompts |
| `~/.pi/agent/models.json` | provider endpoint / key |
