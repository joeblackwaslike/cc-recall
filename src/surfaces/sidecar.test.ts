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
});
