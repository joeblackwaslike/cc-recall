---
description: "Diagnostics for claude-mem G0, sidecar integrity, coverage, and fixes."
---

# /recall:doctor

Run health and integrity checks across all cc-recall surfaces. Use this to verify the system is working before backfill or to diagnose issues.

## Usage

```bash
cc-recall doctor [--db <path>]
```

## What it checks

1. **Sidecar integrity** — opens the database, counts sessions, runs an FTS probe. Reports OK or the error.
2. **Backfill coverage** — what percentage of on-disk transcripts are indexed in the sidecar.
3. **claude-mem G0** (spec S12) — probes the claude-mem worker for health, readiness, and a search round-trip. Surface 3 (claude-mem observations) stays disabled unless G0 passes. A G0 failure does NOT affect the sidecar or transcript surfaces.
4. **cc-recall-watchdog liveness** — queries `launchctl` directly to confirm the independent spawn-rate/sidecar-growth observer is actually registered, not just installed at some point in the past.
5. **Deployment self-verification** — compares the installed plugin cache (`installed_plugins.json`'s `version`/`installPath`) against the release-time content-hash manifest shipped inside `dist/release-manifest.json`, catching a self-deploy that bumped version metadata without actually replacing the fix-bearing files.

## Interpreting output

```text
sidecar: OK — 15154 sessions at ~/.claude/cc-recall/index.db
coverage: 98.2% (14882/15154 transcripts indexed)
claude-mem G0: PASS — health + readiness + search round-trip OK (v2.1.0)
cc-recall-watchdog: installed (com.ccrecall.watchdog-light)
deployment: OK — installed cache (v0.3.0) matches its release manifest — 42 files verified
```

Or on failure:

```text
claude-mem G0: FAIL — worker not reachable (surface 3 stays disabled — sidecar unaffected)
deployment: MISMATCH — installed_plugins.json reports version 0.3.0 but the shipped manifest says 0.2.2 — self-deploy updated metadata without replacing files
```

## When G0 fails

G0 failure means claude-mem is down or unhealthy. cc-recall works fine without it — the sidecar is the primary surface. To fix claude-mem itself, check the worker process and database separately.
