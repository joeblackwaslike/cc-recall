// cc-recall — claude-mem adapter (spec §8③, §12 G0). SECONDARY surface, gated.
//
// Read paths use the worker HTTP API (GET /api/health, /api/search) — no auth needed.
// Write path uses direct SQLite into ~/.claude-mem/claude-mem.db (the worker's own DB).
// The HTTP write endpoint (/v1/memories) requires server-beta auth which isn't available
// in worker mode, so we bypass it. The observations table has FTS triggers that auto-index
// on INSERT, and a (memory_session_id, content_hash) unique index for dedup.
//
// Surface ③ is SECONDARY: a claude-mem outage never affects the sidecar (primary).

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RecallRecord } from '../record/schema.js';

const DEFAULT_PORT = 37_777;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_SEARCH_LIMIT = 20;

/** Minimal structural fetch type so we avoid a DOM lib dependency and stay test-injectable. */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface ClaudeMemOptions {
  port?: number;
  fetch?: FetchLike;
  timeoutMs?: number;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const resolvePort = (port: number | undefined): number => {
  if (port !== undefined) return port;
  const fromEnv = Number(process.env.CLAUDE_MEM_WORKER_PORT ?? '');
  return Number.isNaN(fromEnv) || fromEnv === 0 ? DEFAULT_PORT : fromEnv;
};

const resolveFetch = (injected: FetchLike | undefined): FetchLike => injected ?? globalThis.fetch;

const baseUrl = (options: ClaudeMemOptions): string =>
  `http://127.0.0.1:${resolvePort(options.port)}`;

export interface ClaudeMemHealth {
  reachable: boolean;
  ready: boolean;
  version: string | undefined;
  error: string | undefined;
}

/** Probe the claude-mem worker. Never throws. */
export const claudeMemHealth = async (options: ClaudeMemOptions = {}): Promise<ClaudeMemHealth> => {
  const fetchFn = resolveFetch(options.fetch);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const response = await fetchFn(`${baseUrl(options)}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return {
        reachable: false,
        ready: false,
        version: undefined,
        error: `health ${response.status}`,
      };
    }
    const body = (await response.json()) as {
      status?: string;
      version?: string;
      mcpReady?: boolean;
    };
    return {
      reachable: body.status === 'ok',
      ready: body.mcpReady === true,
      version: body.version,
      error: undefined,
    };
  } catch (error) {
    return { reachable: false, ready: false, version: undefined, error: errorMessage(error) };
  }
};

export interface ClaudeMemSearch {
  ok: boolean;
  text: string | undefined;
  error: string | undefined;
}

/** Read-only search against the claude-mem worker. Never throws. */
export const searchClaudeMem = async (
  query: string,
  options: ClaudeMemOptions & { limit?: number } = {},
): Promise<ClaudeMemSearch> => {
  const fetchFn = resolveFetch(options.fetch);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  try {
    const url = `${baseUrl(options)}/api/search?query=${encodeURIComponent(query)}&limit=${limit}`;
    const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, text: undefined, error: `search ${response.status}` };
    const body = (await response.json()) as { content?: { type: string; text: string }[] };
    const text = body.content?.map((part) => part.text).join('\n');
    return { ok: true, text, error: undefined };
  } catch (error) {
    return { ok: false, text: undefined, error: errorMessage(error) };
  }
};

export interface G0Result {
  pass: boolean;
  health: ClaudeMemHealth;
  searchOk: boolean;
  detail: string;
}

/**
 * G0 acceptance check (spec §12): claude-mem reachable + ready + a read-only search
 * round-trip succeeds. Surface ③ stays disabled unless this passes.
 */
export const verifyClaudeMemG0 = async (options: ClaudeMemOptions = {}): Promise<G0Result> => {
  const health = await claudeMemHealth(options);
  if (!health.reachable) {
    return { pass: false, health, searchOk: false, detail: health.error ?? 'worker not reachable' };
  }
  const search = await searchClaudeMem('cc-recall g0 probe', { ...options, limit: 1 });
  // health.reachable is already guaranteed true by the early return above.
  const pass = health.ready && search.ok;
  const detail = pass
    ? 'health + readiness + search round-trip OK'
    : (search.error ?? 'worker not ready');
  return { pass, health, searchOk: search.ok, detail };
};

// ---------------------------------------------------------------------------
// Upsert — write cc-recall observations into claude-mem's SQLite (spec §8③)
// ---------------------------------------------------------------------------

const CLAUDE_MEM_OBS_TYPE = 'cc-recall';
const BUSY_TIMEOUT_MS = 3000;

/** Resolve the claude-mem SQLite DB path. Returns undefined if the file doesn't exist. */
export const resolveClaudeMemDb = (): string | undefined => {
  const dataDir = process.env.CLAUDE_MEM_DATA_DIR ?? path.join(homedir(), '.claude-mem');
  const dbPath = path.join(dataDir, 'claude-mem.db');
  return existsSync(dbPath) ? dbPath : undefined;
};

/** Hash the narrative text for the content_hash dedup column. */
const contentHash = (text: string): string => createHash('sha256').update(text).digest('hex');

export interface FormattedObservation {
  memory_session_id: string;
  project: string;
  type: string;
  title: string;
  subtitle: string;
  narrative: string;
  facts: string;
  concepts: string;
  files_read: string;
  files_modified: string;
  content_hash: string;
  metadata: string;
  created_at: string;
  created_at_epoch: number;
}

const SUBTITLE_MAX_LEN = 120;

const firstSentence = (text: string): string => {
  const match = /^[^.!?]+[.!?]/.exec(text);
  return match ? match[0].trim() : text.slice(0, SUBTITLE_MAX_LEN);
};

const formatToolsList = (tools: RecallRecord['artifacts']['top_tools']): string =>
  tools.map((t) => `${t.name} (${t.count})`).join(', ');

/** Format a RecallRecord into the narrative text stored in the observation. */
export const formatNarrative = (record: RecallRecord): string => {
  const lines: string[] = [`[cc-recall] ${record.title}`, '', record.summary];

  if (record.facets.completed.length > 0)
    lines.push('', `Completed: ${record.facets.completed.join('; ')}`);
  if (record.facets.questioned.length > 0)
    lines.push(`Questioned: ${record.facets.questioned.join('; ')}`);
  if (record.facets.asked_about.length > 0)
    lines.push(`Asked about: ${record.facets.asked_about.join('; ')}`);

  if (record.asks_implemented.length > 0)
    lines.push('', `Key changes: ${record.asks_implemented.join('; ')}`);
  if (record.artifacts.files_touched.length > 0)
    lines.push(`Files: ${record.artifacts.files_touched.join(', ')}`);
  if (record.artifacts.top_tools.length > 0)
    lines.push(`Top tools: ${formatToolsList(record.artifacts.top_tools)}`);

  if (record.handoff_in) lines.push('', `Continued from: ${record.handoff_in.text}`);
  if (record.handoff_out) lines.push(`Hands off to: ${record.handoff_out.text}`);

  return lines.join('\n').trim();
};

/** Map a RecallRecord to the claude-mem observation row shape. */
export const formatObservation = (
  record: RecallRecord,
  memorySessionId: string,
): FormattedObservation => {
  const narrative = formatNarrative(record);
  const concepts = [
    ...record.facets.completed,
    ...record.facets.questioned,
    ...record.facets.asked_about,
  ];

  return {
    memory_session_id: memorySessionId,
    project: record.project,
    type: CLAUDE_MEM_OBS_TYPE,
    title: record.title,
    subtitle: firstSentence(record.summary),
    narrative,
    facts: JSON.stringify([...record.asks_implemented, ...record.completions]),
    concepts: JSON.stringify(concepts),
    files_read: JSON.stringify(record.artifacts.files_touched),
    files_modified: JSON.stringify(record.artifacts.files_touched),
    content_hash: contentHash(narrative),
    metadata: JSON.stringify({
      source: 'cc-recall',
      schema_version: record.schema_version,
      synthesizer_version: record.synthesizer_version,
      session_id: record.session_id,
    }),
    created_at: record.generated_at,
    created_at_epoch: new Date(record.generated_at).getTime() || Date.now(),
  };
};

export interface UpsertResult {
  ok: boolean;
  inserted: boolean;
  error: string | undefined;
}

const INSERT_OBS_SQL = `
INSERT OR IGNORE INTO observations (
  memory_session_id, project, type, title, subtitle, narrative,
  facts, concepts, files_read, files_modified,
  content_hash, metadata, created_at, created_at_epoch
) VALUES (
  $memory_session_id, $project, $type, $title, $subtitle, $narrative,
  $facts, $concepts, $files_read, $files_modified,
  $content_hash, $metadata, $created_at, $created_at_epoch
)`;

const SESSION_LOOKUP_SQL =
  'SELECT memory_session_id FROM sdk_sessions WHERE content_session_id = $content_session_id';

/**
 * Write a cc-recall observation into claude-mem's SQLite. Never throws.
 * Opens the DB, does one INSERT OR IGNORE, then closes — minimal write window.
 */
export const upsertObservation = (record: RecallRecord, dbPath: string): UpsertResult => {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { open: true });
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);

    const sessionRow = db.prepare(SESSION_LOOKUP_SQL).get({
      $content_session_id: record.session_id,
    }) as { memory_session_id: string | null } | undefined;

    if (!sessionRow?.memory_session_id) {
      return {
        ok: false,
        inserted: false,
        error: `session ${record.session_id} not in claude-mem`,
      };
    }

    const obs = formatObservation(record, sessionRow.memory_session_id);
    const result = db.prepare(INSERT_OBS_SQL).run({
      $memory_session_id: obs.memory_session_id,
      $project: obs.project,
      $type: obs.type,
      $title: obs.title,
      $subtitle: obs.subtitle,
      $narrative: obs.narrative,
      $facts: obs.facts,
      $concepts: obs.concepts,
      $files_read: obs.files_read,
      $files_modified: obs.files_modified,
      $content_hash: obs.content_hash,
      $metadata: obs.metadata,
      $created_at: obs.created_at,
      $created_at_epoch: obs.created_at_epoch,
    });
    const inserted = result.changes > 0;
    return { ok: true, inserted, error: undefined };
  } catch (error) {
    return { ok: false, inserted: false, error: errorMessage(error) };
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort close */
    }
  }
};

export interface UpsertToClaudeMemOptions extends ClaudeMemOptions {
  onWarn?: ((message: string) => void) | undefined;
  /** Skip the G0 health check (for testing or when already verified). */
  skipG0?: boolean | undefined;
}

/**
 * Top-level upsert: G0 gate → resolve DB → write observation. Never throws.
 * Called by the engine after sidecar + transcript writes.
 */
export const upsertToClaudeMem = async (
  record: RecallRecord,
  options: UpsertToClaudeMemOptions = {},
): Promise<UpsertResult> => {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const warn = options.onWarn ?? (() => {});

  if (!options.skipG0) {
    const g0 = await verifyClaudeMemG0(options);
    if (!g0.pass) {
      warn(`claude-mem G0 failed (${g0.detail}), skipping upsert`);
      return { ok: false, inserted: false, error: g0.detail };
    }
  }

  const dbPath = resolveClaudeMemDb();
  if (!dbPath) {
    warn('claude-mem DB not found, skipping upsert');
    return { ok: false, inserted: false, error: 'DB not found' };
  }

  const result = upsertObservation(record, dbPath);
  if (!result.ok) warn(`claude-mem upsert failed: ${result.error}`);
  return result;
};
