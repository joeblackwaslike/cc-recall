# cc-recall

[![CI](https://github.com/joeblackwaslike/cc-recall/actions/workflows/ci.yml/badge.svg)](https://github.com/joeblackwaslike/cc-recall/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org)

Discoverability and enrichment for Claude Code session transcripts.

## The Problem

Claude Code writes every session to a `.jsonl` transcript under `~/.claude/projects/`. On a typical machine there are **15,000+** of them across hundreds of projects. **97.7% have no title** — they surface only by first message and recency, which means most substantial work is effectively unfindable by browsing.

## What cc-recall Does

cc-recall synthesizes a structured **RecallRecord** for each session and writes it to multiple surfaces:

| Surface | Purpose |
|---------|---------|
| **Sidecar SQLite** (primary) | FTS5-indexed store — query one file instead of 15,000 transcripts |
| **Transcript in-place** | Injects the record into the `.jsonl` so it travels with the file |
| **claude-mem** (secondary) | Upserts per-session observations for cross-project search |

A `SessionEnd` hook captures new sessions automatically. A backfill engine processes the existing corpus. A `UserPromptSubmit` hook reminds the agent to search the sidecar before grepping raw transcripts.

## Installation

```bash
# Add the marketplace (once)
claude plugin marketplace add joeblackwaslike/agent-marketplace

# Install cc-recall
claude plugin install cc-recall
```

The plugin auto-builds on first session start via a `SessionStart` hook — no manual build step needed.

## Usage

### Search past sessions

```bash
cc-recall search "auth middleware JWT"
```

Results show `<session_id>  <title>`, ranked by FTS5 relevance. Matches titles, summaries, facets, files touched, and distinctive phrases.

### Commands

| Command | Description |
|---------|-------------|
| `/recall:search` | Search the sidecar index |
| `/recall:backfill` | Index existing transcripts (use `--dry-run` first) |
| `/recall:status` | Quick status: session count, coverage, surface health |
| `/recall:doctor` | Health checks: sidecar integrity, coverage, claude-mem G0 |
| `/recall:lineage` | Walk handoff chains across sessions |
| `/recall:migrate` | Consolidate old home-path slugs (prerequisite to backfill) |

### How It Works

Each session gets a `RecallRecord` containing:

- **title** and **summary** — what the session accomplished
- **asks_implemented** — specific asks that were completed
- **facets** — three retrieval dimensions: `completed`, `questioned`, `asked_about`
- **artifacts** — files touched, top tools used, distinctive phrases
- **handoff_in / handoff_out** — links to predecessor/successor sessions
- **provenance** — `forward` (live capture) or `backfill` (retroactively indexed)

The synthesizer runs in two modes: a fast heuristic pass that extracts metadata from transcript structure, and an optional LLM-enriched pass (via `claude -p`) for higher-quality summaries.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint        # ESLint + Biome
```

### Project Structure

```
src/
  engine.ts              # Core orchestration
  types.ts               # Shared domain types
  record/                # RecallRecord schema + synthesizer
  transcript/            # Transcript JSONL parser
  lineage/               # Session handoff matching
  surfaces/              # Output surfaces (sidecar, transcript, claude-mem)
  migrate/               # Home-path normalization (Phase 0)
hooks/                   # Plugin lifecycle hooks
commands/recall/         # Slash commands
skills/using-cc-recall/  # Agent skill definition
```

## License

MIT
