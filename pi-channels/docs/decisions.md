# Decisions

## ADR-001 Multi-channel core

Telegram is an adapter, not the product kernel.

## ADR-002 No legacy migration code

`channels.json` is the only config. Old `telegram.json` / `@llblab/pi-telegram`
are deleted by the operator when switching. No import bridges in runtime.

## ADR-003 Default render = compat HTML

Web clients are first-class. Native Rich is optional later.

## ADR-004 Solo instance first

No leader/follower bus in v1.
