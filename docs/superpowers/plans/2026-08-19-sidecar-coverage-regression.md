# Sidecar Coverage Regression Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two independent correctness bugs behind cc-recall-xkf's sidecar coverage regression
(transcript-write retries silently starved after a skip; garbage `project='-'` sessions getting
indexed at all), then run a fresh backfill to recover real coverage.

**Architecture:** Both fixes live in `src/engine.ts` and `src/surfaces/sidecar.ts`, the two files
`indexSession`/`backfill` already touch. No new files, no new surfaces — this is tightening an
existing idempotency contract (task 1) and adding one more skip condition next to the existing
`isIndexerRun` skip (task 2).

**Tech Stack:** TypeScript strict, ESM, Vitest, node:sqlite (`DatabaseSync`).

---

## Context (read before starting)

`bd show cc-recall-xkf` has the full incident writeup. Summary of what's being fixed:

1. **cc-recall-m32** — `engine.ts:243-244` calls `sidecar.upsert(record, sourceHash)`
   *before* `writeToTranscript(...)` runs. If the transcript write is then skipped
   (`skipReason: 'stale-source'` or `'active-session'`), the sidecar's `source_hash` already
   matches the new hash. The retry guard at `engine.ts:228`
   (`sidecar.getSourceHash(id) === sourceHash`) then treats the session as fully up to date on
   the next pass and never retries the transcript write — the sidecar and transcript surfaces
   silently diverge forever for that session.
2. **Degenerate `project='-'`** — a session whose Claude-Code-assigned `cwd` was degenerate (e.g.
   the literal root `/`) lands in a project directory literally named `-`
   (`~/.claude/projects/-/`). `projectFromPath()` (`engine.ts:38`) derives the sidecar's
   `project` column straight from that directory name with no validation, so these get indexed
   as real sessions under `project = '-'`. On 2026-08-15 ~44K such rows were manually purged
   directly against production `index.db` (undocumented, outside cc-recall's own tooling) — but
   the code path that produces them is still live: 13 such rows exist right now, and
   `~/.claude/projects/-/` has already been recreated since the purge.

These two bugs are independent — neither depends on the other's fix — but both live in
`indexSession`, so they're done as one PR to avoid two rounds of touching the same function.

---

### Task 1: Fix cc-recall-m32 — pending transcript-sync flag

**Files:**
- Modify: `src/surfaces/sidecar.ts:21-64` (schema + upsert SQL), `src/surfaces/sidecar.ts:77-98`
  (`Sidecar` interface), `src/surfaces/sidecar.ts:141-260` (statements + `buildSidecar`)
- Modify: `src/engine.ts:140-166` (`writeToTranscript`), `src/engine.ts:199-253` (`indexSession`)
- Test: `src/surfaces/sidecar.test.ts`, `src/engine.test.ts`

- [ ] **Step 1: Write the failing sidecar test for the new column/methods**

Add to `src/surfaces/sidecar.test.ts` (after the existing `describe` block's other tests, same
file — check the end of the file for where the `describe('sidecar', ...)` block closes and add
inside it):

```typescript
it('tracks transcript-sync state independently of the source hash', () => {
  const record = recordFor('s-sync', ADD_FTS);
  sidecar.upsert(record, 'hash-1');

  // Upsert alone does not mark the transcript as synced — that only happens once the writer
  // actually confirms the write, which is what this fix decouples from the upsert itself.
  expect(sidecar.getTranscriptSyncedHash('s-sync')).toBeUndefined();

  sidecar.markTranscriptSynced('s-sync', 'hash-1');
  expect(sidecar.getTranscriptSyncedHash('s-sync')).toBe('hash-1');

  // A later upsert with a new hash must not carry the old sync stamp forward as if it were
  // still valid for the new content.
  sidecar.upsert(record, 'hash-2');
  expect(sidecar.getTranscriptSyncedHash('s-sync')).toBe('hash-1');
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm vitest run src/surfaces/sidecar.test.ts -t "tracks transcript-sync state"`
Expected: FAIL — `sidecar.getTranscriptSyncedHash is not a function`

- [ ] **Step 3: Add the column via migration, plus the statement and interface methods**

**Do not add the column to `CREATE TABLE IF NOT EXISTS`** — that statement is a no-op against
the live production `index.db`, which already has a `sessions` table without this column.
`CREATE TABLE IF NOT EXISTS` only defines the schema for a *brand-new* database; it never alters
an existing table. Adding the column there would pass every test that opens a fresh `:memory:`
database (as all current tests do) while silently throwing `no such column:
transcript_synced_hash` the first time this code runs against the real, already-existing
`~/.claude/cc-recall/index.db`. Use a separate `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
statement instead, appended to `SCHEMA_SQL` — safe to run on every `openSidecar` call for both a
fresh database (where the column doesn't exist yet, so it's added once) and an existing one
(where it's added the first time this code runs, then becomes a no-op after). Node 22's built-in
`node:sqlite` bundles a modern SQLite (`ADD COLUMN IF NOT EXISTS` has been supported since SQLite
3.35.0, 2021), so this syntax is safe to rely on without a version check.

> **Superseded during implementation:** SQLite's `ALTER TABLE ... ADD COLUMN` has no `IF NOT
> EXISTS` clause at all (that's Postgres/MySQL syntax) — running it as written below throws a
> syntax error, confirmed against the node:sqlite-bundled SQLite 3.35.0+. What actually shipped
> checks `pragma_table_info('sessions')` for the column first and only then runs a plain `ALTER
> TABLE ... ADD COLUMN` inside a `BEGIN IMMEDIATE ... COMMIT` transaction (see
> `migrateTranscriptSyncedHash` in `src/surfaces/sidecar.ts`), which is also what makes the
> migration atomic and safe against a mid-migration crash or two racing processes — the plan
> below predates that requirement. Left here for historical context rather than rewritten.

In `src/surfaces/sidecar.ts`, leave the existing `CREATE TABLE IF NOT EXISTS sessions (...)`
block in `SCHEMA_SQL` completely unchanged, and add the migration statement right after it:

```typescript
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  cwd TEXT NOT NULL,
  git_branch TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  line_count INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  provenance TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  synthesizer_version TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  source_hash TEXT,
  handoff_in_from TEXT,
  handoff_out_to TEXT,
  record_json TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  session_id UNINDEXED, title, summary, facets, phrases, files
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS transcript_synced_hash TEXT;
`;
```

Leave `UPSERT_SQL` untouched — do **not** add `transcript_synced_hash` to its column list or its
`ON CONFLICT ... DO UPDATE SET` clause. That's the point of the fix: an upsert must never touch
this column, only the new dedicated statement below does, so the flag survives across upserts
until something explicitly confirms the write.

Add a new statement to the `Statements` interface (after `selectHash: StatementSync;` at line
146):

```typescript
  selectHash: StatementSync;
  selectSyncedHash: StatementSync;
  markSynced: StatementSync;
```

Add its preparation in `prepareStatements` (after `selectHash: db.prepare(...)` at line 161):

```typescript
  selectHash: db.prepare('SELECT source_hash FROM sessions WHERE session_id = $session_id'),
  selectSyncedHash: db.prepare(
    'SELECT transcript_synced_hash FROM sessions WHERE session_id = $session_id',
  ),
  markSynced: db.prepare(
    'UPDATE sessions SET transcript_synced_hash = $hash WHERE session_id = $session_id',
  ),
```

Add the two methods to the `Sidecar` interface (after `getSourceHash: (sessionId: string) => string | undefined;` at line 80):

```typescript
  getSourceHash: (sessionId: string) => string | undefined;
  getTranscriptSyncedHash: (sessionId: string) => string | undefined;
  markTranscriptSynced: (sessionId: string, sourceHash: string) => void;
```

Implement both in `buildSidecar` (after the `getSourceHash(sessionId) { ... }` method body,
around line 207):

```typescript
  getSourceHash(sessionId) {
    const row = statement.selectHash.get({ $session_id: sessionId }) as
      | undefined
      | { source_hash: string | null };
    return row?.source_hash ?? undefined;
  },
  getTranscriptSyncedHash(sessionId) {
    const row = statement.selectSyncedHash.get({ $session_id: sessionId }) as
      | undefined
      | { transcript_synced_hash: string | null };
    return row?.transcript_synced_hash ?? undefined;
  },
  markTranscriptSynced(sessionId, sourceHash) {
    statement.markSynced.run({ $session_id: sessionId, $hash: sourceHash });
  },
```

- [ ] **Step 4: Run the sidecar test, confirm it passes**

Run: `pnpm vitest run src/surfaces/sidecar.test.ts -t "tracks transcript-sync state"`
Expected: PASS

- [ ] **Step 5: Write and run a migration test against a pre-existing on-disk database**

This is the test that would have caught putting the column in `CREATE TABLE IF NOT EXISTS`
instead of a real migration — every other test in this file opens a fresh `:memory:` database,
which can't distinguish "column defined in CREATE TABLE" from "column added by a real ALTER
TABLE migration." This one has to use a real file, pre-created with the *old* schema (no
`transcript_synced_hash`), then reopened with the fixed `openSidecar` to prove the migration
actually runs against existing data, not just fresh databases.

Add to `src/surfaces/sidecar.test.ts`:

```typescript
it('migrates an existing on-disk database that predates transcript_synced_hash', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'cc-recall-sidecar-migrate-'));
  const dbPath = path.join(tmp, 'index.db');
  try {
    // Simulate a pre-migration database: the old schema, no transcript_synced_hash column.
    const oldDb = new DatabaseSync(dbPath);
    oldDb.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        cwd TEXT NOT NULL,
        git_branch TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        line_count INTEGER NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        provenance TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        synthesizer_version TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        source_hash TEXT,
        handoff_in_from TEXT,
        handoff_out_to TEXT,
        record_json TEXT NOT NULL
      );
    `);
    oldDb.close();

    // Reopening with the current code must migrate it in place, not throw.
    const migrated = openSidecar(dbPath);
    const record = recordFor('s-migrate', ADD_FTS);
    migrated.upsert(record, 'hash-1');
    expect(migrated.getTranscriptSyncedHash('s-migrate')).toBeUndefined();
    migrated.markTranscriptSynced('s-migrate', 'hash-1');
    expect(migrated.getTranscriptSyncedHash('s-migrate')).toBe('hash-1');
    migrated.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

This needs two new imports at the top of `src/surfaces/sidecar.test.ts`:

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
```

Run: `pnpm vitest run src/surfaces/sidecar.test.ts -t "migrates an existing"`
Expected: FAIL first (before Step 3's fix, if run against the old code — since this step runs
after Step 3 already landed, instead confirm it PASSES now; if you're following strict red-green
per-step, temporarily comment out the `ALTER TABLE` line from Step 3 to watch this one fail with
`no such column: transcript_synced_hash`, then restore it and watch it pass).

- [ ] **Step 6: Commit**

```bash
git add src/surfaces/sidecar.ts src/surfaces/sidecar.test.ts
git commit -m "feat(sidecar): add transcript_synced_hash, decoupled from upsert"
```

- [ ] **Step 7: Write the failing engine test proving the retry actually happens**

Add to `src/engine.test.ts`, inside the existing `describe('engine', ...)` block, after the
`'warns when the transcript grows past the content...'` test:

```typescript
  it('retries the transcript write on the next pass after a stale-source skip (cc-recall-m32)', async () => {
    // First pass: the injected llm runner appends mid-synthesis, so the writer declines with
    // skipReason 'stale-source' — same setup as the warning test above.
    const first = await indexSession(file, sidecar, {
      baseDir,
      llm: () => appendMidSynthesis(file),
    });
    expect(first.written).toBe(false);
    // Sidecar is already stamped with the new content's hash even though the transcript wasn't
    // written — that's the divergence m32 describes.
    const afterFirst = readFileSync(file, 'utf8');
    expect(afterFirst).not.toContain(RECALL_RECORD_TYPE);

    // Second pass: transcript content hasn't changed since the append (no further mid-synthesis
    // append this time), so a purely source-hash-based guard would treat this as already-current
    // and skip it forever. The fix must retry anyway, because the transcript was never written.
    const second = await indexSession(file, sidecar, { llm: false, baseDir });
    expect(second.skipped).toBe(false);
    expect(second.written).toBe(true);
    const afterSecond = readFileSync(file, 'utf8');
    expect(afterSecond).toContain(RECALL_RECORD_TYPE);
  });
```

- [ ] **Step 8: Run it, confirm it fails**

Run: `pnpm vitest run src/engine.test.ts -t "retries the transcript write"`
Expected: FAIL — `second.skipped` is `true` (the pre-fix behavior: silently skipped forever)

- [ ] **Step 9: Wire the sync stamp into `indexSession` and gate the retry check**

In `src/engine.ts`, change the retry guard at line 228:

```typescript
  } else if (
    !options.force &&
    sidecar.getSourceHash(parsed.sessionId) === sourceHash &&
    sidecar.getTranscriptSyncedHash(parsed.sessionId) === sourceHash
  ) {
    return { sessionId: parsed.sessionId, title: '(unchanged)', written: false, skipped: true };
  }
```

Then in `indexSession`, after the `writeToTranscript` call (line 244), mark the sync only when
the write actually reflects this hash — `written: true` or the writer's own `'unchanged'`
skip both mean the transcript already carries this content; `'stale-source'`/`'active-session'`
do not:

```typescript
  sidecar.upsert(record, sourceHash);
  const write = writeToTranscript(filePath, record, sourceHash, options);
  if (write.written || write.skipReason === 'unchanged') {
    sidecar.markTranscriptSynced(parsed.sessionId, sourceHash);
  }
  await writeToClaudeMem(record, options);
```

- [ ] **Step 10: Run the engine test, confirm it passes**

Run: `pnpm vitest run src/engine.test.ts -t "retries the transcript write"`
Expected: PASS

- [ ] **Step 11: Run the full test suite to check for regressions**

Run: `pnpm vitest run`
Expected: all tests pass, including the pre-existing `'skips an unchanged session on re-index'`
and `'backfill is idempotent across runs'` tests (both exercise the ordinary
write-succeeds-first-time path, which now also gets `markTranscriptSynced` called — confirm
they still pass unchanged, since a successful first write should behave identically to before).

- [ ] **Step 12: Commit**

```bash
git add src/engine.ts src/engine.test.ts
git commit -m "fix(engine): retry transcript write after a stale-source/active-session skip

sidecar.upsert previously stamped source_hash before the transcript write's
outcome was known, so a skipped write starved forever: the next pass saw a
matching source_hash and treated the session as already current. Add a
transcript_synced_hash column, set only when the write actually landed, and
gate the retry check on both hashes matching. (cc-recall-m32)"
```

---

### Task 2: Reject degenerate `project='-'` sessions

**Files:**
- Modify: `src/engine.ts:250-280` (`listTranscripts`), `src/engine.ts:199-231` (`indexSession`)
- Test: `src/engine.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/engine.test.ts`, inside `describe('engine', ...)`, after the m32 retry test added in
Task 1:

```typescript
  it('skips a session whose project directory is the degenerate slug "-" (cc-recall-xkf)', async () => {
    const garbageDir = path.join(root, '-');
    mkdirSync(garbageDir, { recursive: true });
    const garbageFile = path.join(garbageDir, 'ghost.jsonl');
    writeFileSync(
      garbageFile,
      `${JSON.stringify({
        type: 'user',
        sessionId: 'ghost',
        cwd: '/',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'garbage' }] },
      })}\n`,
    );
    const past = new Date(Date.now() - ONE_HOUR_MS);
    utimesSync(garbageFile, past, past);

    const result = await indexSession(garbageFile, sidecar, { llm: false, baseDir });
    expect(result.skipped).toBe(true);
    expect(result.written).toBe(false);
    expect(sidecar.get('ghost')).toBeUndefined();
  });

  it('excludes the degenerate "-" project directory from backfill enumeration', async () => {
    const garbageDir = path.join(root, '-');
    mkdirSync(garbageDir, { recursive: true });
    writeFileSync(
      path.join(garbageDir, 'ghost2.jsonl'),
      `${JSON.stringify({
        type: 'user',
        sessionId: 'ghost2',
        cwd: '/',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'garbage' }] },
      })}\n`,
    );

    const summary = await backfill(sidecar, { projectsRoot: root, baseDir, llm: false });
    // Only the real fixture session from beforeEach should be counted — the garbage dir must
    // never be enumerated at all, not merely skipped after being read.
    expect(summary.total).toBe(1);
  });
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm vitest run src/engine.test.ts -t "degenerate"`
Expected: FAIL — both tests fail; the session gets indexed and the dir gets enumerated.

- [ ] **Step 3: Add the guard**

In `src/engine.ts`, add a helper near `isIndexerRun` (after its closing brace, before
`export const indexSession`, around line 198):

```typescript
/**
 * Claude Code encodes a degenerate cwd (e.g. the literal root `/`) into the literal project
 * directory name `-` — never a real project, since every real cwd is an absolute path with at
 * least one more path segment than that. ~44K such rows were manually purged from production
 * on 2026-08-15 (cc-recall-xkf); this stops new ones from being indexed at all rather than
 * relying on another manual cleanup.
 */
const isGarbageProjectDir = (project: string): boolean => project === '-';
```

In `indexSession`, add the check right after `const project = projectFromPath(filePath);` (line
206), before the `isIndexerRun` check:

```typescript
  const project = projectFromPath(filePath);

  if (isGarbageProjectDir(project)) {
    options.onWarn?.(`skipping session in the degenerate project dir "-": ${filePath}`);
    return { sessionId: parsed.sessionId, title: '(invalid project)', written: false, skipped: true };
  }

  if (isIndexerRun(project, parsed.firstUserPromptRaw, parsed.sessionId)) {
```

In `listTranscripts`, add the same exclusion next to the existing `INDEXER_PROJECT_DIR` check
(line 275):

```typescript
  for (const dir of directories) {
    if (dir === INDEXER_PROJECT_DIR) continue;
    if (isGarbageProjectDir(dir)) continue;
    if (scope && !dir.includes(scope)) continue;
    files.push(...transcriptsInDir(path.join(projectsRoot, dir)));
  }
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `pnpm vitest run src/engine.test.ts -t "degenerate"`
Expected: PASS (both tests)

- [ ] **Step 5: Run the full test suite**

Run: `pnpm vitest run`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine.ts src/engine.test.ts
git commit -m "fix(engine): never index sessions under the degenerate '-' project dir

Claude Code encodes a degenerate cwd (e.g. '/') into the literal directory
name '-'. These aren't real sessions; ~44K of them were manually purged
from production on 2026-08-15 with no code fix behind it, so the same
bug kept producing new ones (13 live as of 2026-08-18). Skip them at both
enumeration (listTranscripts) and index time (indexSession), so forward
capture is covered too, not just backfill. (cc-recall-xkf)"
```

---

### Task 3: Lint, typecheck, full verification

**Files:** none (verification only)

- [ ] **Step 1: Run lint**

Run: `pnpm lint`
Expected: clean (biome + eslint, zero warnings)

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: clean

- [ ] **Step 3: Run the full test suite one more time**

Run: `pnpm vitest run`
Expected: all tests pass

- [ ] **Step 4: Commit if lint/format made any changes**

```bash
git add -A
git diff --cached --stat  # confirm only expected files, if anything
git commit -m "chore: lint fixes" --allow-empty-message -m "" 2>/dev/null || true
```

(Skip this commit entirely if step 1-2 made no changes — don't create an empty commit.)

---

## Post-plan: PR and merge

This repo merges real code changes via PR (confirmed via `git log` — recent commits like
`fix(release): restore biome-compliant formatting in package.json (#78)` and
`feat(doctor): deployment self-verification ... (#77)` carry PR numbers; only docs-only/beads-sync
commits go direct-to-main). After all tasks above are committed on `fix/sidecar-coverage-regression`:

```bash
git push -u origin fix/sidecar-coverage-regression
gh pr create --title "fix(engine): sidecar coverage regression — m32 retry starvation + garbage project dirs" --body "$(cat <<'EOF'
## Summary
- Fixes cc-recall-m32: a skipped transcript write (stale-source/active-session) previously
  starved retries forever because the sidecar's source_hash was stamped before the write's
  outcome was known. Adds a transcript_synced_hash column, set only on a confirmed write, and
  gates the retry check on both hashes matching.
- Fixes the root cause behind cc-recall-xkf's coverage regression: sessions under the
  degenerate `project='-'` directory (Claude Code's encoding of a degenerate cwd like `/`) were
  being indexed as real sessions. ~44K such rows were manually purged from production on
  2026-08-15 with no code fix behind it; 13 were live again by 2026-08-18. Now excluded at both
  backfill enumeration and index time.

## Test plan
- [x] New sidecar test: transcript-sync state is independent of source_hash and survives re-upserts correctly
- [x] New engine test: a stale-source-skipped write actually retries on the next pass
- [x] New engine tests: a `project='-'` session is neither indexed nor enumerated by backfill
- [x] Full `pnpm vitest run`, `pnpm lint`, `pnpm typecheck` all clean
- [ ] After merge: run `cc-recall backfill` against the live sidecar and confirm `cc-recall doctor` coverage % recovers (real historical rows deleted on 2026-08-15 aren't recoverable — this re-indexes the underlying transcripts that are still on disk, now without hitting either bug)
EOF
)"
```

Drive to merge per this repo's standing PR & Merge Autonomy convention (both `anthropicreviewbot`
and `codexreviewbot` required; if either errors out on credits, launch `ai-review watch --pr <n> &`
rather than waiting).

**After merge, run the backfill recovery step** (not part of the PR — an operational step against
the live sidecar):

```bash
cc-recall backfill
cc-recall doctor  # confirm coverage % recovered from 70.2%
```
