# client-mimic

Make pi's outgoing provider requests look like another client — **OpenAI Codex
CLI** (`codex_cli_rs`) or **Anthropic Claude Code** (`claude-cli` / `tengu`) — so
pi can talk to a self-hosted gateway/relay that gates on a specific client
fingerprint.

## What it does (and does not do)

- **Does:** rewrite outgoing HTTP headers (`before_provider_headers`) and, when a
  profile defines it, patch top-level request-body fields (`before_provider_request`).
- **Does not:** touch OAuth/login, TLS/JA3, or HTTP2 framing. Those transport-layer
  fingerprints are out of reach for an extension. If your gateway validates
  transport-level fingerprints, header rewriting alone will not satisfy it.

Intended for **interop with your own gateway**, not for evading a third-party
service's client checks.

## Profiles

Two built-in profiles, both starting inactive (`active: "off"`):

| key           | client                          | notable headers |
|---------------|---------------------------------|-----------------|
| `codex`       | OpenAI Codex CLI (`codex_cli_rs`) | `originator`, `User-Agent: codex_cli_rs/{version}`, `OpenAI-Beta: responses=experimental`, `session-id`. Empty `bodyPatch` by default. |
| `claude-code` | Anthropic Claude Code           | `User-Agent: claude-code/{version}`, `x-app: cli`, `X-Claude-Code-Session-Id`, and the `X-Stainless-*` SDK header set. |

Header values support placeholders resolved at request time:
`{version}`, `{session_id}`, `{uuid}`, `{os}`, `{arch}`, `{node_version}`,
`{platform}`. A header value of `null` deletes that header. `stripHeaders`
removes pi's own headers (case-insensitive) before the profile's headers apply.
When a profile header and a provider-configured header collide (even under
different casing, e.g. `user-agent` vs `User-Agent`), the profile wins and only
its canonical spelling is sent — no duplicate headers.

## Commands

```
/mimic                    show status + active profile
/mimic on | off           master switch
/mimic use <profile>      activate codex | claude-code | off
/mimic list               list profiles
/mimic show [profile]     print resolved headers + body patch
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

### bodyPatch safety

Both profiles ship `bodyPatch: {}` on purpose. `before_provider_request` spreads
`bodyPatch` over pi's payload verbatim, so forcing fields like `stream` or
`store` can break the round-trip: if `stream` disagrees with pi's actual request
mode, response parsing fails (SSE vs JSON), and `store`/`stream` are
OpenAI-Responses-specific and may `400` on other providers. Only add body fields
your gateway genuinely requires, and make sure `stream` matches pi's real mode.

## Caveats

- These header sets model the real clients but target a gateway that only checks
  these fields; they are not byte-perfect parity with the official backends.
- The real clients send more that this does not attempt: Codex's `ChatGPT-Account-ID`
  (derived from an OAuth `id_token`) and Claude Code's in-prompt
  `x-anthropic-billing-header` / `metadata.user_id`. Add them via config if your
  gateway needs them.
- `anthropic-beta` is intentionally **not** forced by the claude-code profile,
  since the active provider usually sets its own. Add it to the profile's
  `headers` if your gateway requires a specific value.
