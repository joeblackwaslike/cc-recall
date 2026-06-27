import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { RECALL_RECORD_TYPE, SCHEMA_VERSION, SYNTHESIZER_VERSION } from '../record/schema.js';
import type { RecallRecord } from '../record/schema.js';
import {
  type FetchLike,
  type FormattedObservation,
  claudeMemHealth,
  formatNarrative,
  formatObservation,
  searchClaudeMem,
  upsertObservation,
  verifyClaudeMemG0,
} from './claude-mem.js';

const respond = (body: unknown, isOk = true, status = 200): ReturnType<FetchLike> =>
  Promise.resolve({ ok: isOk, status, json: () => Promise.resolve(body) });

const healthyFetch: FetchLike = (url) =>
  respond(
    url.includes('/api/health')
      ? { status: 'ok', version: '13.6.0', mcpReady: true }
      : { content: [{ type: 'text', text: 'a result' }] },
  );

const refusingFetch: FetchLike = () => Promise.reject(new Error('ECONNREFUSED'));

const TEST_SESSION_ID = 'aaaa-bbbb-cccc';
const TEST_MEMORY_SESSION_ID = 'mem-1111-2222';
const TEST_PROJECT = 'test-project';
const TEST_STARTED_AT = '2026-06-15T20:00:00.000Z';
const SHA256_HEX_LEN = 64;
const TEST_TITLE = 'Implement auth middleware';
const COUNT_OBS_SQL = 'SELECT count(*) as n FROM observations';

const makeRecord = (overrides: Partial<RecallRecord> = {}): RecallRecord => ({
  type: RECALL_RECORD_TYPE,
  schema_version: SCHEMA_VERSION,
  session_id: TEST_SESSION_ID,
  project: '-Users-joe-github-test-project',
  cwd: '/Users/joe/github/test-project',
  started_at: TEST_STARTED_AT,
  ended_at: '2026-06-15T21:00:00.000Z',
  line_count: 150,
  title: TEST_TITLE,
  summary: 'Added JWT verification to API routes. Covered edge cases for expired tokens.',
  asks_implemented: ['Add JWT auth to /api/users', 'Handle expired token errors'],
  completions: ['Auth middleware complete with tests'],
  handoff_in: null,
  handoff_out: { to_session: null, text: 'Next: add rate limiting' },
  artifacts: {
    files_touched: ['src/middleware/auth.ts', 'src/routes/users.ts'],
    top_tools: [
      { name: 'Edit', count: 12 },
      { name: 'Bash', count: 8 },
    ],
    distinctive_phrases: ['JWT verification', 'expired token'],
  },
  facets: {
    completed: ['JWT auth middleware', 'token expiry handling'],
    questioned: ['rate limiting approach'],
    asked_about: ['auth best practices'],
  },
  provenance: 'backfill',
  generated_at: '2026-06-15T22:00:00.000Z',
  synthesizer_version: SYNTHESIZER_VERSION,
  ...overrides,
});

const CLAUDE_MEM_SCHEMA = `
CREATE TABLE IF NOT EXISTS sdk_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT UNIQUE NOT NULL,
  memory_session_id TEXT UNIQUE,
  project TEXT NOT NULL,
  started_at TEXT NOT NULL,
  started_at_epoch INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  text TEXT,
  type TEXT NOT NULL,
  title TEXT,
  subtitle TEXT,
  facts TEXT,
  narrative TEXT,
  concepts TEXT,
  files_read TEXT,
  files_modified TEXT,
  prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  content_hash TEXT,
  generated_by_model TEXT,
  relevance_count INTEGER DEFAULT 0,
  merged_into_project TEXT,
  agent_type TEXT,
  agent_id TEXT,
  metadata TEXT,
  FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_observations_session_hash
  ON observations(memory_session_id, content_hash);
`;

const setupTestDb = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  db.exec(CLAUDE_MEM_SCHEMA);
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
     VALUES ($csid, $msid, $project, $started_at, $epoch, 'completed')`,
  ).run({
    $csid: TEST_SESSION_ID,
    $msid: TEST_MEMORY_SESSION_ID,
    $project: TEST_PROJECT,
    $started_at: TEST_STARTED_AT,
    $epoch: 1_750_017_600_000,
  });
  return db;
};

// --- Existing read-only tests ---

describe('claude-mem adapter', () => {
  it('reports health from the worker', async () => {
    const health = await claudeMemHealth({ fetch: healthyFetch });
    expect(health.reachable).toBe(true);
    expect(health.ready).toBe(true);
    expect(health.version).toBe('13.6.0');
  });

  it('never throws when the worker is down', async () => {
    const health = await claudeMemHealth({ fetch: refusingFetch });
    expect(health.reachable).toBe(false);
    expect(health.error).toContain('ECONNREFUSED');
  });

  it('returns search text on success', async () => {
    const result = await searchClaudeMem('pieces', { fetch: healthyFetch });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('a result');
  });

  it('G0 passes when reachable, ready, and search works', async () => {
    const g0 = await verifyClaudeMemG0({ fetch: healthyFetch });
    expect(g0.pass).toBe(true);
    expect(g0.searchOk).toBe(true);
  });

  it('G0 fails (without throwing) when the worker is unreachable', async () => {
    const g0 = await verifyClaudeMemG0({ fetch: refusingFetch });
    expect(g0.pass).toBe(false);
    expect(g0.health.reachable).toBe(false);
  });
});

// --- Upsert tests ---

describe('formatNarrative', () => {
  it('produces searchable text from a RecallRecord', () => {
    const text = formatNarrative(makeRecord());
    expect(text).toContain('[cc-recall] Implement auth middleware');
    expect(text).toContain('JWT verification');
    expect(text).toContain('Completed: JWT auth middleware; token expiry handling');
    expect(text).toContain('Questioned: rate limiting approach');
    expect(text).toContain('Asked about: auth best practices');
    expect(text).toContain('Key changes: Add JWT auth to /api/users');
    expect(text).toContain('Files: src/middleware/auth.ts, src/routes/users.ts');
    expect(text).toContain('Top tools: Edit (12), Bash (8)');
    expect(text).toContain('Hands off to: Next: add rate limiting');
    expect(text).not.toContain('Continued from');
  });

  it('includes handoff_in when present', () => {
    const record = makeRecord({
      handoff_in: { from_session: 'prev-sess', text: 'Previous work on auth scaffold' },
    });
    const text = formatNarrative(record);
    expect(text).toContain('Continued from: Previous work on auth scaffold');
  });

  it('omits empty sections', () => {
    const record = makeRecord({
      facets: { completed: [], questioned: [], asked_about: [] },
      asks_implemented: [],
      handoff_out: null,
    });
    const text = formatNarrative(record);
    expect(text).not.toContain('Completed:');
    expect(text).not.toContain('Questioned:');
    expect(text).not.toContain('Key changes:');
    expect(text).not.toContain('Hands off to:');
  });
});

describe('formatObservation', () => {
  it('maps RecallRecord to observation row shape', () => {
    const obs = formatObservation(makeRecord(), TEST_MEMORY_SESSION_ID);
    expect(obs.memory_session_id).toBe(TEST_MEMORY_SESSION_ID);
    expect(obs.type).toBe('cc-recall');
    expect(obs.title).toBe(TEST_TITLE);
    expect(obs.subtitle).toBe('Added JWT verification to API routes.');
    expect(obs.content_hash).toHaveLength(SHA256_HEX_LEN);
    expect(JSON.parse(obs.facts) as string[]).toContain('Add JWT auth to /api/users');
    expect(JSON.parse(obs.concepts) as string[]).toContain('JWT auth middleware');
    expect(JSON.parse(obs.files_modified) as string[]).toContain('src/middleware/auth.ts');
    const meta = JSON.parse(obs.metadata) as { source: string; session_id: string };
    expect(meta.source).toBe('cc-recall');
    expect(meta.session_id).toBe(TEST_SESSION_ID);
  });
});

const INSERT_SQL = `
  INSERT OR IGNORE INTO observations (
    memory_session_id, project, type, title, subtitle, narrative,
    facts, concepts, files_read, files_modified,
    content_hash, metadata, created_at, created_at_epoch
  ) VALUES (
    $memory_session_id, $project, $type, $title, $subtitle, $narrative,
    $facts, $concepts, $files_read, $files_modified,
    $content_hash, $metadata, $created_at, $created_at_epoch
  )`;

const toParameters = (o: FormattedObservation): Record<string, string | number> => ({
  $memory_session_id: o.memory_session_id,
  $project: o.project,
  $type: o.type,
  $title: o.title,
  $subtitle: o.subtitle,
  $narrative: o.narrative,
  $facts: o.facts,
  $concepts: o.concepts,
  $files_read: o.files_read,
  $files_modified: o.files_modified,
  $content_hash: o.content_hash,
  $metadata: o.metadata,
  $created_at: o.created_at,
  $created_at_epoch: o.created_at_epoch,
});

describe('upsertObservation', () => {
  let db: DatabaseSync;

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it('inserts an observation for a known session', () => {
    db = setupTestDb();
    const obs = formatObservation(makeRecord(), TEST_MEMORY_SESSION_ID);
    const result = db.prepare(INSERT_SQL).run(toParameters(obs));
    expect(result.changes).toBe(1);

    const count = db.prepare(COUNT_OBS_SQL).get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('deduplicates by content_hash (INSERT OR IGNORE)', () => {
    db = setupTestDb();
    const obs = formatObservation(makeRecord(), TEST_MEMORY_SESSION_ID);
    const parameters = toParameters(obs);
    db.prepare(INSERT_SQL).run(parameters);
    const second = db.prepare(INSERT_SQL).run(parameters);
    expect(second.changes).toBe(0);

    const count = db.prepare(COUNT_OBS_SQL).get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('allows a new row when content changes (different hash)', () => {
    db = setupTestDb();
    const obs1 = formatObservation(makeRecord(), TEST_MEMORY_SESSION_ID);
    const obs2 = formatObservation(
      makeRecord({ title: 'Updated auth middleware v2' }),
      TEST_MEMORY_SESSION_ID,
    );
    expect(obs1.content_hash).not.toBe(obs2.content_hash);

    const statement = db.prepare(INSERT_SQL);
    statement.run(toParameters(obs1));
    statement.run(toParameters(obs2));

    const count = db.prepare(COUNT_OBS_SQL).get() as { n: number };
    expect(count.n).toBe(2);
  });
});

describe('upsertObservation (file-backed)', () => {
  it('returns ok:false when session is not in claude-mem', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const temporaryDir = mkdtempSync(path.join(tmpdir(), 'cm-test-'));
    const temporaryDbPath = path.join(temporaryDir, 'claude-mem.db');

    const temporaryDb = new DatabaseSync(temporaryDbPath);
    temporaryDb.exec(CLAUDE_MEM_SCHEMA);
    temporaryDb.close();

    const result = upsertObservation(makeRecord({ session_id: 'nonexistent' }), temporaryDbPath);
    expect(result.ok).toBe(false);
    expect(result.inserted).toBe(false);
    expect(result.error).toContain('not in claude-mem');

    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('inserts successfully via upsertObservation with a real temp DB', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const temporaryDir = mkdtempSync(path.join(tmpdir(), 'cm-test-'));
    const temporaryDbPath = path.join(temporaryDir, 'claude-mem.db');

    const temporaryDb = new DatabaseSync(temporaryDbPath);
    temporaryDb.exec(CLAUDE_MEM_SCHEMA);
    temporaryDb
      .prepare(
        `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
       VALUES ($csid, $msid, $project, $started_at, $epoch, 'completed')`,
      )
      .run({
        $csid: TEST_SESSION_ID,
        $msid: TEST_MEMORY_SESSION_ID,
        $project: TEST_PROJECT,
        $started_at: TEST_STARTED_AT,
        $epoch: 1_750_017_600_000,
      });
    temporaryDb.close();

    const result = upsertObservation(makeRecord(), temporaryDbPath);
    expect(result.ok).toBe(true);
    expect(result.inserted).toBe(true);

    const verifyDb = new DatabaseSync(temporaryDbPath, { open: true });
    const row = verifyDb.prepare('SELECT title, type FROM observations LIMIT 1').get() as {
      title: string;
      type: string;
    };
    expect(row.title).toBe(TEST_TITLE);
    expect(row.type).toBe('cc-recall');
    verifyDb.close();

    rmSync(temporaryDir, { recursive: true, force: true });
  });
});
