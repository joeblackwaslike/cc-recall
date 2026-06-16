---
description: "Search the discoverability sidecar for past sessions by what was done/asked."
---

# /recall:search

Search the cc-recall sidecar for past sessions. The sidecar is the primary retrieval surface — query it before grepping raw transcripts or searching claude-mem.

## Usage

Run the CLI with the user's search terms:

```bash
cc-recall search "<query>" [--limit N]
```

The query is matched against session titles, summaries, facets (completed/questioned/asked_about), distinctive phrases, and files touched. Results are ranked by BM25 relevance.

## Interpreting results

Each result line shows: `<session_id>  <title>`. To get the full record for a session:

```bash
cc-recall search "<query>" --limit 1
```

Then read the transcript at `~/.claude/projects/<project>/<session_id>.jsonl` or query the sidecar DB directly.

## When the sidecar misses

If the sidecar returns no results, try:
1. Rephrase the query with different terms
2. Search claude-mem: use the `memory_search` or `observation_search` MCP tools
3. Grep raw transcripts as a last resort: `grep -rl "<term>" ~/.claude/projects/`
