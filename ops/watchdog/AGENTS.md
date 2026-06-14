# AGENTS.md — claude-mem-watchdog

Operational guide for AI agents working on this repo. User-facing overview is in
[README.md](README.md); this file holds the non-obvious gotchas.

## What this is

A pure-bash + launchd watchdog for the claude-mem plugin. Language is **bash on
purpose** (not the usual TS default): the job is entirely `curl`/`sqlite3`/
`pkill`/`openclaw`, and a watchdog must not fail for its own reasons. The
launchd auto-fix watchdog is the working core and needs no OpenClaw.

A Telegram approve/deny **bridge is PARKED** (`openclaw/plugin/`, not installed by
`install.sh`) — see beads `cc-recall-mfr` and the gotchas below.

## Hard-won gotchas (do not relearn these)

- **`${3:-{}}` is a trap in bash.** `${param:-word}` does NOT nest-count braces:
  the first `}` closes the expansion and the second becomes a literal, so
  `"${3:-{}}"` yields `$3` + a stray `}`, corrupting JSON passed to
  `jq --argjson`. Always use `local x="${3:-}"; [ -n "$x" ] || x='{}'`.
- **The approval bridge is PARKED — build it on `openclaw --dev`, never the live
  gateway.** The intended design is an OpenClaw `inbound_claim` *plugin* hook that
  returns `{handled:true}` to claim `approve/deny <id>` replies BEFORE agent
  dispatch, so the agent never sees them. Hard-won plugin gotchas:
  - **Internal hooks can't claim.** A legacy internal `message:received` handler
    (`hooks.internal.handlers`, event `message`/action `received`) is fire-and-forget
    — it writes a decision but can't stop the agent from also replying. Hence a
    *plugin* `inbound_claim` hook (this is why the original handler.mjs was dropped).
  - **`definePluginEntry` is on `openclaw/plugin-sdk/core`**, NOT `openclaw/plugin-sdk`
    (its index doesn't re-export it → `undefined`/"not a function"). A plain-object
    export loads without error but the loader never wires its `register()`, so the
    hook silently never fires — the `definePluginEntry` wrapper is required.
  - **Plugin packaging:** `openclaw plugins install <dir>` needs `package.json` with
    `openclaw.extensions:["./index.js"]` + `openclaw.plugin.json` with a `configSchema`.
  - **`plugins.allow` is an EXCLUSIVE allowlist** — setting it (even to `[]`) drops
    every plugin not listed (this cut the live set ~10 → 3). Leave the key absent.
  - The `inbound_claim` event exposes `event.channel` (not `channelId`), `.content`,
    `.senderId`, `.conversationId`. Owner Telegram chat id = `1802148062`.
- **`openclaw message read` does not support Telegram** (Discord/Slack/Matrix
  only). That's why we use a hook (push) for replies, not polling reads.
- **`openclaw message send` JSON shape** is `.payload.ok` / `.payload.messageId`
  / `.payload.chatId` — NOT `.payload.result.messageId`.
- **Owner Telegram id is self-bootstrapped** by the (parked) bridge from any inbound
  message → `owner.json` (`telegram:<id>`; strip the prefix for `--target`).
  `openclaw directory self --channel telegram` returns null under pairing mode, so
  there's no clean lookup — capture it from an inbound message instead.
- **The CLI `sqlite3` lacks the FTS5 module.** Safe for `PRAGMA`, `VACUUM`, and
  `DELETE FROM pending_messages` (no FTS triggers). NEVER `DELETE FROM
  observations`/`session_summaries` via the CLI — those fire FTS triggers and
  fail. Observation pruning is escalate-only and must run via the worker.
- **VACUUM needs the worker stopped** (exclusive lock) and ~1× DB-size free
  disk; `audit` checkpoints the WAL first.

## Editing

- All thresholds live in `etc/watchdog.conf`. Don't hardcode in scripts.
- Syntax-check: `bash -n bin/*.sh`. Test ticks directly: `bash bin/watchdog-light.sh`.
- `install.sh` installs ONLY the launchd jobs (no OpenClaw changes). `uninstall.sh`
  removes them. Neither touches the gateway while the bridge is parked.
- Reviving the bridge: work in an isolated `openclaw --dev` profile (state under
  `~/.openclaw-dev`, separate port). Prove the `inbound_claim` claim end-to-end
  there before ever installing against the live gateway.

## Origin

Built 2026-06-14 after root-causing claude-mem's 20 GB bloat to a stale
`CLAUDE_CODE_PATH`. Upstream issues: thedotmack/claude-mem#2793 (unbounded
growth), #2378 (retry-storm bloat).
