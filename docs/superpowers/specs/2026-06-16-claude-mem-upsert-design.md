# claude-mem Upsert Surface (§S3) — Design Spec

**Date:** 2026-06-16
**Status:** Approved
**Parent spec:** `2026-06-14-cc-recall-design.md` §8③, §12 G0, §15 Phase 5

---

## Problem

cc-recall's sidecar SQLite is the primary retrieval surface, but claude-mem is a secondary
surface that agents already search via `mem-search`. Today, cc-recall writes nothing to
claude-mem — surface ③ is read-only (G0 health gate only). Claude-mem's own auto-observations
capture session activity but lack cc-recall's richer metadata: synthesized title, summary,
facets, handoff lineage, and file/tool artifacts.

## Goal

Write a cc-recall observation per session into claude-mem's observations table so that
`mem-search` queries surface cc-recall's richer session metadata alongside claude-mem's
own observations. This is a SECONDARY surface — failure never breaks the sidecar or
transcript surfaces.

## Transport: Direct SQLite

Write to `~/.claude-mem/claude-mem.db` (or `$CLAUDE_MEM_DATA_DIR/claude-mem.db`) using
`node:sqlite` (Node 22+ built-in, already used by the sidecar). The worker runs in WAL
mode, supporting concurrent readers. cc-recall writes are infrequent (one per session),
so lock contention is negligible.

The observations table has:
- FTS triggers (`observations_ai`) that auto-index on INSERT
- A unique index on `(memory_session_id, content_hash)` for dedup

### Why not HTTP?

The worker's `/v1/memories` endpoint requires server-beta auth
(`CLAUDE_MEM_SERVER_BETA_API_KEY`), which is not configured in worker mode. The MCP tool
`observation_add` also requires server-beta runtime. Direct SQLite bypasses both constraints
while maintaining the same FTS indexing and dedup guarantees.

## Flow

1. **G0 gate** — `verifyClaudeMemG0()` must pass (worker reachable + ready + search OK)
2. **DB open** — open `claude-mem.db` read-write with WAL pragma, busy timeout 3s
3. **Session lookup** — `SELECT memory_session_id FROM sdk_sessions WHERE content_session_id = ?`
   - If not found → log warning, return `{ ok: false }` (session not yet tracked by claude-mem)
4. **Format** — map `RecallRecord` → observation columns:
   - `memory_session_id`: from step 3
   - `project`: from record.project (decoded to repo name)
   - `type`: `"cc-recall"` (distinguishes from auto-observations)
   - `title`: record.title
   - `subtitle`: first sentence of record.summary
   - `narrative`: full formatted text (summary + facets + completions + handoffs)
   - `facts`: JSON array of asks_implemented + completions
   - `concepts`: comma-joined facet keywords
   - `files_read`: JSON array of files_touched (read-only proxy)
   - `files_modified`: JSON array of files_touched
   - `content_hash`: SHA-256 hex of the narrative text
   - `metadata`: `{ source: "cc-recall", schema_version, synthesizer_version, session_id }`
   - `created_at`: record.generated_at (ISO)
   - `created_at_epoch`: epoch millis from generated_at
5. **Write** — `INSERT OR IGNORE` (dedup by unique index). If content changed (re-backfill
   with new synthesizer), the new hash → new row; stale row stays (append-only, no deletes)
6. **Wrap** — entire flow in try/catch; failure returns `{ ok: false, error }`, never throws

## Observation text format

The `narrative` field is the primary search surface. Format:

```
[cc-recall] {title}

{summary}

Completed: {facets.completed joined}
Questioned: {facets.questioned joined}
Asked about: {facets.asked_about joined}

Key changes: {asks_implemented joined}
Files: {artifacts.files_touched joined}
Top tools: {top_tools formatted}
{handoff_in ? "Continued from: " + handoff_in.text : ""}
{handoff_out ? "Hands off to: " + handoff_out.text : ""}
```

## Engine integration

In `indexSession()`, after sidecar upsert + transcript write and before returning:

```ts
if (!options.dryRun) {
  await upsertToClaudeMem(record, { onWarn: options.onWarn });
}
```

Non-blocking to the return value — `IndexResult` is unaffected by claude-mem failures.

## Files changed

| File | Change |
|------|--------|
| `src/surfaces/claude-mem.ts` | Add `upsertObservation()`, `formatObservation()`, `resolveClaudeMemDb()`, session-lookup helper |
| `src/surfaces/claude-mem.test.ts` | Test formatting, dedup, missing-session skip, DB-not-found skip |
| `src/engine.ts` | Wire `upsertToClaudeMem()` into `indexSession()` |

## Testing

- **Format** — snapshot test of `formatObservation()` output from a fixture RecallRecord
- **Dedup** — insert same observation twice, assert second is ignored (row count = 1)
- **Missing session** — `upsertObservation()` with unknown session_id returns `{ ok: false }`
- **DB not found** — `resolveClaudeMemDb()` returns undefined when path doesn't exist
- **G0 failure** — upsert skipped when G0 fails, no error propagated

All tests use an in-memory SQLite DB with the claude-mem schema replicated (observations +
sdk_sessions tables + triggers).

## Safety

- **Read-write window is minimal** — open DB, one INSERT, close. No long-lived connection.
- **Busy timeout** — 3s PRAGMA busy_timeout prevents WAL lock errors during concurrent worker writes.
- **INSERT OR IGNORE** — never overwrites existing data; append-only.
- **No schema migrations** — cc-recall never ALTER TABLEs on claude-mem's database.
- **Graceful degradation** — DB missing, session missing, write fails → all logged, never thrown.
