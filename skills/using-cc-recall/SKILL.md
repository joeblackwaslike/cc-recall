---
name: using-cc-recall
description: Use when trying to find or restore a past Claude Code session — "did we already do X", "find the session where…", recurring topics, or prior work. Search the cc-recall sidecar before grepping raw transcripts.
---

# Using cc-recall

cc-recall makes past Claude Code sessions discoverable by what was done, asked, and questioned. It maintains a SQLite sidecar index with FTS5 search over ~15k sessions.

## Finding a past session

**Step 1 — Search the sidecar (fastest, most accurate):**

```bash
cc-recall search "<what you remember>"
```

Results show `<session_id>  <title>`, ranked by relevance. The query matches titles, summaries, facets, phrases, and files touched.

**Step 2 — If the sidecar misses, try claude-mem:**
Use the `observation_search` or `memory_search` MCP tools with similar keywords.

**Step 3 — Last resort, grep raw transcripts:**

```bash
grep -rl "<specific term>" ~/.claude/projects/
```

## Other commands

- `/recall:backfill` — index existing transcripts (run `--dry-run` first)
- `/recall:migrate` — consolidate old home-path slugs (prerequisite to backfill)
- `/recall:doctor` — health checks (sidecar integrity, coverage, claude-mem G0)
- `/recall:status` — quick status line (session count, coverage, surface health)
- `/recall:lineage` — walk handoff chains across sessions

## How it works

Each session gets a `RecallRecord` with: title, summary, asks_implemented, completions, handoff_in/out, artifacts (files, tools, phrases), and three retrieval facets (completed, questioned, asked_about). Records are stored in a sidecar SQLite DB and optionally injected into the transcript itself.
