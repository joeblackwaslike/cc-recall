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
  search: (query: string, limit?: number) => SearchHit[];
  /** Every record in the store, ordered by started_at (for batch lineage resolution). */
  listAll: () => RecallRecord[];
  /** Most significant sessions (by line count), for the native-memory front page. */
  top: (limit: number) => RecallRecord[];
  stats: () => SidecarStats;
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
    const row = statement.selectHash.get({ $session_id: sessionId }) as
      | undefined
      | { source_hash: string | null };
    return row?.source_hash ?? undefined;
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
  close() {
    db.close();
  },
});

/** Open (creating if needed) the sidecar database at the given path. */
export const openSidecar = (dbPath: string): Sidecar => {
  if (dbPath !== IN_MEMORY) mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_SQL);
  return buildSidecar(db, prepareStatements(db));
};
