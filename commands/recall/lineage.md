---
description: "Walk a thread across sessions (handoff to successor)."
---

# /recall:lineage

Resolve and display the handoff chain for a session — which sessions it continued from and which sessions continued from it.

## Usage

First, ensure lineage has been resolved:

```bash
# Lineage resolution runs as part of backfill or can be triggered programmatically
# via the resolve module.
```

Then search for a session and read its `handoff_in` / `handoff_out` fields:

```bash
cc-recall search "<query>"
```

The `handoff_in.from_session` and `handoff_out.to_session` fields form a navigable DAG. Follow the chain by looking up each linked session_id in the sidecar.

## Note

Lineage resolution is best-effort. Unresolved links stay `null` — this is intentional (honest, not fuzzy). If a handoff link is missing, the matching heuristic didn't find a confident match within the 7-day time window.
