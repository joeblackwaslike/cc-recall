// cc-recall — enrichment spawn-rate ceiling (spec Phase 3 guardrails).
//
// A hard ceiling enforced BEFORE an enrichment subprocess is spawned, not just cleanup
// after. Once the rolling-hour count of enrichment spawns reaches the ceiling, further
// synthesis calls fall back to the heuristic record and log an incident; the ceiling never
// auto-retries a paused call, it just re-checks fresh (against the then-current window) on
// the next call.

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { countRecentEnrichmentSpawns, logEnrichmentSpawn, metricsDir } from './adoption.js';

const DEFAULT_CEILING = 30;
const DEFAULT_WINDOW_MS = 3_600_000; // rolling hour

/** A positive-integer env override, falling back when unset, empty, or not a positive integer. */
const positiveIntEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/** Max enrichment spawns allowed per rolling window. Override via CC_RECALL_SPAWN_CEILING. */
export const spawnCeiling = (): number =>
  positiveIntEnv('CC_RECALL_SPAWN_CEILING', DEFAULT_CEILING);

/** Rolling window size in ms. Override via CC_RECALL_SPAWN_WINDOW_MS. */
export const spawnWindowMs = (): number =>
  positiveIntEnv('CC_RECALL_SPAWN_WINDOW_MS', DEFAULT_WINDOW_MS);

const incidentsFile = (): string => path.join(metricsDir(), 'incidents.jsonl');

/** Append a structured incident record, mirroring ops/watchdog/bin/lib.sh's `incident()` shape. */
const logIncident = (kind: string, message: string, extra: Record<string, unknown>): void => {
  const dir = metricsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const record = { t: new Date().toISOString(), kind, msg: message, ...extra };
  appendFileSync(incidentsFile(), `${JSON.stringify(record)}\n`);
};

export interface SpawnGateResult {
  allowed: boolean;
  count: number;
  ceiling: number;
  windowMs: number;
}

/**
 * Check the rolling-window spawn ceiling. If there's room, records this spawn immediately and
 * allows it; Node is single-threaded with no `await` between the count and the log below, so
 * two enrichment attempts in the same process cannot both slip past a ceiling that's already
 * been reached. Separate `cc-recall` processes (e.g. two hook-triggered CLI invocations racing
 * on the same rolling window) are NOT synchronized against each other: each reads the file
 * independently before either appends, so in the worst case a concurrent hook storm — the
 * literal shape of Incident B, two SessionEnd-triggered CLI processes firing seconds apart —
 * can admit up to 2x the configured ceiling before either process observes the other's spawn.
 * Acceptable for a coarse per-hour ceiling meant to bound sustained runaway spend, not a precise
 * limiter; ops/cc-recall-watchdog's independent spawn-rate check is the backstop if this window
 * is ever exploited at scale.
 */
export const admitEnrichmentSpawn = (now: number = Date.now()): SpawnGateResult => {
  const ceiling = spawnCeiling();
  const windowMs = spawnWindowMs();
  const count = countRecentEnrichmentSpawns(windowMs, now);

  if (count >= ceiling) {
    logIncident('spawn_ceiling_paused', 'enrichment spawn-rate ceiling exceeded; using heuristic', {
      count,
      ceiling,
      windowMs,
    });
    return { allowed: false, count, ceiling, windowMs };
  }

  logEnrichmentSpawn();
  return { allowed: true, count: count + 1, ceiling, windowMs };
};
