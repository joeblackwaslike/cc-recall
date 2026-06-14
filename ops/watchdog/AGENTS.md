# AGENTS.md — claude-mem-watchdog

Operational guide for AI agents working on this repo. User-facing overview is in
[README.md](README.md); this file holds the non-obvious gotchas.

## What this is

A pure-bash + launchd watchdog for the claude-mem plugin, plus one small
OpenClaw hook (`openclaw/decision-bridge/handler.mjs`) that turns Telegram
`approve <id>` / `deny <id>` replies into decision files. Language is **bash on
purpose** (not the usual TS default): the job is entirely `curl`/`sqlite3`/
`pkill`/`openclaw`, and a watchdog must not fail for its own reasons.

## Hard-won gotchas (do not relearn these)

- **`${3:-{}}` is a trap in bash.** `${param:-word}` does NOT nest-count braces:
  the first `}` closes the expansion and the second becomes a literal, so
  `"${3:-{}}"` yields `$3` + a stray `}`, corrupting JSON passed to
  `jq --argjson`. Always use `local x="${3:-}"; [ -n "$x" ] || x='{}'`.
- **OpenClaw internal hook event name is `message`, not `message_received`.**
  Inbound dispatch calls `createInternalHookEvent("message","received",…)` →
  event `{type:"message", action:"received", context:{…}}`. `message_received`
  is the *plugin* hook name. Register `{event:"message"}` and gate on
  `event.action === "received"`.
- **Hook module path must be workspace-relative**, resolved against
  `~/.openclaw/workspace` (NOT `~/.openclaw` or the agent dir). Absolute paths
  are rejected. The handler lives at
  `~/.openclaw/workspace/hooks/handlers/claude-mem-decision-bridge.mjs`,
  registered as `./hooks/handlers/claude-mem-decision-bridge.mjs`. Use `.mjs`
  to avoid the `MODULE_TYPELESS_PACKAGE_JSON` warning.
- **`openclaw message read` does not support Telegram** (Discord/Slack/Matrix
  only). That's why we use a hook (push) for replies, not polling reads.
- **`openclaw message send` JSON shape** is `.payload.ok` / `.payload.messageId`
  / `.payload.chatId` — NOT `.payload.result.messageId`.
- **Owner Telegram id is self-bootstrapped** by the bridge from any inbound
  message → `owner.json` (`telegram:<id>`; strip the prefix for `--target`).
  `openclaw directory self --channel telegram` returns null under pairing mode.
- **The CLI `sqlite3` lacks the FTS5 module.** Safe for `PRAGMA`, `VACUUM`, and
  `DELETE FROM pending_messages` (no FTS triggers). NEVER `DELETE FROM
  observations`/`session_summaries` via the CLI — those fire FTS triggers and
  fail. Observation pruning is escalate-only and must run via the worker.
- **VACUUM needs the worker stopped** (exclusive lock) and ~1× DB-size free
  disk; `audit` checkpoints the WAL first.

## Editing

- All thresholds live in `etc/watchdog.conf`. Don't hardcode in scripts.
- After editing the bridge handler, copy it into the workspace and
  `openclaw gateway restart` (or re-run `./install.sh`). Confirm it loaded:
  `grep 'loaded .* internal hook' ~/.openclaw/logs/gateway.log` (count should
  include ours) and no `could not be resolved with realpath`.
- Syntax-check: `bash -n bin/*.sh`. Test ticks directly: `bash bin/watchdog-light.sh`.

## Origin

Built 2026-06-14 after root-causing claude-mem's 20 GB bloat to a stale
`CLAUDE_CODE_PATH`. Upstream issues: thedotmack/claude-mem#2793 (unbounded
growth), #2378 (retry-storm bloat).
