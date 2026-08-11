import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Resolved per call, like `indexerModel()` in synthesizer.ts, so a test can point it at a
 * scratch dir via `CC_RECALL_METRICS_DIR` without a module reload.
 */
export const metricsDir = (): string => {
  const override = process.env.CC_RECALL_METRICS_DIR;
  return typeof override === 'string' && override.trim() !== ''
    ? override
    : path.join(homedir(), '.claude', 'cc-recall', 'metrics');
};

const metricsFile = (): string => path.join(metricsDir(), 'adoption.jsonl');

interface IntentEvent {
  kind: 'intent';
  ts: string;
  pattern: string;
}

interface SearchEvent {
  kind: 'search';
  ts: string;
  resultCount: number;
}

/** One enrichment subprocess spawn, logged before it starts (spec Phase 3 spawn-rate ceiling). */
export interface EnrichmentSpawnEvent {
  kind: 'enrichment_spawn';
  ts: string;
}

type AdoptionEvent = IntentEvent | SearchEvent | EnrichmentSpawnEvent;

const ensureDir = (): void => {
  const dir = metricsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
};

const appendEvent = (event: AdoptionEvent): void => {
  ensureDir();
  appendFileSync(metricsFile(), `${JSON.stringify(event)}\n`);
};

export const logIntentDetection = (pattern: string): void => {
  appendEvent({ kind: 'intent', ts: new Date().toISOString(), pattern });
};

export const logSearchQuery = (resultCount: number): void => {
  appendEvent({ kind: 'search', ts: new Date().toISOString(), resultCount });
};

/** Record an enrichment-subprocess spawn attempt, for the rolling-hour rate ceiling. */
export const logEnrichmentSpawn = (): void => {
  appendEvent({ kind: 'enrichment_spawn', ts: new Date().toISOString() });
};

export interface AdoptionReport {
  totalIntents: number;
  totalSearches: number;
  searchesWithHits: number;
  searchesWithMisses: number;
  hitRate: number;
  firstEvent: string | undefined;
  lastEvent: string | undefined;
  daysTracked: number;
  intentsPerDay: number;
  searchesPerDay: number;
}

const MS_PER_DAY = 86_400_000;

const readEvents = (): AdoptionEvent[] => {
  const file = metricsFile();
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const events: AdoptionEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as AdoptionEvent);
    } catch {
      /* skip malformed lines */
    }
  }
  return events;
};

/** Count `enrichment_spawn` events timestamped within the trailing `windowMs` ending at `now`. */
export const countRecentEnrichmentSpawns = (windowMs: number, now: number = Date.now()): number => {
  const since = now - windowMs;
  return readEvents().filter((event): event is EnrichmentSpawnEvent => {
    if (event.kind !== 'enrichment_spawn') return false;
    const ts = Date.parse(event.ts);
    // Excludes future-dated timestamps (clock skew, a corrupted write) as well as past-window
    // ones. Without the upper bound, a single future-dated event counts as "recent" forever --
    // not just until it naturally ages out -- permanently inflating the rolling count until
    // someone notices and hand-edits the file.
    return ts >= since && ts <= now;
  }).length;
};

export const readAdoptionMetrics = (): AdoptionReport => {
  const events = readEvents();
  if (events.length === 0) {
    return {
      totalIntents: 0,
      totalSearches: 0,
      searchesWithHits: 0,
      searchesWithMisses: 0,
      hitRate: 0,
      firstEvent: undefined,
      lastEvent: undefined,
      daysTracked: 0,
      intentsPerDay: 0,
      searchesPerDay: 0,
    };
  }

  const intents = events.filter((event): event is IntentEvent => event.kind === 'intent');
  const searches = events.filter((event): event is SearchEvent => event.kind === 'search');
  const searchesWithHits = searches.filter((s) => s.resultCount > 0).length;

  const timestamps = events.map((event) => event.ts).toSorted((a, b) => a.localeCompare(b));
  const firstEvent = timestamps[0];
  const lastEvent = timestamps.at(-1);

  const daysTracked =
    firstEvent && lastEvent
      ? Math.max(1, Math.ceil((Date.parse(lastEvent) - Date.parse(firstEvent)) / MS_PER_DAY))
      : 0;

  return {
    totalIntents: intents.length,
    totalSearches: searches.length,
    searchesWithHits,
    searchesWithMisses: searches.length - searchesWithHits,
    hitRate: searches.length > 0 ? searchesWithHits / searches.length : 0,
    firstEvent,
    lastEvent,
    daysTracked,
    intentsPerDay: daysTracked > 0 ? intents.length / daysTracked : 0,
    searchesPerDay: daysTracked > 0 ? searches.length / daysTracked : 0,
  };
};
