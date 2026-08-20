import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecallRecord } from '../record/schema.js';
import { synthesizeHeuristic } from '../record/synthesizer.js';
import { parseTranscriptText } from '../transcript/parse.js';
import { type Sidecar, openSidecar } from './sidecar.js';

const ADD_FTS = 'add FTS search to the sidecar';
const S_MIDFLIGHT = 's-midflight';

const recordFor = (sessionId: string, text: string): RecallRecord => {
  const line = JSON.stringify({
    type: 'user',
    sessionId,
    cwd: '/x',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
  const parsed = parseTranscriptText(line, `/x/${sessionId}.jsonl`);
  return synthesizeHeuristic({ parsed, project: 'proj', provenance: 'backfill' });
};

/** The `sessions` schema as it existed before `transcript_synced_hash` was added. */
const PRE_MIGRATION_SCHEMA_SQL = `
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
`;

/**
 * Write a single row directly against the pre-migration schema (no `transcript_synced_hash`
 * column at all), simulating a row that predates the migration entirely.
 */
const insertPreMigrationRow = (dbPath: string, record: RecallRecord, sourceHash: string): void => {
  const oldDb = new DatabaseSync(dbPath);
  oldDb.exec(PRE_MIGRATION_SCHEMA_SQL);
  oldDb
    .prepare(
      `INSERT INTO sessions (
        session_id, project, cwd, started_at, ended_at, line_count, title, summary,
        provenance, schema_version, synthesizer_version, generated_at, source_hash, record_json
      ) VALUES (
        $session_id, $project, $cwd, $started_at, $ended_at, $line_count, $title, $summary,
        $provenance, $schema_version, $synthesizer_version, $generated_at, $source_hash, $record_json
      )`,
    )
    .run({
      $session_id: record.session_id,
      $project: record.project,
      $cwd: record.cwd,
      $started_at: record.started_at,
      $ended_at: record.ended_at,
      $line_count: record.line_count,
      $title: record.title,
      $summary: record.summary,
      $provenance: record.provenance,
      $schema_version: record.schema_version,
      $synthesizer_version: record.synthesizer_version,
      $generated_at: record.generated_at,
      $source_hash: sourceHash,
      $record_json: JSON.stringify(record),
    });
  oldDb.close();
};

/**
 * cc-recall-m32's fix (transcript_synced_hash) is only correct if pre-existing rows read as
 * already-synced, not as a retry-gate miss. Without a backfill, `getTranscriptSyncedHash` is NULL
 * for every row that predates the column, and the retry gate in engine.ts
 * (`getTranscriptSyncedHash(id) === sourceHash`) is always false for NULL — so the entire
 * pre-existing corpus (tens of thousands of sessions) would fail the unchanged-skip and get fully
 * re-synthesized, LLM calls included, on the very next backfill/repair pass.
 */
const expectPreexistingRowIsBackfilled = (): void => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'cc-recall-sidecar-backfill-'));
  const dbPath = path.join(tmp, 'index.db');
  try {
    const record = recordFor('s-preexisting', ADD_FTS);
    // Simulate a pre-migration database with a row already in it, written entirely under the old
    // schema — no transcript_synced_hash column exists at all yet.
    insertPreMigrationRow(dbPath, record, 'preexisting-hash');

    // Reopening with the current code must migrate AND backfill the pre-existing row in place,
    // treating it as already-synced rather than forcing it through resynthesis.
    const migrated = openSidecar(dbPath);
    expect(migrated.getTranscriptSyncedHash('s-preexisting')).toBe('preexisting-hash');
    migrated.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

/**
 * The backfill above must not become an unconditional "mark everything synced" that runs on every
 * openSidecar call — that would defeat cc-recall-m32's own retry-gate fix for brand-new sessions
 * caught mid-flight (upserted but not yet transcript-synced). Once the column already exists,
 * reopening the sidecar must take the fast "already migrated" path and leave a not-yet-synced row
 * alone.
 */
const expectMidflightRowSurvivesReopen = (): void => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'cc-recall-sidecar-no-rebackfill-'));
  const dbPath = path.join(tmp, 'index.db');
  try {
    const record = recordFor(S_MIDFLIGHT, ADD_FTS);

    // First open: column gets added (table is empty, so the backfill UPDATE is a no-op), then
    // upsert without ever calling markTranscriptSynced — the same state a stale-source or
    // active-session skip leaves behind.
    const first = openSidecar(dbPath);
    first.upsert(record, 'hash-1');
    expect(first.getTranscriptSyncedHash(S_MIDFLIGHT)).toBeUndefined();
    first.close();

    // Reopen: transcript_synced_hash already exists, so this must take the early-return path and
    // must not re-run the backfill against the row left mid-flight above.
    const second = openSidecar(dbPath);
    expect(second.getTranscriptSyncedHash(S_MIDFLIGHT)).toBeUndefined();
    expect(second.getSourceHash(S_MIDFLIGHT)).toBe('hash-1');
    second.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

/** Runs `open-sidecar-worker.mjs` as a real child process via the project's `tsx` loader (already
 * a devDependency) so it can import `sidecar.ts` directly, without a build step. */
const runOpenSidecarWorker = (
  workerPath: string,
  dbPath: string,
): Promise<{ code: number | null; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', workerPath, dbPath], {
      cwd: path.resolve(import.meta.dirname, '..', '..'),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      resolve({ code, stderr });
    });
  });

/**
 * `migrateTranscriptSyncedHash`'s busy-retry-then-rollback handling exists specifically for two
 * real OS processes racing to migrate the same pre-migration `index.db` at once (e.g. two
 * concurrent `hooks/session-end.mjs` runs) — see the extensive comments above that function. That
 * claim can only be tested with genuine OS-level concurrency: `node:sqlite`'s `DatabaseSync` API
 * is synchronous, so two `openSidecar` calls on one JS thread can never actually overlap — the
 * first always finishes before the second starts, which would only ever exercise the harmless
 * "column already exists" fast path. Two real child processes, launched together and awaited
 * together, can genuinely contend for the same file lock the way two `SessionEnd` hooks do in
 * production.
 *
 * Regardless of which process wins the race, both must exit cleanly (never crash with
 * `SQLITE_BUSY` or a stuck transaction) and the end state must be correct exactly once — the
 * failure mode this guards is losing that safety in a future refactor of the busy-retry/rollback
 * logic.
 */
const expectConcurrentOpenersBothSucceed = async (): Promise<void> => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'cc-recall-sidecar-race-'));
  const dbPath = path.join(tmp, 'index.db');
  try {
    insertPreMigrationRow(dbPath, recordFor('s-race', ADD_FTS), 'race-hash');

    const sidecarPath = path.join(import.meta.dirname, 'sidecar.ts');
    const workerPath = path.join(tmp, 'open-sidecar-worker.mjs');
    writeFileSync(
      workerPath,
      `import { openSidecar } from ${JSON.stringify(sidecarPath)};\nopenSidecar(process.argv[2]).close();\n`,
    );

    const [first, second] = await Promise.all([
      runOpenSidecarWorker(workerPath, dbPath),
      runOpenSidecarWorker(workerPath, dbPath),
    ]);

    expect({ code: first.code, stderr: first.stderr }).toEqual({ code: 0, stderr: '' });
    expect({ code: second.code, stderr: second.stderr }).toEqual({ code: 0, stderr: '' });

    const verify = openSidecar(dbPath);
    try {
      expect(verify.getTranscriptSyncedHash('s-race')).toBe('race-hash');
    } finally {
      verify.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

describe('sidecar', () => {
  let sidecar: Sidecar;
  beforeEach(() => {
    sidecar = openSidecar(':memory:');
  });
  afterEach(() => {
    sidecar.close();
  });

  it('round-trips a record by session id', () => {
    const record = recordFor('s-1', ADD_FTS);
    sidecar.upsert(record, 'hash-1');
    expect(sidecar.get('s-1')?.title).toBe(ADD_FTS);
    expect(sidecar.getSourceHash('s-1')).toBe('hash-1');
    expect(sidecar.get('missing')).toBeUndefined();
  });

  it('upsert replaces rather than duplicates', () => {
    sidecar.upsert(recordFor('s-1', 'first version'), 'h1');
    sidecar.upsert(recordFor('s-1', 'second version'), 'h2');
    expect(sidecar.stats().total).toBe(1);
    expect(sidecar.get('s-1')?.title).toBe('second version');
    expect(sidecar.getSourceHash('s-1')).toBe('h2');
  });

  it('finds sessions via full-text search and ignores empty queries', () => {
    sidecar.upsert(recordFor('s-1', ADD_FTS), 'h1');
    sidecar.upsert(recordFor('s-2', 'fix the migration script'), 'h2');
    const hits = sidecar.search('sidecar');
    expect(hits.map((h) => h.record.session_id)).toEqual(['s-1']);
    // eslint-disable-next-line unicorn/prefer-string-repeat
    expect(sidecar.search('   ')).toEqual([]);
  });

  it('reports stats by provenance', () => {
    sidecar.upsert(recordFor('s-1', 'a'), 'h1');
    sidecar.upsert(recordFor('s-2', 'b'), 'h2');
    const stats = sidecar.stats();
    expect(stats.total).toBe(2);
    expect(stats.byProvenance.backfill).toBe(2);
  });

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

  it('migrates an existing on-disk database that predates transcript_synced_hash', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cc-recall-sidecar-migrate-'));
    const dbPath = path.join(tmp, 'index.db');
    try {
      // Simulate a pre-migration database: the old schema, no transcript_synced_hash column.
      const oldDb = new DatabaseSync(dbPath);
      oldDb.exec(PRE_MIGRATION_SCHEMA_SQL);
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

  it('backfills transcript_synced_hash for rows that predate the column, from their existing source_hash', () => {
    expectPreexistingRowIsBackfilled();
  });

  it('does not retroactively mark a not-yet-synced row as synced on a later reopen', () => {
    expectMidflightRowSurvivesReopen();
  });

  it('lets two concurrent processes migrate the same pre-migration db without either crashing', async () => {
    await expectConcurrentOpenersBothSucceed();
  });
});
