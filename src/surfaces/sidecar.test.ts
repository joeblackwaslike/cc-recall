import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecallRecord } from '../record/schema.js';
import { synthesizeHeuristic } from '../record/synthesizer.js';
import { parseTranscriptText } from '../transcript/parse.js';
import { type Sidecar, openSidecar } from './sidecar.js';

const ADD_FTS = 'add FTS search to the sidecar';

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
});
