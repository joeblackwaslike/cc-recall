import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecallRecord } from '../record/schema.js';
import { type Sidecar, openSidecar } from '../surfaces/sidecar.js';
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
  let sidecar: Sidecar;
  beforeEach(() => {
    sidecar = openSidecar(':memory:');
  });
  afterEach(() => {
    sidecar.close();
  });

  it('resolves a handoff_out to handoff_in pair in the sidecar', () => {
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
      handoff_in: {
        from_session: null,
        text: 'picking up cc-recall sidecar FTS5 from last session',
      },
    });
    sidecar.upsert(a, 'h1');
    sidecar.upsert(b, 'h2');

    const result = resolveAllHandoffs(sidecar);

    expect(result.resolved).toBe(2);
    const updatedA = sidecar.get('a');
    const updatedB = sidecar.get('b');
    expect(updatedA?.handoff_out?.to_session).toBe('b');
    expect(updatedB?.handoff_in?.from_session).toBe('a');
  });

  it('returns 0 when no unresolved handoffs exist', () => {
    sidecar.upsert(makeRecord({ session_id: 'x' }), 'h1');
    const result = resolveAllHandoffs(sidecar);
    expect(result.resolved).toBe(0);
  });
});
