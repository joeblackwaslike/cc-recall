import { describe, expect, it } from 'vitest';
import type { RecallRecord } from '../record/schema.js';
import { resolveHandoffIn, resolveHandoffOut, scoreMatch } from './match.js';

const BASE_ENDED_AT = '2026-06-10T12:00:00Z';
const SUCCESSOR_STARTED_AT = '2026-06-10T13:00:00Z';

const makeRecord = (overrides: Partial<RecallRecord>): RecallRecord => ({
  type: 'recall-record',
  schema_version: 1,
  session_id: 'test-session',
  project: 'test-project',
  cwd: '/test',
  started_at: '2026-06-10T10:00:00Z',
  ended_at: BASE_ENDED_AT,
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

describe('resolveHandoffOut', () => {
  it('returns null when no candidates match above threshold', () => {
    const source = makeRecord({
      session_id: 'a',
      ended_at: BASE_ENDED_AT,
      handoff_out: { to_session: null, text: 'continue the sidecar FTS5 work' },
    });
    const candidates = [
      makeRecord({
        session_id: 'b',
        started_at: SUCCESSOR_STARTED_AT,
        title: 'Fix CSS grid layout',
      }),
    ];
    expect(resolveHandoffOut(source, candidates)).toBeNull();
  });

  it('resolves to the best-matching candidate', () => {
    const source = makeRecord({
      session_id: 'a',
      ended_at: BASE_ENDED_AT,
      handoff_out: { to_session: null, text: 'pick up the cc-recall sidecar FTS5 implementation' },
    });
    const candidates = [
      makeRecord({
        session_id: 'b',
        started_at: SUCCESSOR_STARTED_AT,
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
      started_at: SUCCESSOR_STARTED_AT,
      handoff_in: { from_session: null, text: 'continuing from the cc-recall sidecar session' },
    });
    const candidates = [
      makeRecord({
        session_id: 'a',
        ended_at: BASE_ENDED_AT,
        title: 'cc-recall sidecar FTS5 implementation',
      }),
    ];
    expect(resolveHandoffIn(target, candidates)).toBe('a');
  });
});
