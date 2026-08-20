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

/**
 * Two indexers processing the same session at once (e.g. a live SessionEnd hook racing a
 * backfill pass) each capture their own source_hash up front, then take an unpredictable amount
 * of wall-clock time (an LLM call vs. the heuristic fallback) before writing. If the slower one
 * (indexer A, on stale content hash-1) finishes after the faster one (indexer B, on the current
 * content hash-2) has already upserted and confirmed the write, A's markTranscriptSynced call
 * must not stamp the row with its now-stale hash-1 — that would make a row that is genuinely
 * synced at hash-2 read as unsynced (getTranscriptSyncedHash returning hash-1 while source_hash
 * is hash-2), triggering an unnecessary resynthesis.
 */
const expectSlowWriterCannotDowngradeSync = (sidecar: Sidecar): void => {
  const sessionId = 's-race-writers';
  const record = recordFor(sessionId, ADD_FTS);
  sidecar.upsert(record, 'hash-1'); // indexer A's capture of the (now-stale) content
  sidecar.upsert(record, 'hash-2'); // indexer B: newer content already upserted and...
  sidecar.markTranscriptSynced(sessionId, 'hash-2'); // ...confirmed synced

  sidecar.markTranscriptSynced(sessionId, 'hash-1'); // indexer A finally catches up

  expect(sidecar.getSourceHash(sessionId)).toBe('hash-2');
  expect(sidecar.getTranscriptSyncedHash(sessionId)).toBe('hash-2');
};

interface WorkerResult {
  code: number | null;
  stderr: string;
}

interface SpawnedWorker {
  /** Resolves once the child's stdout has emitted `readyMarker` (immediately, if none given). */
  ready: Promise<void>;
  /** Resolves once the child exits, with its exit code and accumulated stderr. */
  done: Promise<WorkerResult>;
  /** Writes a line to the child's stdin. Only meaningful when spawned with `stdin: 'pipe'`. */
  sendLine: (line: string) => void;
}

/** Spawns `scriptPath` as a real child process. `useTsx` routes it through the project's `tsx`
 * loader (already a devDependency) so a worker can import `sidecar.ts` directly, no build step;
 * the lock-holder below needs only `node:sqlite`, so it skips that and starts faster. Stdin is
 * inherited-closed (`'ignore'`) by default; pass `stdin: 'pipe'` for a worker that blocks reading
 * its own stdin for a go-ahead signal, as the lock-holder script does. */
const spawnWorker = (
  scriptPath: string,
  args: string[],
  {
    useTsx = false,
    readyMarker,
    stdin = 'ignore',
  }: { useTsx?: boolean; readyMarker?: string; stdin?: 'ignore' | 'pipe' } = {},
): SpawnedWorker => {
  // `--no-warnings`: without it, Node 22 (though not the newer version this was developed
  // against) prints `ExperimentalWarning: SQLite is an experimental feature` to stderr on every
  // `node:sqlite` import, which would fail the strict `stderr: ''` assertions below on a false
  // positive — confirmed by CI on this exact PR (round 8): green locally, red in Node 22 CI.
  const noWarnings = ['--no-warnings'];
  const nodeArgs = useTsx
    ? [...noWarnings, '--import', 'tsx/esm', scriptPath, ...args]
    : [...noWarnings, scriptPath, ...args];
  const child = spawn(process.execPath, nodeArgs, {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    stdio: [stdin, 'pipe', 'pipe'],
  });
  // `stdio` is a runtime-computed tuple, so TypeScript can't narrow `child.stdout`/`child.stderr`
  // to non-null the way it does for the `'pipe', 'pipe', 'pipe'` literal overload — both
  // positions are always `'pipe'` above regardless of `stdin`, so they're always present.
  const stdout = child.stdout as NodeJS.ReadableStream;
  const stderr_ = child.stderr as NodeJS.ReadableStream;

  let stdoutBuffered = '';
  const ready = new Promise<void>((resolve) => {
    if (!readyMarker) {
      resolve();
      return;
    }
    stdout.on('data', (chunk: Buffer) => {
      stdoutBuffered += chunk.toString();
      if (stdoutBuffered.includes(readyMarker)) resolve();
    });
  });

  let stderr = '';
  stderr_.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = new Promise<WorkerResult>((resolve) => {
    child.on('close', (code) => {
      resolve({ code, stderr });
    });
  });

  const sendLine = (line: string): void => {
    child.stdin?.write(`${line}\n`);
  };

  return { ready, done, sendLine };
};

const RACE_LOCKED_MARKER = 'LOCKED';
const RACE_ABOUT_TO_MIGRATE_MARKER = 'ABOUT_TO_MIGRATE';

/**
 * The pre-migration-db lock-holder worker's script: takes `BEGIN IMMEDIATE`, announces it over
 * stdout, then blocks synchronously reading its own stdin for a go-ahead line before running the
 * exact migration statements `migrateTranscriptSyncedHash` runs and committing.
 *
 * Waiting on a signal from the opener (see `openerScript` below), rather than sleeping a guessed
 * duration, is what makes the race deterministic: a fixed sleep has to outguess the opener's
 * process-spawn-plus-`tsx`-transform startup cost, which is both large and variable across
 * machines. The handshake removes that variable entirely — this worker simply cannot proceed
 * until the opener has confirmed it is already running.
 *
 * Built from `JSON.stringify`d SQL strings rather than hand-escaped ones so the SQL's own quoting
 * never has to match the surrounding JS quoting.
 */
const lockHolderScript = (lockedMarker: string): string =>
  [
    "import { readSync } from 'node:fs';",
    "import { DatabaseSync } from 'node:sqlite';",
    'const db = new DatabaseSync(process.argv[2]);',
    `db.exec(${JSON.stringify('PRAGMA busy_timeout = 5000;')});`,
    `db.exec(${JSON.stringify('BEGIN IMMEDIATE')});`,
    `process.stdout.write(${JSON.stringify(lockedMarker.concat('\n'))});`,
    'const goBuf = Buffer.alloc(64);',
    'let goLine = "";',
    String.raw`while (!goLine.includes("\n")) { goLine += goBuf.toString("utf8", 0, readSync(0, goBuf, 0, goBuf.length, null)); }`,
    // The opener has confirmed it is running, but its own migration check is still a handful of
    // synchronous statements away (open the connection, two cheap already-set-mode pragmas, two
    // no-op "already exists" DDL statements) — comfortably under this buffer on any machine, but
    // not instant, so this still has to wait rather than proceed the moment `goLine` arrives.
    // A Node-native blocking wait (matching the `sleepSync` pattern in sidecar.ts itself) rather
    // than shelling out to the POSIX `sleep` binary, which doesn't exist on Windows.
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);',
    `db.exec(${JSON.stringify('ALTER TABLE sessions ADD COLUMN transcript_synced_hash TEXT;')});`,
    `db.exec(${JSON.stringify('UPDATE sessions SET transcript_synced_hash = source_hash WHERE transcript_synced_hash IS NULL;')});`,
    `db.exec(${JSON.stringify('COMMIT')});`,
    'db.close();',
  ].join('\n');

/** The opener worker's script: announces it is about to call the real `openSidecar` — the
 * lock-holder above waits for exactly this signal — then makes the call. */
const openerScript = (sidecarPath: string, aboutToMigrateMarker: string): string =>
  [
    `import { openSidecar } from ${JSON.stringify(sidecarPath)};`,
    `process.stdout.write(${JSON.stringify(aboutToMigrateMarker.concat('\n'))});`,
    'openSidecar(process.argv[2]).close();',
  ].join('\n');

/** Writes the two worker scripts used by the concurrent-migration race test into `tmp` and
 * returns their paths. */
const writeRaceWorkerScripts = (tmp: string): { lockHolderPath: string; openerPath: string } => {
  const lockHolderPath = path.join(tmp, 'lock-holder-worker.mjs');
  writeFileSync(lockHolderPath, lockHolderScript(RACE_LOCKED_MARKER));

  const sidecarPath = path.join(import.meta.dirname, 'sidecar.ts');
  const openerPath = path.join(tmp, 'open-sidecar-worker.mjs');
  writeFileSync(openerPath, openerScript(sidecarPath, RACE_ABOUT_TO_MIGRATE_MARKER));

  return { lockHolderPath, openerPath };
};

/**
 * Brings `dbPath` up to the steady state of a real, already-bootstrapped `index.db` that simply
 * predates the `transcript_synced_hash` column — WAL mode, and every other object `SCHEMA_SQL`
 * creates already present — so the only schema change left for the race below is the one
 * `migrateTranscriptSyncedHash` itself makes.
 *
 * Both gaps this closes serialize the opener's *entire* `openSidecar` setup behind the
 * lock-holder's commit, not just the final `ALTER TABLE`, which made the race unwinnable
 * regardless of handshake timing — confirmed by instrumenting a standalone repro of this exact
 * scenario before writing this fix:
 * - Rollback-journal mode (SQLite's default, and what a bare `new DatabaseSync` leaves a
 *   never-before-opened file in): the opener's own `PRAGMA journal_mode = WAL` needs exclusive
 *   access to actually change modes, unlike a same-mode no-op.
 * - A missing `sessions_fts` table: `openSidecar`'s `CREATE VIRTUAL TABLE IF NOT EXISTS
 *   sessions_fts` is only a true no-op if the table already exists; creating it from scratch is
 *   real DDL and needs the same exclusive access.
 *
 * `insertPreMigrationRow` (used by the sequential migration tests elsewhere in this file) doesn't
 * need either of these, since nothing else runs concurrently against the db it writes.
 */
const warmUpToProductionStableSchema = (dbPath: string): void => {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(
    'CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(session_id UNINDEXED, title, summary, facets, phrases, files);',
  );
  db.close();
};

/** Runs the lock-holder/opener handshake described above and returns both workers' results. */
const runConcurrentMigrationRace = async (
  dbPath: string,
  lockHolderPath: string,
  openerPath: string,
): Promise<{ lockHolderResult: WorkerResult; openerResult: WorkerResult }> => {
  const lockHolder = spawnWorker(lockHolderPath, [dbPath], {
    readyMarker: RACE_LOCKED_MARKER,
    stdin: 'pipe',
  });
  // Only spawn the real opener once the lock-holder has actually taken the lock — otherwise this
  // is just two processes hoping to overlap, which is the exact flakiness this test exists to
  // remove.
  await lockHolder.ready;
  const opener = spawnWorker(openerPath, [dbPath], {
    useTsx: true,
    readyMarker: RACE_ABOUT_TO_MIGRATE_MARKER,
  });
  // Only release the lock-holder once the opener has confirmed it is about to call the real
  // `openSidecar` — the other half of the handshake that replaces a guessed sleep.
  await opener.ready;
  lockHolder.sendLine('GO');

  const [lockHolderResult, openerResult] = await Promise.all([lockHolder.done, opener.done]);
  return { lockHolderResult, openerResult };
};

/**
 * `migrateTranscriptSyncedHash`'s busy-retry-then-rollback handling exists specifically for two
 * real OS processes racing to migrate the same pre-migration `index.db` at once (e.g. two
 * concurrent `hooks/session-end.mjs` runs) — see the extensive comments above that function. That
 * claim can only be tested with genuine OS-level concurrency: `node:sqlite`'s `DatabaseSync` API
 * is synchronous, so two `openSidecar` calls on one JS thread can never actually overlap — the
 * first always finishes before the second starts, which would only ever exercise the harmless
 * "column already exists" fast path.
 *
 * Two independently-spawned processes merely started together aren't enough either — process
 * startup jitter (and the tsx loader's own transform cost) can just as easily let one finish its
 * entire migration before the other even opens the file, which would exercise the same harmless
 * fast path and silently stop testing anything. So one worker deliberately wins the race: it
 * takes `BEGIN IMMEDIATE` on the pre-migration db itself, signals over stdout once it holds that
 * lock, and only then does the test spawn the real `openSidecar` worker — which is guaranteed to
 * hit `SQLITE_BUSY` on its own `BEGIN IMMEDIATE` (retried via `withBusyRetry`) and then `duplicate
 * column name` on its `ALTER TABLE` once the lock-holder commits first. That is the exact
 * interleaving `migrateTranscriptSyncedHash`'s narrow ROLLBACK-message match and busy-retry loop
 * exist for, made deterministic instead of hoping two spawns happen to land in that window.
 *
 * The real `openSidecar` worker must still exit cleanly (never crash with `SQLITE_BUSY` or a
 * stuck transaction) and the end state must be correct exactly once — the failure mode this
 * guards is losing that safety in a future refactor of the busy-retry/rollback logic.
 */
const expectConcurrentOpenersBothSucceed = async (): Promise<void> => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'cc-recall-sidecar-race-'));
  const dbPath = path.join(tmp, 'index.db');
  try {
    insertPreMigrationRow(dbPath, recordFor('s-race', ADD_FTS), 'race-hash');
    warmUpToProductionStableSchema(dbPath);
    const { lockHolderPath, openerPath } = writeRaceWorkerScripts(tmp);
    const { lockHolderResult, openerResult } = await runConcurrentMigrationRace(
      dbPath,
      lockHolderPath,
      openerPath,
    );

    expect(lockHolderResult).toEqual({ code: 0, stderr: '' });
    expect(openerResult).toEqual({ code: 0, stderr: '' });

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

  it("does not let a slow writer downgrade the sync marker past a newer indexer's result", () => {
    expectSlowWriterCannotDowngradeSync(sidecar);
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
