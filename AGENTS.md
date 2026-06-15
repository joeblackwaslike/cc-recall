# cc-recall

Discoverability and enrichment for Claude Code session transcripts.

## What this is

Claude Code writes every session to a `.jsonl` transcript under `~/.claude/projects/`.
There are tens of thousands of them. They are indexed only by title, first message, and
recency — so most substantial work is effectively unfindable by browsing. cc-recall makes
every session (past and future) discoverable by **what was done, asked, and questioned**.

It does this by synthesizing a consistent **discoverability record** per session and writing
it to several surfaces:

- **in-transcript** — injected into the `.jsonl` in place (also rewrites the one-line title)
- **sidecar index** — a single SQLite store outside the transcripts; the primary, we-own-it
  source of truth for retrieval (query one file, not 15,000)
- **claude-mem** — upserted per-session observation (secondary; gated on a reliability check)
- **Claude native memory** — a curated front page of pointers + most-significant sessions

A `SessionEnd` hook captures new sessions forward; a backfill engine processes the existing
corpus; a `UserPromptSubmit` hook reminds the agent to search the records before grepping raw.

## Status

Phase 1 implemented. Design spec lives in `docs/superpowers/specs/`.

## Stack

TypeScript, ESM, Node 22+. Matches the conventions of the sibling `pieces-dev` monorepo
(Biome, Vitest, strict TS, no `any`).

## Conventions

- TypeScript strict mode, ESM only; no `any` — use `unknown` + narrowing.
- Edit-in-place on transcripts MUST be backed up, idempotent, reversible, and integrity-checked.
- The sidecar is the source of truth. claude-mem and native memory are secondary and must
  degrade gracefully — a failure in either never breaks retrieval.
