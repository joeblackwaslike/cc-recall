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
  /** The rolling-window count this decision was based on; `undefined` if it couldn't be read. */
  count: number | undefined;
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

  let count: number;
  try {
    count = countRecentEnrichmentSpawns(windowMs, now);
  } catch {
    // Can't read the metrics file (permissions, a corrupted mount, disk trouble). Fail closed,
    // not open: a heuristic record is the same graceful degradation `synthesize` already applies
    // to every other enrichment failure, whereas failing open here would silently drop the
    // ceiling's safety guarantee for as long as the I/O trouble lasts. `count: undefined` here is
    // deliberate, not a stand-in for "at ceiling" -- the read failed, so the real count is
    // unknown, not known-and-equal-to-ceiling.
    return { allowed: false, count: undefined, ceiling, windowMs };
  }

  if (count >= ceiling) {
    try {
      logIncident(
        'spawn_ceiling_paused',
        'enrichment spawn-rate ceiling exceeded; using heuristic',
        {
          count,
          ceiling,
          windowMs,
        },
      );
    } catch {
      /* best-effort audit log; the ceiling decision itself does not depend on it */
    }
    return { allowed: false, count, ceiling, windowMs };
  }

  try {
    logEnrichmentSpawn();
  } catch {
    // Same fail-closed reasoning as above: if this spawn can't be durably recorded, admitting it
    // anyway would let it run uncounted, silently defeating the ceiling on every later check.
    // `count: undefined` here too -- this denial isn't "count reached ceiling" (it didn't; that
    // branch already returned above), it's "couldn't durably record it," the same unknown-count
    // case as a read failure, not a fabricated exceeded-ceiling reading.
    return { allowed: false, count: undefined, ceiling, windowMs };
  }
  return { allowed: true, count: count + 1, ceiling, windowMs };
};
