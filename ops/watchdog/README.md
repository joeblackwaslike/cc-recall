# claude-mem-watchdog

A launchd watchdog that keeps [claude-mem](https://github.com/thedotmack/claude-mem)
healthy and stops it from silently failing into a multi-gigabyte database.

> **Status:** the **launchd auto-fix watchdog is live and self-sufficient** — it
> needs nothing else. The **Telegram approve/deny bridge is PARKED** (design below,
> seed in `openclaw/plugin/`): the `inbound_claim` claim plugin is not yet proven
> and `install.sh` does **not** install it or touch your OpenClaw gateway. Reviving
> it is tracked in beads `cc-recall-mfr` (build + prove on an isolated `openclaw
> --dev` profile first). Until then, escalations are **notify-only** — the watchdog
> DMs you; you act manually.

## Why

On 2026-06-14, claude-mem had silently broken weeks earlier: a stale
`CLAUDE_CODE_PATH` made the observation generator fail on every call, the
`pending_messages` queue never drained, the worker retry-stormed, and the
SQLite DB ballooned to **20 GB** (99.8 % empty freelist) before disk pressure
forced a look. Every failure mode was *mechanical and detectable*. This
watchdog watches those signals, auto-fixes the safe ones, and asks for approval
over Telegram before doing anything destructive.

## Architecture — who listens vs. who acts (the parked bridge design)

The auto-fixes need none of this. This is the **intended** approve/deny design,
currently parked (see Status). A periodic shell script can *send* a Telegram
message but can't *listen* for a reply. So the watchdog **never listens** — the
listening is delegated to OpenClaw's always-on Gateway via a claim plugin, and the
two sides rendezvous through files:

```
                              ~/.claude-mem-watchdog/
  ┌──────────────┐   writes   ┌─────────────┐   polls    ┌──────────────┐
  │ OpenClaw     │ ─────────▶ │ decisions/  │ ◀───────── │ watchdog     │
  │ Gateway      │            │ pending/    │ ─────────▶ │ (launchd)    │
  │ (listener,   │            └─────────────┘   writes   │ actor+poller │
  │  bridge hook)│ ◀── reply  Telegram ── send ───────── │              │
  └──────────────┘            (you)                      └──────────────┘
```

1. **Watchdog** (launchd bash) detects a destructive-class condition → writes
   `pending/<id>.json` → `openclaw message send` you a Telegram alert with a
   short id.
2. **You** reply `approve <id>` / `deny <id>` from any device.
3. **OpenClaw Gateway** (always listening) fires the **decision bridge** hook,
   which writes `decisions/<id>.json`.
4. **Watchdog** on its next light tick reads the decision and executes (or
   skips) the action — idempotently, once, with a 24 h expiry on approvals.

## Components

| Path | Role |
|------|------|
| `bin/watchdog-light.sh` | ~5 min: worker health, orphan reap, `CLAUDE_CODE_PATH` repair, **decision polling/execution** |
| `bin/watchdog-audit.sh` | ~6 h: DB bloat / queue / disk audit, auto-VACUUM + prune, **raises approval requests** |
| `bin/lib.sh` | shared: logging, notify, DB PRAGMA, request/decision lifecycle, circuit breaker |
| `etc/watchdog.conf` | all thresholds and paths |
| `openclaw/plugin/` | **(parked)** seed for the OpenClaw `inbound_claim` claim plugin — the Telegram listener, to be proven on `--dev` (see `cc-recall-mfr`) |
| `launchd/com.claudemem.watchdog-{light,audit}.plist` | the two scheduled jobs |

## Autonomy boundary

**Auto-fix, no approval:** restart dead worker · reap orphan `mcp-server.cjs`
procs · repair invalid `CLAUDE_CODE_PATH` · VACUUM when bloated **and** large
**and** disk has headroom · prune `failed`/stale `pending_messages`.

**Escalate (Telegram approval required):** delete large bloat backups · free
disk when critically low · prune `observations` (destructive) · any auto-fix
that fails ≥ `CIRCUIT_BREAKER_FAILS` times in a row.

## Install

```sh
./install.sh                                                       # launchd jobs only; no gateway changes
launchctl list | grep claudemem
launchctl kickstart -k gui/$(id -u)/com.claudemem.watchdog-audit   # force a run
tail -f ~/.claude-mem-watchdog/incidents.jsonl
```

`./uninstall.sh` removes the launchd jobs (`--purge` also deletes state). Neither
script touches OpenClaw while the bridge is parked. For notify-only escalations,
`owner.json` must exist (the parked bridge would self-bootstrap it; until then set
it manually — see `install.sh` output).

## State & logs (`~/.claude-mem-watchdog/`)

- `pending/<id>.json` — open approval requests
- `decisions/<id>.json` — verdicts written by the bridge
- `state.json` — circuit-breaker counters
- `incidents.jsonl` — append-only audit of every detection + action
- `logs/` — per-script logs (`BRIDGE_DEBUG` file enables verbose bridge logging)

## Requirements

**Core watchdog:** macOS · `bash` · `jq` · `sqlite3` · `curl` · claude-mem installed
under `~/.claude/plugins/cache/thedotmack/claude-mem`.

**Only for notifications / the (parked) approval bridge:** a running OpenClaw Gateway
with a connected Telegram channel.
