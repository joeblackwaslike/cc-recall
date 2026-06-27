import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const METRICS_DIR = path.join(homedir(), '.claude', 'cc-recall', 'metrics');
const METRICS_FILE = path.join(METRICS_DIR, 'adoption.jsonl');

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

type AdoptionEvent = IntentEvent | SearchEvent;

const ensureDir = (): void => {
  if (!existsSync(METRICS_DIR)) mkdirSync(METRICS_DIR, { recursive: true });
};

export const logIntentDetection = (pattern: string): void => {
  ensureDir();
  const event: IntentEvent = { kind: 'intent', ts: new Date().toISOString(), pattern };
  appendFileSync(METRICS_FILE, `${JSON.stringify(event)}\n`);
};

export const logSearchQuery = (resultCount: number): void => {
  ensureDir();
  const event: SearchEvent = { kind: 'search', ts: new Date().toISOString(), resultCount };
  appendFileSync(METRICS_FILE, `${JSON.stringify(event)}\n`);
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

export const readAdoptionMetrics = (): AdoptionReport => {
  if (!existsSync(METRICS_FILE)) {
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

  const lines = readFileSync(METRICS_FILE, 'utf8').split('\n').filter(Boolean);
  const events: AdoptionEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as AdoptionEvent);
    } catch {
      /* skip malformed lines */
    }
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
