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

## Profiles

Two built-in profiles, both starting inactive (`active: "off"`):

| key           | client                          | notable headers |
|---------------|---------------------------------|-----------------|
| `codex`       | OpenAI Codex CLI (`codex_cli_rs`) | `originator`, `User-Agent: codex_cli_rs/{version} ({os_type} {os_version}; {uname_arch}) {terminal}`, `OpenAI-Beta: responses=experimental`, `version`, `session-id`. Empty `bodyPatch` by default. |
| `claude-code` | Anthropic Claude Code           | `User-Agent: claude-cli/{version} (external, cli)`, `x-app: cli`, `anthropic-version`, `anthropic-dangerous-direct-browser-access`, and the `X-Stainless-*` SDK header set. |

The header sets are modeled on what the real clients actually send on the wire:

- **Codex** builds `User-Agent` as
  `codex_cli_rs/<version> (<OS type> <OS version>; <uname arch>) <terminal>` in
  `codex-rs/login/src/auth/default_client.rs` (e.g.
  `codex_cli_rs/0.144.4 (Linux 6.8.0; x86_64) unknown`). It also sends a bare
  `version` header on Responses requests, which some gateways validate
  (Sub2API PR #2494). The old bare `codex_cli_rs/{version}` form was trivially
  fingerprinted as non-CLI.
- **Claude Code** sends `User-Agent: claude-cli/<version> (external, cli)` —
  **not** `claude-code/<version>` — plus `anthropic-version: 2023-06-01`,
  `anthropic-dangerous-direct-browser-access: true`, and the `X-Stainless-*`
  metadata from the bundled `@anthropic-ai/sdk` (captured from Claude Code
  v2.1.69 on the wire).

### Placeholders

Header values support placeholders resolved at request time:

| placeholder        | value |
|--------------------|-------|
| `{version}`        | profile `version` (client version) |
| `{session_id}`     | pi's session id (stable per session) |
| `{uuid}`           | fresh random UUID per request |
| `{os}` / `{stainless_os}` | Stainless OS token: `Linux`, `MacOS`, `Windows` |
| `{arch}` / `{stainless_arch}` | Stainless arch token: `x64`, `arm64`, `x32` |
| `{os_type}`        | Codex OS type: `Linux`, `Mac OS`, `Windows` |
| `{os_version}`     | kernel/OS version (`os.release()`) |
| `{uname_arch}`     | uname machine arch: `x86_64`, `arm64`/`aarch64` |
| `{terminal}`       | Codex terminal token from `TERM_PROGRAM`/`TERM`, else `unknown` |
| `{node_version}`   | `process.version` |
| `{platform}`       | raw `process.platform` |
| any key in `templateVars` | profile-defined constant (overrides built-ins) |

Profiles can define extra constants under `templateVars` and use them as
`{key}`. The `claude-code` profile ships `templateVars.stainless_version`
(`0.74.0`) so `X-Stainless-Package-Version` reflects the bundled SDK version;
refresh it by hand if your gateway checks it.

A header value of `null` deletes that header. `stripHeaders` removes pi's own
headers (case-insensitive) before the profile's headers apply. When a profile
header and a provider-configured header collide (even under different casing,
e.g. `user-agent` vs `User-Agent`), the profile wins and only its canonical
spelling is sent — no duplicate headers.

## Commands

```
/mimic                    show status + active profile
/mimic on | off           master switch
/mimic use <profile>      activate codex | claude-code | off
/mimic list               list profiles
/mimic show [profile]     print resolved headers + body patch + prompt mode
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

`/mimic update` queries the npm registry `/latest` endpoint for each profile's
`npmPackage` (`@openai/codex`, `@anthropic-ai/claude-code`) and refreshes the
stored `version`, which flows into the `{version}` placeholder in `User-Agent`.

```
/mimic update            # all profiles
/mimic update codex      # one profile
```

## Config

Stored at `~/.pi/agent/client-mimic.config.json` (auto-created). You can edit
profiles by hand — add headers, change `stripHeaders`, extend `bodyPatch`, or
define new profiles. Unknown/user-defined profile keys are preserved.

The live config lives **outside** this git repo (it may hold environment-
specific values), so it is not backed up by cloning the extensions repo. A
tracked starting point ships as `config.example.json` in this directory — copy
it to `~/.pi/agent/client-mimic.config.json` on a new machine and adjust. The
seed prompt files under `prompts/` *are* tracked and restore with the repo.

### bodyPatch safety

Both profiles ship `bodyPatch: {}` on purpose. `before_provider_request` spreads
`bodyPatch` over pi's payload verbatim, so forcing fields like `stream` or
`store` can break the round-trip: if `stream` disagrees with pi's actual request
mode, response parsing fails (SSE vs JSON), and `store`/`stream` are
OpenAI-Responses-specific and may `400` on other providers. Only add body fields
your gateway genuinely requires, and make sure `stream` matches pi's real mode.

## System prompt

client-mimic also owns pi's system prompt (folding in the old standalone
`neutral-system-prompt.ts` extension, which is now a no-op shim). Behavior is
driven by a `SystemPromptSpec` at two levels:

- **Global** `systemPrompt` in the config file — the default when no profile
  overrides it. Ships as `{ "mode": "neutral" }`, preserving the previous
  "kun / π" identity rewrite.
- **Per-profile** `systemPrompt` — each profile has its own spec. Ships as
  `{ "mode": "inherit" }`, meaning "use the global default".

`mode` values:

| mode      | effect |
|-----------|--------|
| `inherit` | (profile only) defer to the global `systemPrompt` |
| `off`     | leave pi's built-in prompt untouched |
| `neutral` | apply the neutral "kun / π" identity rewrite; keeps pi's generated tool list, guidelines, skills, context, date, and cwd intact |
| `file`    | load prompt text from `file` and combine per `apply` |

When `mode` is `file`, set `file` (absolute, or relative to `~/.pi/agent`) and
`apply`:

- `replace` (default) — send the file as the entire system prompt.
- `prepend` — put the file text before pi's prompt.
- `append` — put the file text after pi's prompt.

Ready-to-edit seed files ship **inside this extension** at
`client-mimic/prompts/codex.md` and `client-mimic/prompts/claude-code.md`, so
they travel with the git-backed extensions repo (unlike the config file, which
lives outside it).

### Switching prompts by command

All levels can be toggled without editing the config file:

```
/mimic prompt                       show every level (global + per-profile)
/mimic prompt off                   global default: leave pi's prompt untouched
/mimic prompt neutral               global default: neutral kun/π rewrite
/mimic prompt codex file            codex profile → its seed file (replace)
/mimic prompt codex file <path>     codex profile → a custom file path
/mimic prompt codex neutral         codex profile → neutral, regardless of global
/mimic prompt codex inherit         codex profile → follow the global default
```

`/mimic prompt <profile> file` with no path defaults to the tracked seed file
`extensions/client-mimic/prompts/<profile>.md`. The `apply` mode is preserved
from the profile's previous file spec (or `replace` on first switch); edit the
config to change it to `prepend`/`append`.

Equivalently, edit a profile in the config — paths are relative to `~/.pi/agent`:

```json
"systemPrompt": {
  "mode": "file",
  "file": "extensions/client-mimic/prompts/codex.md",
  "apply": "replace"
}
```

Use `apply: "replace"` when your gateway inspects the prompt for a matching
client identity; use `prepend`/`append` to keep pi's real instructions and just
add a client preamble. To keep only the current neutral prompt everywhere, leave
the global at `neutral` and every profile at `inherit` (the defaults).

## Caveats

- These header sets model the real clients but target a gateway that only checks
  these fields; they are not byte-perfect parity with the official backends.
- The real clients send more that this does not attempt: Codex's `ChatGPT-Account-ID`
  (derived from an OAuth `id_token`) and Claude Code's in-prompt
  `x-anthropic-billing-header` / `metadata.user_id`. Add them via config if your
  gateway needs them.
- `anthropic-beta` is intentionally **not** forced by the claude-code profile,
  since the active provider usually sets its own (and the real value is a
  version-specific comma-separated flag list like
  `claude-code-20250219,oauth-2025-04-20,...`). Add it to the profile's `headers`
  if your gateway requires a specific value.
