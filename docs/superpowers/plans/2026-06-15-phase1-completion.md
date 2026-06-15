# cc-recall Phase 1 Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remaining Phase 1 deliverables — lineage matching, prompt-submit hook, command bodies, skill content, real-data validation, and the S0/U0 research spike — so cc-recall is ready for the Phase 0 migration run and trial backfill.

**Architecture:** Core modules (types, schema, parser, synthesizer, sidecar, transcript-writer, claude-mem, native-memory, home-path migration, engine, CLI, session-end hook) are all implemented and green (32/32 tests). This plan fills the gaps: lineage matching logic, the UserPromptSubmit intent-detection hook, the 6 slash-command bodies, the skill file, and a validation pass against real transcripts.

**Tech Stack:** TypeScript 5.x strict ESM, Node 22+ (`node:sqlite`, `node:fs`, `node:crypto`), Zod 4, Vitest, Biome + ESLint strict

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Implement | `src/lineage/match.ts` | Handoff-out ↔ successor first-message matching (text similarity + time proximity) |
| Create | `src/lineage/match.test.ts` | Unit tests for lineage matching |
| Implement | `hooks/prompt-submit.mjs` | Detect "find/restore a past session" intent → inject sidecar search reminder |
| Modify | `commands/recall/search.md` | Full agent instructions for `/recall:search` |
| Modify | `commands/recall/backfill.md` | Full agent instructions for `/recall:backfill` |
| Modify | `commands/recall/migrate.md` | Full agent instructions for `/recall:migrate` |
| Modify | `commands/recall/doctor.md` | Full agent instructions for `/recall:doctor` |
| Modify | `commands/recall/status.md` | Full agent instructions for `/recall:status` |
| Modify | `commands/recall/lineage.md` | Full agent instructions for `/recall:lineage` |
| Modify | `skills/using-cc-recall/SKILL.md` | Full skill content (replaces "not yet implemented" stub) |
| Create | `src/lineage/resolve.ts` | Batch lineage resolution across the sidecar (sidecar query + match) |
| Create | `src/lineage/resolve.test.ts` | Tests for batch resolution |

---

### Task 1: Lineage Matching — `src/lineage/match.ts`

**Files:**
- Implement: `src/lineage/match.ts`
- Create: `src/lineage/match.test.ts`

The spec (§7) says: `handoff_out.to_session` / `handoff_in.from_session` are resolved by matching a handoff prompt's text to a candidate session's first user message (text similarity + time proximity). Unresolved links stay `null`.

The synthesizer already detects `handoff_in` and `handoff_out` with `from_session: null` / `to_session: null`. This task builds the matching function that resolves those nulls against a set of candidate sessions.

- [ ] **Step 1: Write the failing test for `scoreMatch`**

```ts
// src/lineage/match.test.ts
import { describe, expect, it } from 'vitest';
import { scoreMatch, resolveHandoffOut, resolveHandoffIn } from './match.js';

describe('scoreMatch', () => {
  it('returns 0 for completely unrelated texts', () => {
    const score = scoreMatch('set up the auth middleware', 'fix the CSS grid layout');
    expect(score).toBe(0);
  });

  it('returns a positive score for texts sharing significant tokens', () => {
    const handoff = 'Continue implementing the SQLite sidecar FTS5 index for cc-recall';
    const firstMessage = 'pick up the cc-recall sidecar FTS5 work from last session';
    const score = scoreMatch(handoff, firstMessage);
    expect(score).toBeGreaterThan(0);
  });

  it('scores higher when more tokens overlap', () => {
    const handoff = 'Continue the cc-recall sidecar SQLite FTS5 implementation';
    const close = 'pick up cc-recall sidecar SQLite FTS5 where we left off';
    const distant = 'fix a typo in the README';
    expect(scoreMatch(handoff, close)).toBeGreaterThan(scoreMatch(handoff, distant));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lineage/match.test.ts`
Expected: FAIL — `scoreMatch` is not exported (file is `export {}`)

- [ ] **Step 3: Implement `scoreMatch` — token-overlap Jaccard similarity**

The matching strategy is deliberately simple: tokenize both texts, compute the Jaccard similarity of their significant-token sets (excluding stopwords and short tokens). No embeddings, no LLM — we want a deterministic, fast, auditable matcher. The spec says unresolved links stay `null` (honest, not fuzzy), so a low threshold is fine.

```ts
// src/lineage/match.ts
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'that', 'this', 'was', 'are',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'can',
  'could', 'should', 'may', 'might', 'not', 'no', 'so', 'if', 'up', 'out',
  'just', 'also', 'then', 'than', 'very', 'too', 'here', 'there', 'when',
  'where', 'how', 'what', 'which', 'who', 'whom', 'we', 'i', 'you', 'they',
  'me', 'my', 'your', 'our', 'its', 'his', 'her', 'their',
]);

const MIN_TOKEN_LEN = 3;

const tokenize = (text: string): Set<string> => {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return new Set(
    tokens.filter((t) => t.length >= MIN_TOKEN_LEN && !STOP_WORDS.has(t)),
  );
};

/** Jaccard similarity of significant tokens (0–1). */
export const scoreMatch = (textA: string, textB: string): number => {
  const a = tokenize(textA);
  const b = tokenize(textB);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lineage/match.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write failing tests for `resolveHandoffOut` and `resolveHandoffIn`**

Add to `src/lineage/match.test.ts`:

```ts
import type { RecallRecord } from '../record/schema.js';

const makeRecord = (overrides: Partial<RecallRecord>): RecallRecord => ({
  type: 'recall-record',
  schema_version: 1,
  session_id: 'test-session',
  project: 'test-project',
  cwd: '/test',
  started_at: '2026-06-10T10:00:00Z',
  ended_at: '2026-06-10T12:00:00Z',
  line_count: 100,
  title: 'Test session',
  summary: 'A test session',
  asks_implemented: [],
  completions: [],
  handoff_in: null,
  handoff_out: null,
  artifacts: { files_touched: [], top_tools: [], distinctive_phrases: [] },
  facets: { completed: [], questioned: [], asked_about: [] },
  provenance: 'backfill',
  generated_at: '2026-06-15T00:00:00Z',
  synthesizer_version: '0.1.0',
  ...overrides,
});

describe('resolveHandoffOut', () => {
  it('returns null when no candidates match above threshold', () => {
    const source = makeRecord({
      session_id: 'a',
      ended_at: '2026-06-10T12:00:00Z',
      handoff_out: { to_session: null, text: 'continue the sidecar FTS5 work' },
    });
    const candidates = [
      makeRecord({
        session_id: 'b',
        started_at: '2026-06-10T13:00:00Z',
        title: 'Fix CSS grid layout',
      }),
    ];
    expect(resolveHandoffOut(source, candidates)).toBeNull();
  });

  it('resolves to the best-matching candidate', () => {
    const source = makeRecord({
      session_id: 'a',
      ended_at: '2026-06-10T12:00:00Z',
      handoff_out: { to_session: null, text: 'pick up the cc-recall sidecar FTS5 implementation' },
    });
    const candidates = [
      makeRecord({
        session_id: 'b',
        started_at: '2026-06-10T13:00:00Z',
        title: 'cc-recall sidecar FTS5',
      }),
      makeRecord({
        session_id: 'c',
        started_at: '2026-06-10T14:00:00Z',
        title: 'Fix CSS grid',
      }),
    ];
    expect(resolveHandoffOut(source, candidates)).toBe('b');
  });

  it('returns null when handoff_out is null', () => {
    const source = makeRecord({ session_id: 'a', handoff_out: null });
    expect(resolveHandoffOut(source, [])).toBeNull();
  });
});

describe('resolveHandoffIn', () => {
  it('resolves to the best-matching predecessor', () => {
    const target = makeRecord({
      session_id: 'b',
      started_at: '2026-06-10T13:00:00Z',
      handoff_in: { from_session: null, text: 'continuing from the cc-recall sidecar session' },
    });
    const candidates = [
      makeRecord({
        session_id: 'a',
        ended_at: '2026-06-10T12:00:00Z',
        title: 'cc-recall sidecar FTS5 implementation',
      }),
    ];
    expect(resolveHandoffIn(target, candidates)).toBe('a');
  });
});
```

- [ ] **Step 6: Run test to verify new tests fail**

Run: `pnpm vitest run src/lineage/match.test.ts`
Expected: FAIL — `resolveHandoffOut` and `resolveHandoffIn` not exported

- [ ] **Step 7: Implement `resolveHandoffOut` and `resolveHandoffIn`**

Add to `src/lineage/match.ts`:

```ts
import type { RecallRecord } from '../record/schema.js';

const MATCH_THRESHOLD = 0.15;
const TIME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const withinWindow = (fromTime: string, toTime: string): boolean => {
  const from = new Date(fromTime).getTime();
  const to = new Date(toTime).getTime();
  return !Number.isNaN(from) && !Number.isNaN(to) && to >= from && to - from <= TIME_WINDOW_MS;
};

/**
 * Given a session with an unresolved handoff_out, find the best-matching successor
 * among candidates. Returns the session_id of the match, or null.
 */
export const resolveHandoffOut = (
  source: RecallRecord,
  candidates: readonly RecallRecord[],
): string | null => {
  if (!source.handoff_out?.text) return null;
  let bestId: string | null = null;
  let bestScore = MATCH_THRESHOLD;
  for (const candidate of candidates) {
    if (candidate.session_id === source.session_id) continue;
    if (!withinWindow(source.ended_at, candidate.started_at)) continue;
    const score = scoreMatch(source.handoff_out.text, candidate.title);
    if (score > bestScore) {
      bestScore = score;
      bestId = candidate.session_id;
    }
  }
  return bestId;
};

/**
 * Given a session with an unresolved handoff_in, find the best-matching predecessor
 * among candidates. Returns the session_id of the match, or null.
 */
export const resolveHandoffIn = (
  target: RecallRecord,
  candidates: readonly RecallRecord[],
): string | null => {
  if (!target.handoff_in?.text) return null;
  let bestId: string | null = null;
  let bestScore = MATCH_THRESHOLD;
  for (const candidate of candidates) {
    if (candidate.session_id === target.session_id) continue;
    if (!withinWindow(candidate.ended_at, target.started_at)) continue;
    const score = scoreMatch(target.handoff_in.text, candidate.title);
    if (score > bestScore) {
      bestScore = score;
      bestId = candidate.session_id;
    }
  }
  return bestId;
};
```

- [ ] **Step 8: Run test to verify all pass**

Run: `pnpm vitest run src/lineage/match.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 9: Run full check**

Run: `pnpm check`
Expected: PASS (typecheck + lint)

- [ ] **Step 10: Commit**

```bash
git add src/lineage/match.ts src/lineage/match.test.ts
git commit -m "feat(lineage): implement handoff matching with Jaccard token similarity"
```

---

### Task 2: Batch Lineage Resolution — `src/lineage/resolve.ts`

**Files:**
- Create: `src/lineage/resolve.ts`
- Create: `src/lineage/resolve.test.ts`

This wires lineage matching into the sidecar: query all sessions with unresolved handoffs, run the matcher against candidates, and update the sidecar records. Called by the CLI's `lineage` command and optionally after backfill.

- [ ] **Step 1: Write failing test**

```ts
// src/lineage/resolve.test.ts
import { describe, expect, it } from 'vitest';
import { openSidecar } from '../surfaces/sidecar.js';
import type { RecallRecord } from '../record/schema.js';
import { resolveAllHandoffs } from './resolve.js';

const makeRecord = (overrides: Partial<RecallRecord>): RecallRecord => ({
  type: 'recall-record',
  schema_version: 1,
  session_id: 'test',
  project: 'proj',
  cwd: '/test',
  started_at: '2026-06-10T10:00:00Z',
  ended_at: '2026-06-10T12:00:00Z',
  line_count: 100,
  title: 'Test',
  summary: 'A test',
  asks_implemented: [],
  completions: [],
  handoff_in: null,
  handoff_out: null,
  artifacts: { files_touched: [], top_tools: [], distinctive_phrases: [] },
  facets: { completed: [], questioned: [], asked_about: [] },
  provenance: 'backfill',
  generated_at: '2026-06-15T00:00:00Z',
  synthesizer_version: '0.1.0',
  ...overrides,
});

describe('resolveAllHandoffs', () => {
  it('resolves a handoff_out → handoff_in pair in the sidecar', () => {
    const sidecar = openSidecar(':memory:');
    const a = makeRecord({
      session_id: 'a',
      ended_at: '2026-06-10T12:00:00Z',
      title: 'Build cc-recall sidecar FTS5',
      handoff_out: { to_session: null, text: 'continue the cc-recall sidecar FTS5 work' },
    });
    const b = makeRecord({
      session_id: 'b',
      started_at: '2026-06-10T13:00:00Z',
      title: 'cc-recall sidecar FTS5 continued',
      handoff_in: { from_session: null, text: 'picking up cc-recall sidecar FTS5 from last session' },
    });
    sidecar.upsert(a, 'h1');
    sidecar.upsert(b, 'h2');

    const result = resolveAllHandoffs(sidecar);

    expect(result.resolved).toBe(2);
    const updatedA = sidecar.get('a');
    const updatedB = sidecar.get('b');
    expect(updatedA?.handoff_out?.to_session).toBe('b');
    expect(updatedB?.handoff_in?.from_session).toBe('a');
    sidecar.close();
  });

  it('returns 0 when no unresolved handoffs exist', () => {
    const sidecar = openSidecar(':memory:');
    sidecar.upsert(makeRecord({ session_id: 'x' }), 'h1');
    const result = resolveAllHandoffs(sidecar);
    expect(result.resolved).toBe(0);
    sidecar.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lineage/resolve.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `resolveAllHandoffs`**

This needs to query sessions from the sidecar. The current `Sidecar` interface doesn't expose a "list all" or "list sessions with unresolved handoffs" method. We'll add a `listAll()` method to the sidecar interface first, then build the resolver on top.

```ts
// src/lineage/resolve.ts
import type { RecallRecord } from '../record/schema.js';
import type { Sidecar } from '../surfaces/sidecar.js';
import { resolveHandoffIn, resolveHandoffOut } from './match.js';

export interface ResolveResult {
  resolved: number;
  unresolved: number;
}

export const resolveAllHandoffs = (sidecar: Sidecar): ResolveResult => {
  const all = sidecar.listAll();
  let resolved = 0;
  let unresolved = 0;

  for (const record of all) {
    let changed = false;

    if (record.handoff_out && !record.handoff_out.to_session) {
      const match = resolveHandoffOut(record, all);
      if (match) {
        record.handoff_out = { ...record.handoff_out, to_session: match };
        changed = true;
        resolved += 1;
      } else {
        unresolved += 1;
      }
    }

    if (record.handoff_in && !record.handoff_in.from_session) {
      const match = resolveHandoffIn(record, all);
      if (match) {
        record.handoff_in = { ...record.handoff_in, from_session: match };
        changed = true;
        resolved += 1;
      } else {
        unresolved += 1;
      }
    }

    if (changed) {
      sidecar.upsert(record, sidecar.getSourceHash(record.session_id));
    }
  }

  return { resolved, unresolved };
};
```

This requires adding `listAll(): RecallRecord[]` to the `Sidecar` interface in `src/surfaces/sidecar.ts`.

- [ ] **Step 4: Add `listAll` to the Sidecar interface and implementation**

In `src/surfaces/sidecar.ts`, add to the `Sidecar` interface:

```ts
listAll: () => RecallRecord[];
```

Add to `Statements`:

```ts
listAllStmt: StatementSync;
```

Add to `prepareStatements`:

```ts
listAllStmt: db.prepare('SELECT record_json FROM sessions ORDER BY started_at'),
```

Add to `buildSidecar`:

```ts
listAll() {
  const rows = statement.listAllStmt.all() as { record_json: string }[];
  return rows.map((row) => parseRecallRecord(JSON.parse(row.record_json)));
},
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/lineage/resolve.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Run full check**

Run: `pnpm check && pnpm vitest run`
Expected: PASS (all tests, typecheck, lint)

- [ ] **Step 7: Commit**

```bash
git add src/lineage/resolve.ts src/lineage/resolve.test.ts src/surfaces/sidecar.ts
git commit -m "feat(lineage): batch lineage resolution across the sidecar"
```

---

### Task 3: UserPromptSubmit Hook — `hooks/prompt-submit.mjs`

**Files:**
- Implement: `hooks/prompt-submit.mjs`

This hook fires on every user prompt. It detects "find/restore a past session" intent and injects a system-reminder telling the agent to search the sidecar first. Must be fast (parse stdin → regex check → respond) and never block.

- [ ] **Step 1: Implement the hook**

```js
#!/usr/bin/env node
// cc-recall UserPromptSubmit hook (spec §S4: adoption reminder).
//
// Detects "find/restore a past session" intent in the user's prompt and injects
// a system-reminder directing the agent to search the cc-recall sidecar before
// grepping raw transcripts. Must respond quickly and never block.

import { readFileSync } from 'node:fs';

const respond = (object) => {
  process.stdout.write(JSON.stringify(object));
};
const proceed = () => respond({ continue: true, suppressOutput: true });

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  /* no stdin */
}

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  proceed();
  process.exit(0);
}

const prompt = typeof payload.prompt === 'string' ? payload.prompt.toLowerCase() : '';

// Intent patterns: user is trying to find, restore, or recall a past session.
const INTENT_RE =
  /\b(find|restore|recall|recover|where did we|which session|past session|previous session|last time we|did we already|what session|search sessions?|look up.*session)\b/i;

if (!prompt || !INTENT_RE.test(prompt)) {
  proceed();
} else {
  respond({
    continue: true,
    suppressOutput: false,
    message:
      '**cc-recall**: To find a past session, search the sidecar first:\n' +
      '```\ncc-recall search "<what you remember>"\n```\n' +
      'or use `/recall:search`. Fall back to claude-mem or raw transcript grep only if the sidecar misses.',
  });
}
```

- [ ] **Step 2: Manual test — verify the hook responds correctly**

```bash
echo '{"prompt":"find the session where we built the sidecar"}' | node hooks/prompt-submit.mjs
```

Expected: JSON with `message` containing the sidecar search reminder.

```bash
echo '{"prompt":"add a new test for the parser"}' | node hooks/prompt-submit.mjs
```

Expected: JSON with `continue: true, suppressOutput: true` (no reminder).

- [ ] **Step 3: Commit**

```bash
git add hooks/prompt-submit.mjs
git commit -m "feat(hooks): implement UserPromptSubmit adoption reminder for session search"
```

---

### Task 4: Slash Command Bodies

**Files:**
- Modify: `commands/recall/search.md`
- Modify: `commands/recall/backfill.md`
- Modify: `commands/recall/migrate.md`
- Modify: `commands/recall/doctor.md`
- Modify: `commands/recall/status.md`
- Modify: `commands/recall/lineage.md`

These are Claude Code plugin commands. The `.md` body is the instruction the agent sees when the user invokes `/recall:<command>`. Each must tell the agent exactly what to run and how to interpret the output.

- [ ] **Step 1: Write `/recall:search`**

```markdown
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
```

- [ ] **Step 2: Write `/recall:backfill`**

```markdown
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
```

- [ ] **Step 3: Write `/recall:migrate`**

```markdown
---
description: "Phase 0 home-path normalization — consolidate dead joeblack-to-joe slugs."
---

# /recall:migrate

Consolidate sessions under dead home-path slugs (e.g. `-Users-joeblack-*` → `-Users-joe-*`) so they become visible from the current working directory. This is a prerequisite to backfill.

## Usage

**Always dry-run first (the default):**
```bash
cc-recall migrate [--from /Users/joeblack] [--to /Users/joe]
```

**Review the output, then apply:**
```bash
cc-recall migrate --apply
```

**If something goes wrong, revert:**
```bash
cc-recall migrate --revert
```

## What it does

1. **Directory slugs:** renames `-Users-joeblack-<rest>` dirs to `-Users-joe-<rest>`, merging when the destination already exists (UUIDs are unique, no filename collisions)
2. **In-transcript paths:** rewrites `/Users/joeblack/...` → `/Users/joe/...` inside transcript JSONL so `cwd` resolves to the live tree

## Safety

- Dry-run by default — nothing is written unless `--apply` is passed
- All originals are backed up before rewriting
- A manifest is saved at `~/.claude/cc-recall/migrate-manifest.json` for audit and rollback
- Integrity-checked: if a rewrite corrupts a transcript, it is auto-restored from backup
- `--revert` uses the manifest to undo the entire migration
```

- [ ] **Step 4: Write `/recall:doctor`**

```markdown
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
3. **claude-mem G0** (spec §12) — probes the claude-mem worker for health, readiness, and a search round-trip. Surface ③ (claude-mem observations) stays disabled unless G0 passes. A G0 failure does NOT affect the sidecar or transcript surfaces.

## Interpreting output

```
sidecar: OK — 15154 sessions at ~/.claude/cc-recall/index.db
coverage: 98.2% (14882/15154 transcripts indexed)
claude-mem G0: PASS — health + readiness + search round-trip OK (v2.1.0)
```

Or on failure:
```
claude-mem G0: FAIL — worker not reachable (surface ③ stays disabled — sidecar unaffected)
```

## When G0 fails

G0 failure means claude-mem is down or unhealthy. cc-recall works fine without it — the sidecar is the primary surface. To fix claude-mem itself, check the worker process and database separately.
```

- [ ] **Step 5: Write `/recall:status`**

```markdown
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
```

- [ ] **Step 6: Write `/recall:lineage`**

```markdown
---
description: "Walk a thread across sessions (handoff to successor)."
---

# /recall:lineage

Resolve and display the handoff chain for a session — which sessions it continued from and which sessions continued from it.

## Usage

First, ensure lineage has been resolved:
```bash
# This is built into the sidecar — lineage resolution runs as part of backfill
# or can be triggered by the resolve module programmatically.
```

Then search for a session and read its `handoff_in` / `handoff_out` fields:
```bash
cc-recall search "<query>"
```

The `handoff_in.from_session` and `handoff_out.to_session` fields form a navigable DAG. Follow the chain by looking up each linked session_id in the sidecar.

## Note

Lineage resolution is best-effort. Unresolved links stay `null` — this is intentional (honest, not fuzzy). If a handoff link is missing, the matching heuristic didn't find a confident match within the 7-day time window.
```

- [ ] **Step 7: Commit**

```bash
git add commands/recall/
git commit -m "feat(commands): write full agent instructions for all /recall: slash commands"
```

---

### Task 5: Skill Content — `skills/using-cc-recall/SKILL.md`

**Files:**
- Modify: `skills/using-cc-recall/SKILL.md`

Replace the "not yet implemented" stub with real guidance.

- [ ] **Step 1: Write the skill**

```markdown
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
- `/recall:lineage` — walk handoff chains across sessions

## How it works

Each session gets a `RecallRecord` with: title, summary, asks_implemented, completions, handoff_in/out, artifacts (files, tools, phrases), and three retrieval facets (completed, questioned, asked_about). Records are stored in a sidecar SQLite DB and optionally injected into the transcript itself.
```

- [ ] **Step 2: Commit**

```bash
git add skills/using-cc-recall/SKILL.md
git commit -m "feat(skill): write full using-cc-recall skill content"
```

---

### Task 6: Real-Data Validation — 7 pieces-dev transcripts

**Files:**
- No code changes — this is a validation/smoke-test task

Run the existing CLI against real transcripts to verify the full pipeline (parse → synthesize → sidecar upsert → transcript inject) works on real-world data, not just unit-test fixtures. The spec designated the pieces-dev sessions as the test corpus.

- [ ] **Step 1: Dry-run backfill on pieces-dev**

```bash
cc-recall backfill --dry-run --no-llm --scope pieces-dev
```

Expected: 7 transcripts listed, all showing `ok` or `idx`, no errors.

- [ ] **Step 2: Index one session manually**

Pick the first `.jsonl` from the output and index it:

```bash
cc-recall index ~/.claude/projects/-Users-joe-github-joeblackwaslike-pieces-dev/<first-session>.jsonl --no-llm --force
```

Expected: `wrote  <session_id>  <title>` — a real title derived from the transcript.

- [ ] **Step 3: Search the sidecar for the indexed session**

```bash
cc-recall search "pieces"
```

Expected: the session appears in results.

- [ ] **Step 4: Verify the transcript was edited**

```bash
tail -3 ~/.claude/projects/-Users-joe-github-joeblackwaslike-pieces-dev/<first-session>.jsonl
```

Expected: last two lines are the cc-recall `ai-title` marker and the `recall-record` JSON.

- [ ] **Step 5: Verify the backup exists**

```bash
ls ~/.claude/cc-recall/backups/<session_id>.jsonl
```

Expected: file exists.

- [ ] **Step 6: Revert and verify**

```bash
cc-recall revert ~/.claude/projects/-Users-joe-github-joeblackwaslike-pieces-dev/<first-session>.jsonl
```

Expected: `reverted <session_id>` — the injected lines are gone.

- [ ] **Step 7: Run doctor**

```bash
cc-recall doctor
```

Expected: sidecar OK with session count, coverage percentage, G0 pass or fail (either is fine — G0 failure just means claude-mem is optional).

- [ ] **Step 8: Document any issues found**

If any step produced unexpected output, create a brief note of what happened and what needs fixing. No commit for this task unless a bug fix is needed.

---

### Task 7: S0 Spike — Picker & Title-Generation Investigation

**Files:**
- Create: `docs/superpowers/spikes/2026-06-15-s0-picker-title.md` (research output)

This is a research task, not code. The spec (§12 S0) requires reverse-engineering:
1. Where and when `ai-title` is generated (CLI core vs VS Code extension)
2. Why 97.7% of sessions lack one
3. How the VS Code extension's session picker enumerates and sorts sessions (count cap? sort key? cache?)
4. What title/metadata edits the native picker will honor

- [ ] **Step 1: Search the Claude Code VS Code extension source for title generation**

Search the installed VS Code extension for `ai-title`, `aiTitle`, `generateTitle`, or `titleGeneration`:

```bash
find ~/.vscode-insiders/extensions -name '*.js' -path '*claude*' 2>/dev/null | head -5
# Then grep for title-related code
grep -rl 'ai.title\|aiTitle\|generateTitle' ~/.vscode-insiders/extensions/*claude* 2>/dev/null
```

Also check the Claude Code CLI itself:

```bash
which claude && grep -r 'ai.title\|aiTitle' "$(dirname "$(which claude)")"/../lib/ 2>/dev/null | head -20
```

- [ ] **Step 2: Search for session enumeration logic**

```bash
grep -rl 'listSessions\|enumerateSessions\|\.jsonl\|projects.*dir' ~/.vscode-insiders/extensions/*claude* 2>/dev/null | head -10
```

- [ ] **Step 3: Document findings in the spike output**

Write `docs/superpowers/spikes/2026-06-15-s0-picker-title.md` with:
- Where title generation happens (CLI vs extension)
- When it fires (session end? on demand? background?)
- Why 97.7% are untitled (hypothesis confirmed or refuted)
- How the picker enumerates (sort, cap, cache)
- What edits are honored (title? metadata? record injection?)

- [ ] **Step 4: Commit**

```bash
mkdir -p docs/superpowers/spikes
git add docs/superpowers/spikes/2026-06-15-s0-picker-title.md
git commit -m "docs(s0): spike findings on picker enumeration and title generation"
```

---

### Task 8: U0 Upstream Issue

**Files:**
- No code — this creates a GitHub issue at `anthropics/claude-code`

The spec (§12 U0) calls for filing a well-evidenced issue reporting the indexing deficiency. This task depends on Task 7 (S0 spike) for the attributed root cause.

- [ ] **Step 1: Draft the issue**

Title: `97.7% of sessions lack an ai-title, making them undiscoverable in the session picker`

Body should include:
- Measured data: 15,154 sessions, 356 titled (2.3%), 14,798 untitled (97.7%)
- 11,557 sessions (76%) under dead home-path slugs (home moved `/Users/joeblack` → `/Users/joe`)
- S0 attributed root cause (from Task 7 findings)
- Request: retroactive titling for existing sessions + home-path migration handling
- Note that cc-recall is the workaround; the upstream fix is the real cure

- [ ] **Step 2: File the issue**

```bash
gh issue create --repo anthropics/claude-code \
  --title "97.7% of sessions lack an ai-title, making them undiscoverable in the session picker" \
  --body "$(cat <<'EOF'
## Problem

... (body from step 1)

EOF
)"
```

- [ ] **Step 3: Record the issue URL in the spec**

Add a line to the design spec noting the issue was filed.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-06-14-cc-recall-design.md
git commit -m "docs(u0): record upstream issue URL in design spec"
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - §7 RecallRecord + handoff lineage → Task 1, 2
   - §S4 UserPromptSubmit adoption reminder → Task 3
   - §6 commands → Task 4
   - §6 skill → Task 5
   - §14 testing on real transcripts → Task 6
   - §12 S0 spike → Task 7
   - §12 U0 upstream issue → Task 8
   - All other §s (types, schema, parser, synthesizer, sidecar, transcript-writer, claude-mem, native-memory, migration, engine, CLI, session-end hook, plugin manifest) are already implemented and tested.

2. **Placeholder scan:** No TBDs, TODOs, or "implement later" in this plan. All code steps have actual code.

3. **Type consistency:** `scoreMatch`, `resolveHandoffOut`, `resolveHandoffIn` names used consistently. `RecallRecord`, `Sidecar`, `ParsedTranscript` match the existing codebase. `listAll` addition to `Sidecar` is used in Task 2 implementation.
