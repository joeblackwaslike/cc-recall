// cc-recall — sidecar SQLite store (spec §8①, PRIMARY retrieval surface).
//
// One row per session plus an FTS5 index over title/summary/facets/phrases/files.
// Retrieval queries this single file instead of opening ~15k transcripts. Owned
// entirely by cc-recall and fully rebuildable from transcripts, so it is never a
// single point of data loss. Uses node:SQLite (built into Node 22+) — no native
// compilation, which matters for a distributable plugin.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { type RecallRecord, parseRecallRecord } from '../record/schema.js';

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_LIMIT = 1000;
const IN_MEMORY = ':memory:';
/**
 * How long a connection waits on a lock held by another process before giving up.
 *
 * node:sqlite defaults `busy_timeout` to 0 — any lock contention (e.g. two `hooks/session-end.mjs`
 * runs opening the same `index.db` at once) throws `SQLITE_BUSY: database is locked` immediately,
 * confirmed by racing two real OS processes against a fresh pre-migration db. This has to be set
 * as the very first statement on the connection, before the WAL pragma or `CREATE TABLE`, or the
 * statements that establish the schema are themselves exposed to the race.
 */
const BUSY_TIMEOUT_MS = 5000;

const OPEN_RETRY_ATTEMPTS = 10;
const OPEN_RETRY_DELAY_MS = 25;
/** The buffer is zero-initialized; `Atomics.wait` expects slot 0 to equal 0 and sleeps for `ms` ms before returning `'timed-out'`. */
const SYNC_SLEEP_BUFFER_BYTES = Int32Array.BYTES_PER_ELEMENT;

/** Synchronous sleep — `node:sqlite` is a sync API, so an async delay can't sit between retries. */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(SYNC_SLEEP_BUFFER_BYTES)), 0, 0, ms);
};

/** SQLite's own error code for `SQLITE_BUSY`, per https://www.sqlite.org/rescode.html#busy. */
const SQLITE_BUSY_ERRCODE = 5;

/**
 * Match on both the SQLite error code and the message text, not the text alone. `errstr` duck-
 * typing on its own would treat any error object that happens to carry `errstr === 'database is
 * locked'` as retryable regardless of its actual SQLite error code — `errcode` pins it to the one
 * SQLite condition (`SQLITE_BUSY`) this retry loop exists for.
 */
const isSqliteBusyError = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  error.code === 'ERR_SQLITE_ERROR' &&
  'errcode' in error &&
  error.errcode === SQLITE_BUSY_ERRCODE;

/**
 * Retry an action through `SQLITE_BUSY`.
 *
 * `PRAGMA busy_timeout` (set immediately after opening the connection, below) covers most lock
 * contention between two processes racing to open the same pre-existing `index.db`, but the
 * `journal_mode = WAL` switch specifically can still return `SQLITE_BUSY: database is locked`
 * without honouring it — confirmed empirically by racing two real OS processes against a fresh
 * pre-migration db repeatedly: `busy_timeout` alone cut failures from every trial to roughly 1 in
 * 5, and this retry loop around the whole open sequence was needed to close the rest.
 */
const withBusyRetry = <T>(action: () => T): T => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return action();
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error;
      if (attempt >= OPEN_RETRY_ATTEMPTS) throw error;
      sleepSync(OPEN_RETRY_DELAY_MS);
    }
  }
};

const execWithBusyRetry = (db: DatabaseSync, sql: string): void => {
  withBusyRetry(() => {
    db.exec(sql);
  });
};

const clampLimit = (limit: number): number =>
  Math.max(1, Math.min(Math.floor(limit) || DEFAULT_SEARCH_LIMIT, MAX_LIMIT));

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
`;

/**
 * Add `transcript_synced_hash` to a `sessions` table that predates it, and backfill pre-existing
 * rows so they read as already-synced rather than as a retry-gate miss.
 *
 * SQLite's `ALTER TABLE ... ADD COLUMN` has no `IF NOT EXISTS` clause (unlike Postgres) — running
 * it twice throws `duplicate column name`, confirmed against the node:sqlite-bundled SQLite
 * 3.53.2. So this checks `pragma_table_info` first and only migrates once. Deliberately not part
 * of `CREATE TABLE IF NOT EXISTS sessions (...)`: that statement is a no-op against the live
 * production `index.db`, which already has a `sessions` table without this column — only an
 * explicit `ALTER TABLE`, run here on every `openSidecar` call, reaches it.
 *
 * `ALTER TABLE ... ADD COLUMN` and the backfill `UPDATE` run inside a single `BEGIN
 * IMMEDIATE ... COMMIT` transaction, specifically so column existence stays a trustworthy
 * completion marker: SQLite's DDL is transactional, so if this process is killed between the two
 * statements, the whole transaction — including the `ALTER TABLE` — rolls back, and the column
 * still doesn't exist on the next `openSidecar` call. Without that atomicity, a crash in that
 * window would leave the column present but every pre-existing row permanently un-backfilled,
 * since every future call takes the fast "column already exists" return above and the backfill
 * would never run again.
 *
 * Two OS processes can both pass the `pragma_table_info` check before either runs `ALTER TABLE`
 * (e.g. two `hooks/session-end.mjs` runs racing on the same pre-migration `index.db`) — the loser
 * hits `duplicate column name` on its own `ALTER TABLE`. Because the transaction is atomic, that
 * failure is proof the other process's *entire* migration (`ALTER TABLE` + backfill `UPDATE`)
 * already committed — never a partial win — so the loser rolls back its own no-op transaction and
 * returns rather than re-throwing or re-running the backfill itself.
 *
 * The backfill (`UPDATE ... WHERE transcript_synced_hash IS NULL`) only runs in the branch where
 * *this* process's own `ALTER TABLE` just succeeded — never on the fast "column already exists"
 * return above, and never in the race-loss branch. Every pre-existing row predates
 * `transcript_synced_hash` entirely, so its transcript was written under the old code and is
 * already correct; without this, the retry gate in `engine.ts` (`getTranscriptSyncedHash(id) ===
 * sourceHash`) sees NULL for every one of them and re-synthesizes the entire corpus, LLM calls
 * included, on the next backfill/repair pass. Running it unconditionally on every `openSidecar`
 * call instead would be wrong the other way: it would stamp rows that are genuinely mid-flight
 * (upserted but not yet transcript-synced) as synced, defeating the m32 retry-gate fix for new
 * sessions too.
 */
const migrateTranscriptSyncedHash = (db: DatabaseSync): void => {
  const columns = db.prepare("SELECT name FROM pragma_table_info('sessions')").all() as {
    name: string;
  }[];
  if (columns.some((column) => column.name === 'transcript_synced_hash')) return;

  withBusyRetry(() => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('ALTER TABLE sessions ADD COLUMN transcript_synced_hash TEXT;');
    } catch (error) {
      db.exec('ROLLBACK');
      if (error instanceof Error && error.message.includes('duplicate column name')) return;
      throw error;
    }
    db.exec(
      'UPDATE sessions SET transcript_synced_hash = source_hash WHERE transcript_synced_hash IS NULL;',
    );
    db.exec('COMMIT');
  });
};

const UPSERT_SQL = `
INSERT INTO sessions (
  session_id, project, cwd, git_branch, started_at, ended_at, line_count,
  title, summary, provenance, schema_version, synthesizer_version, generated_at,
  source_hash, handoff_in_from, handoff_out_to, record_json
) VALUES (
  $session_id, $project, $cwd, $git_branch, $started_at, $ended_at, $line_count,
  $title, $summary, $provenance, $schema_version, $synthesizer_version, $generated_at,
  $source_hash, $handoff_in_from, $handoff_out_to, $record_json
)
ON CONFLICT(session_id) DO UPDATE SET
  project = excluded.project, cwd = excluded.cwd, git_branch = excluded.git_branch,
  started_at = excluded.started_at, ended_at = excluded.ended_at,
  line_count = excluded.line_count, title = excluded.title, summary = excluded.summary,
  provenance = excluded.provenance, schema_version = excluded.schema_version,
  synthesizer_version = excluded.synthesizer_version, generated_at = excluded.generated_at,
  source_hash = excluded.source_hash, handoff_in_from = excluded.handoff_in_from,
  handoff_out_to = excluded.handoff_out_to, record_json = excluded.record_json
`;

export interface SearchHit {
  record: RecallRecord;
  /** FTS5 bm25 score; lower is a better match. */
  score: number;
}

export interface SidecarStats {
  total: number;
  byProvenance: Record<string, number>;
}

export interface Sidecar {
  upsert: (record: RecallRecord, sourceHash?: string) => void;
  get: (sessionId: string) => RecallRecord | undefined;
  getSourceHash: (sessionId: string) => string | undefined;
  getTranscriptSyncedHash: (sessionId: string) => string | undefined;
  markTranscriptSynced: (sessionId: string, sourceHash: string) => void;
  search: (query: string, limit?: number) => SearchHit[];
  /** Every record in the store, ordered by started_at (for batch lineage resolution). */
  listAll: () => RecallRecord[];
  /** Most significant sessions (by line count), for the native-memory front page. */
  top: (limit: number) => RecallRecord[];
  stats: () => SidecarStats;
  /**
   * Reclaim space from deleted rows. Returns bytes before and after.
   *
   * SQLite never shrinks a file on its own — freed pages are reused but the file stays at its
   * high-water mark, so a store that has churned through re-indexes keeps every page it ever
   * needed. VACUUM rewrites it compactly. It is safe to run at any time and the sidecar is
   * rebuildable from transcripts regardless, which is why this belongs in `doctor` rather than
   * behind a confirmation.
   */
  vacuum: () => { before: number; after: number };
  close: () => void;
}

/** Turn an arbitrary user string into a safe FTS5 MATCH expression (tokens AND'd). */
const toFtsQuery = (query: string): string => {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens.map((token) => `"${token}"`).join(' ');
};

const ftsBlob = (record: RecallRecord): { facets: string; phrases: string; files: string } => ({
  facets: [
    ...record.facets.completed,
    ...record.facets.questioned,
    ...record.facets.asked_about,
    ...record.asks_implemented,
    ...record.completions,
  ].join(' \n'),
  phrases: record.artifacts.distinctive_phrases.join(' \n'),
  files: record.artifacts.files_touched.join(' \n'),
});

const sessionRow = (
  record: RecallRecord,
  sourceHash: string | undefined,
): Record<string, string | number | null> => ({
  $session_id: record.session_id,
  $project: record.project,
  $cwd: record.cwd,
  $git_branch: record.git_branch ?? null,
  $started_at: record.started_at,
  $ended_at: record.ended_at,
  $line_count: record.line_count,
  $title: record.title,
  $summary: record.summary,
  $provenance: record.provenance,
  $schema_version: record.schema_version,
  $synthesizer_version: record.synthesizer_version,
  $generated_at: record.generated_at,
  $source_hash: sourceHash ?? null,
  $handoff_in_from: record.handoff_in?.from_session ?? null,
  $handoff_out_to: record.handoff_out?.to_session ?? null,
  $record_json: JSON.stringify(record),
});

interface Statements {
  upsertSession: StatementSync;
  insertFts: StatementSync;
  deleteFts: StatementSync;
  selectOne: StatementSync;
  selectHash: StatementSync;
  selectSyncedHash: StatementSync;
  markSynced: StatementSync;
  listAllStmt: StatementSync;
  searchStmt: StatementSync;
  topStmt: StatementSync;
  countStmt: StatementSync;
  provStmt: StatementSync;
}

const prepareStatements = (db: DatabaseSync): Statements => ({
  upsertSession: db.prepare(UPSERT_SQL),
  insertFts: db.prepare(
    'INSERT INTO sessions_fts (session_id, title, summary, facets, phrases, files) VALUES ($session_id, $title, $summary, $facets, $phrases, $files)',
  ),
  deleteFts: db.prepare('DELETE FROM sessions_fts WHERE session_id = $session_id'),
  selectOne: db.prepare('SELECT record_json FROM sessions WHERE session_id = $session_id'),
  selectHash: db.prepare('SELECT source_hash FROM sessions WHERE session_id = $session_id'),
  selectSyncedHash: db.prepare(
    'SELECT transcript_synced_hash FROM sessions WHERE session_id = $session_id',
  ),
  markSynced: db.prepare(
    'UPDATE sessions SET transcript_synced_hash = $hash WHERE session_id = $session_id',
  ),
  listAllStmt: db.prepare('SELECT record_json FROM sessions ORDER BY started_at'),
  searchStmt: db.prepare(
    `SELECT s.record_json AS record_json, bm25(sessions_fts) AS score
     FROM sessions_fts f JOIN sessions s ON s.session_id = f.session_id
     WHERE sessions_fts MATCH $query ORDER BY score LIMIT $limit`,
  ),
  topStmt: db.prepare(
    'SELECT record_json FROM sessions ORDER BY line_count DESC, ended_at DESC LIMIT $limit',
  ),
  countStmt: db.prepare('SELECT count(*) AS total FROM sessions'),
  provStmt: db.prepare('SELECT provenance, count(*) AS n FROM sessions GROUP BY provenance'),
});

/** Read a single nullable TEXT column from a `session_id`-keyed statement. */
const selectOptionalString = (
  preparedStatement: StatementSync,
  sessionId: string,
  column: 'source_hash' | 'transcript_synced_hash',
): string | undefined => {
  const row = preparedStatement.get({ $session_id: sessionId }) as
    | Record<string, string | null>
    | undefined;
  return row?.[column] ?? undefined;
};

const buildSidecar = (db: DatabaseSync, statement: Statements): Sidecar => ({
  upsert(record, sourceHash) {
    db.prepare('BEGIN').run();
    try {
      statement.upsertSession.run(sessionRow(record, sourceHash));
      statement.deleteFts.run({ $session_id: record.session_id });
      const blob = ftsBlob(record);
      statement.insertFts.run({
        $session_id: record.session_id,
        $title: record.title,
        $summary: record.summary,
        $facets: blob.facets,
        $phrases: blob.phrases,
        $files: blob.files,
      });
      db.prepare('COMMIT').run();
    } catch (error) {
      db.prepare('ROLLBACK').run();
      throw error;
    }
  },
  get(sessionId) {
    const row = statement.selectOne.get({ $session_id: sessionId }) as
      | undefined
      | { record_json: string };
    return row ? parseRecallRecord(JSON.parse(row.record_json)) : undefined;
  },
  getSourceHash(sessionId) {
    return selectOptionalString(statement.selectHash, sessionId, 'source_hash');
  },
  getTranscriptSyncedHash(sessionId) {
    return selectOptionalString(statement.selectSyncedHash, sessionId, 'transcript_synced_hash');
  },
  markTranscriptSynced(sessionId, sourceHash) {
    statement.markSynced.run({ $session_id: sessionId, $hash: sourceHash });
  },
  listAll() {
    const rows = statement.listAllStmt.all() as { record_json: string }[];
    return rows.map((row) => parseRecallRecord(JSON.parse(row.record_json)));
  },
  search(query, limit = DEFAULT_SEARCH_LIMIT) {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];
    const rows = statement.searchStmt.all({ $query: ftsQuery, $limit: clampLimit(limit) }) as {
      record_json: string;
      score: number;
    }[];
    return rows.map((row) => ({
      record: parseRecallRecord(JSON.parse(row.record_json)),
      score: row.score,
    }));
  },
  top(limit) {
    const rows = statement.topStmt.all({ $limit: clampLimit(limit) }) as { record_json: string }[];
    return rows.map((row) => parseRecallRecord(JSON.parse(row.record_json)));
  },
  stats() {
    const total = (statement.countStmt.get() as { total: number }).total;
    const byProvenance: Record<string, number> = {};
    for (const row of statement.provStmt.all() as { provenance: string; n: number }[]) {
      byProvenance[row.provenance] = row.n;
    }
    return { total, byProvenance };
  },
  vacuum() {
    // page_count * page_size is the file's own accounting, which is what VACUUM changes; statSync
    // would also work but reports the same number a moment later than the pragma does.
    const measure = (): number => {
      const pages = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
      const size = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
      return pages * size;
    };
    const before = measure();
    db.exec('VACUUM');
    return { before, after: measure() };
  },
  close() {
    db.close();
  },
});

/** Open (creating if needed) the sidecar database at the given path. */
export const openSidecar = (dbPath: string): Sidecar => {
  if (dbPath !== IN_MEMORY) mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    execWithBusyRetry(db, 'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    execWithBusyRetry(db, SCHEMA_SQL);
    migrateTranscriptSyncedHash(db);
    return buildSidecar(db, prepareStatements(db));
  } catch (error) {
    // Every setup step above can throw (busy_timeout, WAL setup, schema exec, migration) — if any
    // does, the connection must not leak. An open-but-unusable handle left alive in-process turns
    // a transient setup failure into follow-on SQLITE_BUSY errors for every later `openSidecar`
    // call against the same file, which is much harder to diagnose than the original error.
    db.close();
    throw new Error(`Failed to open sidecar database at ${dbPath}`, { cause: error });
  }
};
