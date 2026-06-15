---
description: "Backfill discoverability records across the existing transcript corpus."
---

# /recall:backfill

Index existing transcripts into the sidecar and inject discoverability records. Idempotent and resumable — sessions whose source hash hasn't changed are skipped automatically.

## Usage

**Always dry-run first:**
```bash
cc-recall backfill --dry-run [--scope <substring>] [--limit N] [--no-llm]
```

**Then apply:**
```bash
cc-recall backfill [--scope <substring>] [--limit N] [--no-llm]
```

### Flags

- `--dry-run` — preview only, no writes to sidecar or transcripts
- `--scope <substring>` — only project dirs containing this substring (e.g. `pieces-dev`)
- `--limit N` — stop after N transcripts (useful for trial runs)
- `--no-llm` — skip `claude -p` enrichment, heuristic titles/summaries only (much faster)
- `--force` — reindex even if the source hash is unchanged
- `--db <path>` — sidecar database path (default: `~/.claude/cc-recall/index.db`)

## Interpreting output

Progress lines show `[done/total] idx|skip <session_id>`. Summary at the end:
```
backfill: 150/150 processed, 148 written, 2 skipped, 0 failed
```

## Recommended workflow

1. `cc-recall backfill --dry-run --limit 10` — verify on a small sample
2. `cc-recall backfill --no-llm` — fast heuristic pass over the full corpus
3. `cc-recall backfill` — LLM enrichment pass (slower, better titles/summaries)
