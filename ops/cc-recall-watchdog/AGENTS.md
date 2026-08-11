# AGENTS.md — cc-recall-watchdog

Operational guide for AI agents working on this repo. User-facing overview is in
[README.md](README.md).

## What this is

A pure-bash + launchd watchdog for cc-recall itself (spec Phase 3,
`docs/superpowers/specs/2026-08-10-incident-b-root-cause-and-guardrails.md`). Sibling to
`ops/watchdog/` (claude-mem-watchdog) — same `lib.sh` primitives, ported not reinvented, but a
separate `STATE_DIR` (`~/.cc-recall-watchdog`) and its own launchd label
(`com.ccrecall.watchdog-light`) so the two never collide.

Bash on purpose, matching `ops/watchdog/`: the job is `jq` + reading two files on disk, and a
watchdog must not fail for its own reasons.

## Why it exists alongside the in-process ceiling

`src/metrics/spawn-ceiling.ts` is the primary defense — a hard ceiling enforced in-process
before an enrichment subprocess spawns. This watchdog is the secondary one: it assumes that gate
can be absent (Incident B's actual root cause — a real fix that shipped to GitHub `main` but
never reached the *running* plugin cache for six weeks) and reads the same on-disk signals
independently. Don't couple the two checks tighter than that — the whole point is that this
watchdog keeps working even if the in-process code is stale or never ran.

## Gotchas specific to this watchdog (vs. claude-mem-watchdog)

- **No auto-fix exists.** claude-mem-watchdog restarts a worker, reaps orphans, repairs a config
  path — all safely reversible, mechanical fixes. There is no equivalent here: an elevated spawn
  rate or sidecar-growth reading needs a human to look at *why*, so every escalation is
  notify-only (`request_create`, never auto-dispatched). Don't add a `dispatch_action`/
  `process_decisions` wiring unless you also design what it would safely execute.
- **`lib.sh` here is a trimmed copy of `ops/watchdog/bin/lib.sh`**, not a shared import — bash
  has no clean cross-directory module system, and the two watchdogs' configs (`STATE_DIR`,
  `OWNER_FILE`, etc.) are already fully parameterized by their own `etc/watchdog.conf`, so a
  literal `source ../watchdog/bin/lib.sh` would work but would tie this watchdog's uptime to
  claude-mem-watchdog's directory existing. Keep them independent; if you fix a bug in one
  primitive (e.g. `notify()`, `request_create()`), port the fix to the other by hand and note it
  in both AGENTS.md files.
- **No FTS5 / SQLite PRAGMA logic.** cc-recall's sidecar (`index.db`) is checked only by raw file
  size via `stat`, not by any SQLite introspection — there's no `sqlite3` dependency here at all,
  unlike claude-mem-watchdog's PRAGMA-based bloat detection.
- Same `${3:-{}}` brace-counting trap as `ops/watchdog/AGENTS.md` documents — if you add a new
  `request_create` call site with inline JSON extra params, build it with `jq -cn` first and
  pass the resulting variable, don't inline literal `{}` into a `${var:-...}` default.

## Editing

- All thresholds live in `etc/watchdog.conf`. Don't hardcode in scripts.
- Syntax-check: `bash -n bin/*.sh`. Test ticks directly against a scratch `STATE_DIR`:
  ```sh
  STATE_DIR=/tmp/wd-test CC_RECALL_ADOPTION_FILE=/tmp/wd-test/adoption.jsonl \
    CC_RECALL_SIDECAR_DB=/tmp/wd-test/index.db bash bin/watchdog-light.sh
  ```
- `install.sh` installs only the launchd job. `uninstall.sh` removes it. Neither touches
  OpenClaw nor requires it — `notify()` degrades to a warned no-op if the gateway isn't
  configured, same as claude-mem-watchdog.

## Origin

Built 2026-08-11 for Phase 3 of the Incident B guardrails spec — see
`docs/superpowers/specs/2026-08-10-incident-b-root-cause-and-guardrails.md` and beads
`cc-recall-ba2`.
