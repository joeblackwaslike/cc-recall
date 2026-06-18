// cc-recall — claude-mem adapter (spec §8③, §12 G0). SECONDARY surface, gated.
//
// Investigation (2026-06-14): claude-mem ships no CLI. It runs a worker HTTP service on
// 127.0.0.1:37777 (configurable via CLAUDE_MEM_WORKER_PORT) backed by SQLite at
// ~/.claude-mem/claude-mem.db, and already auto-observes every session via its own hooks.
//
// Read paths are stable public endpoints: GET /API/health, /API/readiness, /API/search.
// The WRITE path (observation_add → /v1/memories) is "server-beta runtime only" and would
// duplicate claude-mem's own auto-observations — so cc-recall deliberately does NOT write
// to claude-mem. Surface ③ is therefore a read-only coexistence + the G0 health gate; a
// claude-mem outage never affects the sidecar (primary). If a stable upsert API appears,
// add it here behind the same health gate.

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
