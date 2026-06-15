---
description: "Show backfill coverage, sidecar counts, and surface health."
---

# /recall:status

Quick overview of cc-recall state. Runs the same checks as `/recall:doctor` but optimized for a quick status line rather than diagnostics.

## Usage

```bash
cc-recall doctor [--db <path>]
```

Report to the user: the sidecar session count, backfill coverage percentage, and claude-mem G0 status.
