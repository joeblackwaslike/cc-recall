# claude-mem Watchdog — Design Plan

## Context

On 2026-06-14 a full QA pass on the `claude-mem` plugin found it had silently broken weeks earlier and the failure had cascaded into a **20 GB database** (99.8% empty freelist), a dead worker daemon, 54 orphaned processes, and 39 GB of disk use. Root cause: a stale `CLAUDE_CODE_PATH` (pointing at a nonexistent binary after an account rename + node-version change) made the observation generator fail on every call; because a failed generator never drains the `pending_messages` queue, the worker retry-stormed and the DB bloated. All of it was invisible until disk pressure forced a look.

The lesson: claude-mem is actively developed, fails silently, and its failure modes are *mechanical and detectable* (dead port, missing binary, freelist ratio, queue depth, orphan count). Joe wants a **launchd watchdog** that watches these signals, **auto-corrects the safe ones**, and for anything destructive **asks for approval over Telegram and waits** — without the watchdog itself having to be a long-running listener.

The hard part Joe flagged: a periodic bash script can *send* a Telegram message but cannot *listen* for the reply. This plan's central design resolves that asymmetry. **Scope decision: build the full bidirectional approve-by-Telegram loop now (Option B).**

## Architecture: who listens vs. who acts

The watchdog **never listens**. The listening is delegated to **OpenClaw's always-on Gateway** (it already holds the Telegram bot connection 24/7). The two sides rendezvous through **files on disk**, which the watchdog polls on its normal schedule. Three cooperating parts:

1. **Watchdog scripts** (launchd bash) — the *actor + poller*. Detects conditions, runs safe fixes, creates approval requests, and on each tick polls for decisions and executes approved fixes. Pure shell: `curl`, `sqlite3`, `pkill`, `jq`, `openclaw message send`.
2. **OpenClaw decision bridge** (a small OpenClaw hook) — the *translator*. Fires inside the Gateway when an inbound Telegram message arrives, matches `^(approve|deny) <id>$`, and writes a decision file. This is the only new code that runs inside OpenClaw.
3. **OpenClaw Gateway** (already running) — the *listener*. Not built here; a dependency. Holds the Telegram connection and invokes the bridge hook.

### Shared state directory `~/.claude-mem-watchdog/`
- `pending/<id>.json` — open approval requests: `{id, condition, action, params, created_at, expires_at, status}`.
- `decisions/<id>.json` — verdicts written by the bridge: `{requestId, verdict, from, decidedAt}`.
- `state.json` — last-run stamps, per-fix consecutive-failure counters (circuit breaker), last-known-good `CLAUDE_CODE_PATH`.
- `incidents.jsonl` — append-only audit log of every detection + action.
- `logs/` — per-script logs.

## The approval round-trip (the mechanism, end to end)

```
 AUDIT detects a destructive-class condition
        │
        ▼
 [watchdog]  id=a1b2 ; write pending/a1b2.json {status: awaiting-approval, expires_at: +24h}
        │     openclaw message send --channel telegram --target $OWNER_ID \
        │       --message "⚠️ claude-mem: <condition>. Approve <action>?  reply: approve a1b2 | deny a1b2  (24h)"
        ▼
   Telegram ── push ──▶  Joe (any device)
        │
        │  Joe replies:  approve a1b2
        ▼
 OpenClaw GATEWAY (always listening)  ── inbound message ──▶  decision-bridge hook
        │                                   matches /^(approve|deny) (\w+)$/
        ▼
   write decisions/a1b2.json {verdict: approve, decidedAt: ...}
        │
        ▼
 [watchdog]  next LIGHT tick (≤5 min): scan pending/ → find a1b2 → read decisions/a1b2.json
        │     approve + not expired → run the action (idempotent) → pending.status=executed
        │                           → openclaw message send "✅ done"
        │     deny                  → pending.status=denied      → "🛑 skipped"
        │     no decision + expired → pending.status=expired     → re-notify / give up (never auto-act)
        ▼
   done — each id acted on exactly once
```

**Why this answers "how do I approve if you can't listen?":** the *send* is push (watchdog→Telegram); the *reply* path is Gateway→hook→file→watchdog-poll. The watchdog only ever **reads a local file**. OpenClaw — the process actually designed to listen — does the listening. Approvals are pull-based and **idempotent**: a unique id per request, acted on once, then archived; expiry prevents a stale "approve" from firing days later. This `pending/` + `decisions/` convention is intentionally generic, so future tools can reuse the same Telegram-approval pattern.

## Autonomy boundary (confirmed with Joe)

**Auto-fix, no approval** (light unless noted):
- **Worker dead** (`curl :37777/health` fails) → restart via `worker-service.cjs start`.
- **Orphan procs** (`mcp-server.cjs` count > threshold or aged) → reap.
- **Bad `CLAUDE_CODE_PATH`** (configured binary missing) → re-resolve to first valid candidate (`/opt/homebrew/bin/claude`, volta, nvm) and patch `~/.claude-mem/settings.json`.
- **Bloat/queue** (audit): when `freelist_ratio > 0.5` AND `db_size > 500 MB` AND free disk `> 2× db_size` → stop worker, `VACUUM`, restart. Prune `pending_messages` where `status='failed'` OR (`status='pending'` AND age > 24h). *(Never touches `observations`/`session_summaries`; never uses the FTS5-less CLI on FTS tables.)*

**Escalate-only (Telegram approval required):**
- Anything that would delete `observations`/`session_summaries`.
- Deleting large backups (e.g. `*.db.bloated-*`, `backups/`).
- **Circuit breaker:** a fix that failed ≥3 consecutive times — stop auto-retrying, ask the human.

## Detection signals (audit tick)
`PRAGMA page_count/freelist_count/page_size` (size + freelist ratio) · `pending_messages` counts by status + oldest age · worker health · `CLAUDE_CODE_PATH` validity · `df` free disk · `du ~/.claude-mem` + log sizes · orphan `mcp-server.cjs` count. These map 1:1 onto today's incident — the watchdog would have caught and auto-fixed every part of it.

## Repository layout (mirrors `beadboard-ops` conventions)

New repo: **`/Users/joe/github/joeblackwaslike/claude-mem-watchdog`** (TS-default is overridden here per the "Shell/Scripts → composable tools" preference; the job is entirely `curl`/`sqlite3`/`openclaw`, and a watchdog must not fail for its own reasons — only the OpenClaw bridge is JS, because it runs inside node OpenClaw).

```
claude-mem-watchdog/
├── launchd/
│   ├── com.claudemem.watchdog-light.plist   # StartInterval 300  (~5 min)
│   └── com.claudemem.watchdog-audit.plist   # StartInterval 21600 (~6 h)
├── bin/
│   ├── watchdog-light.sh    # health/orphans/path + poll decisions + execute approved
│   ├── watchdog-audit.sh    # db/queue/disk audit + safe fixes + raise approvals
│   └── lib.sh               # shared: logging, jq state helpers, openclaw send, db PRAGMA, request/decision lifecycle
├── etc/
│   └── watchdog.conf         # thresholds, OWNER_ID, paths, candidate claude binaries
├── openclaw/decision-bridge/ # the inbound-message hook (HOOK.md + handler.js)
├── install.sh                # symlink plists → ~/Library/LaunchAgents, bootstrap+enable; install OpenClaw hook; mkdir state dir
├── uninstall.sh              # bootout + rm symlinks + disable hook
└── README.md
```

Conventions copied from `beadboard-ops`: `com.claudemem.*` labels; plists call the shell script directly (shebang, not `bash -lc`); `EnvironmentVariables` sets `HOME` + `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`; `RunAtLoad=true`, `KeepAlive=false` (periodic, not supervised); install via `launchctl bootout || true` → `bootstrap gui/$UID` → `enable`; symlink (not copy) plists. Add `StartInterval` (which `beadboard-ops` doesn't use) for the periodic cadence.

### The OpenClaw decision bridge
Implement as an **internal HOOK.md hook** (`~/.openclaw/hooks/claude-mem-decisions/` with `HOOK.md` declaring `events: ["message:received"]` + `handler.js`), enabled via `openclaw hooks enable`. Fallback if the internal hook proves unreliable: the **`message_received` plugin hook** (`~/.openclaw/agents/default/agent/plugins/...`). Handler matches `/^(approve|deny)\s+(\w+)$/i` on Telegram DMs and writes `decisions/<id>.json`. Reference implementations and exact event signatures:
- `openclaw/src/hooks/internal-hook-types.ts` and `src/hooks/internal-hooks.ts:220+` (internal hook)
- `openclaw/src/plugins/hook-message.types.ts:53-67` and `src/auto-reply/reply/dispatch-from-config.ts:689` (plugin hook)
- `openclaw directory self --channel telegram --json` → `.id` resolves `$OWNER_ID`
- `openclaw gateway status --json --require-rpc` → preflight before send

## Build order
1. **Spike the bridge first (de-risk the one uncertain piece).** Build the OpenClaw hook, `openclaw gateway restart`, send a test DM, reply `approve test1`, confirm `~/.claude-mem-watchdog/decisions/test1.json` appears. If the internal hook doesn't fire, switch to the plugin hook. Do not build the rest until this round-trips.
2. `lib.sh` + `watchdog.conf` (state helpers, thresholds, owner-id resolution, `openclaw` send wrapper with gateway preflight).
3. `watchdog-light.sh` (worker restart, orphan reap, path re-resolve, decision polling/execution, expiry).
4. `watchdog-audit.sh` (PRAGMA-based bloat/queue/disk detection, safe VACUUM+prune, raise approval requests for destructive cases, circuit breaker in `state.json`).
5. `install.sh`/`uninstall.sh`, plists, `README.md`.
6. `bd init --shared-server --skip-agents` for task tracking; commit.

## Verification (end-to-end)
- **Bridge:** test DM → reply → decision file appears (step 1 above).
- **Auto-fixes (simulate each):** `pkill` the worker → light tick restarts it; spawn dummy `mcp-server.cjs` procs → reaped; set a bogus `CLAUDE_CODE_PATH` → re-resolved + `settings.json` patched; point at a synthetic bloated test DB over threshold → VACUUM runs (worker stopped/restarted, disk headroom checked); insert stale `pending` rows → pruned.
- **Approval round-trip:** craft a destructive-class condition → `pending/<id>.json` + Telegram alert appears → reply `approve <id>` → next light tick executes + confirms "✅"; repeat with `deny`; let one expire → marked expired, never auto-acted.
- **Circuit breaker:** force a fix to fail 3× → auto-retry stops, escalation sent.
- **Idempotency:** re-run light tick after an executed approval → no double-execution.
- **launchd:** `install.sh` → `launchctl list | grep claudemem` → `launchctl kickstart -k gui/$UID/com.claudemem.watchdog-audit` → inspect `incidents.jsonl` + logs.

## Out of scope (noted, not built)
- Event-driven (no-poll) approvals via an OpenClaw hook that triggers the watchdog directly — current ≤5 min poll latency on approved fixes is acceptable for v1.
- Telegram inline-button / poll UX (text `approve <id>` is more robustly parseable).
- Generalizing the `pending/`+`decisions/` convention into a shared library for other tools (format is kept generic so it can be extracted later).
