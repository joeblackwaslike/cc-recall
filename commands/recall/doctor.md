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

## Interpreting output

```text
sidecar: OK — 15154 sessions at ~/.claude/cc-recall/index.db
coverage: 98.2% (14882/15154 transcripts indexed)
claude-mem G0: PASS — health + readiness + search round-trip OK (v2.1.0)
```

Or on failure:

```text
claude-mem G0: FAIL — worker not reachable (surface 3 stays disabled — sidecar unaffected)
```

## When G0 fails

G0 failure means claude-mem is down or unhealthy. cc-recall works fine without it — the sidecar is the primary surface. To fix claude-mem itself, check the worker process and database separately.
