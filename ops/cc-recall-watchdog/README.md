# cc-recall-watchdog

A launchd watchdog that independently observes cc-recall's enrichment spawn rate and sidecar
growth, and escalates (notify-only) when either looks wrong — regardless of what cc-recall's
own in-process spawn-rate ceiling thinks is happening.

> **Status:** launchd light-tick watchdog, notify-only. **Not installed by default** — this
> repo's `Phase 3` guardrails ship the code, but the plugin itself is still disabled pending
> `Phase 5`; run `./install.sh` once cc-recall is re-enabled and you want it watched.

## Why a second, independent watchdog

`src/metrics/spawn-ceiling.ts` already enforces a hard ceiling on enrichment spawns *before*
they happen, inside cc-recall itself. That ceiling is necessary but not sufficient on its own:
Incident B (2026-08) was exactly a case where a real fix shipped to `main` on GitHub but never
reached the *running* plugin — the installed cache kept executing pre-fix code for six weeks
with nobody the wiser. An in-process gate that never runs protects nothing. This watchdog reads
the same on-disk signals (`~/.claude/cc-recall/metrics/adoption.jsonl`,
`~/.claude/cc-recall/index.db`) from *outside* the cc-recall process, on its own schedule, so a
stale/bypassed/missing gate is still visible.

## Components

| Path | Role |
|------|------|
| `bin/watchdog-light.sh` | ~5 min: enrichment spawn-rate check, sidecar growth check |
| `bin/lib.sh` | shared: logging, incident log, circuit breaker, notify, request lifecycle — ported from `ops/watchdog/bin/lib.sh` (claude-mem-watchdog), not reinvented |
| `etc/watchdog.conf` | all thresholds and paths |
| `launchd/com.ccrecall.watchdog-light.plist` | the scheduled job |

## What it checks

- **Enrichment spawn rate** — counts `enrichment_spawn` events in `adoption.jsonl` within the
  trailing `SPAWN_RATE_WINDOW_SECS` (default 1h, matching the app-side ceiling's own window).
  Alert threshold (`SPAWN_RATE_ALERT_MAX`, default 45) is set *above* the app-side ceiling's
  default (30/hour): a healthy, gated system should never reach it. Tripping it means the gate
  is missing, stale, or bypassed.
- **Sidecar growth** — tracks `index.db`'s size across ticks; a jump bigger than
  `SIDECAR_GROWTH_ALERT_MB` (default 25MB) between two consecutive 5-min ticks means records are
  being written far faster than a human is generating sessions.

Both use the same circuit-breaker primitive as claude-mem-watchdog: an isolated elevated tick
doesn't page anyone, `CIRCUIT_BREAKER_FAILS` (default 3) *consecutive* elevated ticks does.

## No auto-fix, no approval bridge (yet)

Unlike claude-mem-watchdog, there is nothing here for the watchdog to safely auto-remediate — a
spawn-rate or sidecar-growth spike needs a human to look at *why*, not a scripted retry. Every
escalation is `request_create`'d (written to `pending/*.json` + `incidents.jsonl`) and, if
`owner.json` is configured, sent as a one-way Telegram notification via OpenClaw. There is no
listening/approve-deny bridge wired up (claude-mem's is itself parked — see `cc-recall-mfr`); if
you want one, follow the same design documented in `ops/watchdog/README.md`.

## Install

```sh
./install.sh
launchctl list | grep ccrecall
launchctl kickstart -k gui/$(id -u)/com.ccrecall.watchdog-light   # force a run
tail -f ~/.cc-recall-watchdog/incidents.jsonl
```

`./uninstall.sh` removes the launchd job (`--purge` also deletes state).

## State & logs (`~/.cc-recall-watchdog/`)

- `pending/<id>.json` — open escalations (nothing here is ever auto-executed)
- `state.json` — circuit-breaker counters + last-seen sidecar size
- `incidents.jsonl` — append-only audit of every detection
- `logs/` — per-script logs
- `owner.json` — set manually, `{"channel":"telegram","id":"<chat-id>"}` (see `install.sh`)

## Requirements

**Core watchdog:** macOS · `bash` · `jq`. **Notifications only:** a running OpenClaw Gateway
with a connected Telegram channel.
