// cc-recall — orchestration engine (spec §9).
//
// Ties the synthesizer to the surfaces: parse a transcript → synthesize a record →
// upsert the sidecar (primary) and inject it into the transcript. Shared by forward
// capture (the SessionEnd hook calls `indexSession`) and the backfill engine, so both
// paths stay byte-for-byte consistent. Idempotent and resumable: a session whose source
// hash already matches the sidecar is skipped before any (costly) synthesis.

import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Provenance, RecallRecord } from './record/schema.js';
import {
  INDEXER_CWD,
  type LlmRunner,
  type SynthesizeOptions,
  isIndexerTranscript,
  synthesize,
} from './record/synthesizer.js';
import {
  type UpsertToClaudeMemOptions,
  upsertToClaudeMem,
  verifyClaudeMemG0,
} from './surfaces/claude-mem.js';
import type { Sidecar } from './surfaces/sidecar.js';
import {
  type WriteOptions,
  computeSourceHash,
  writeRecordToTranscript,
} from './surfaces/transcript-writer.js';
import { parseTranscriptText } from './transcript/parse.js';

export const defaultProjectsRoot = (): string => path.join(homedir(), '.claude', 'projects');

/** The encoded-cwd project dir name a transcript lives under. */
export const projectFromPath = (filePath: string): string => path.basename(path.dirname(filePath));

/**
 * Claude Code encodes a cwd into a project dir name by replacing `/` and `.` with `-`.
 *
 * Derived empirically from live project dirs rather than from documentation, e.g.
 * `/Users/joe/.claude/projects/-Users-joe` → `-Users-joe--claude-projects--Users-joe`
 * (note the doubled `-` where `/.` collapses). If Claude Code ever changes this encoding the
 * skip below fails *silently* — enrichment transcripts resume being enumerated — so the
 * accompanying test writes a transcript under the encoded name and asserts it is excluded.
 * Re-verify against `~/.claude/projects/` if that test ever starts passing vacuously.
 */
const encodeProjectDir = (cwd: string): string => cwd.replaceAll(/[/.]/g, '-');

/** Project dir holding the enrichment subprocesses' own transcripts; never indexed. */
export const INDEXER_PROJECT_DIR = encodeProjectDir(INDEXER_CWD);

export interface IndexOptions {
  provenance?: Provenance;
  baseDir?: string;
  llm?: LlmRunner | false;
  onWarn?: (message: string) => void;
  /** Preview only: heuristic synth, no sidecar or transcript writes. */
  dryRun?: boolean;
  /** Re-index even if the source hash is unchanged. */
  force?: boolean;
  /**
   * Skip the claude-mem G0 probe for this record because the caller already ran it.
   *
   * The probe is two HTTP round-trips with a 3s timeout each. Paying it per record meant
   * 112,074 requests across the corpus to check one local daemon, and up to 93 hours of pure
   * timeout when that daemon was off. It answers a question about the process, not the record.
   */
  skipG0?: boolean;
  /** Skip claude-mem entirely — set when a prior probe found it unreachable. */
  skipClaudeMem?: boolean;
  /** Reports whether the LLM pass succeeded, so a batch caller can meter spend and degradation. */
  onLlmOutcome?: (outcome: { ok: boolean; error?: string }) => void;
}

export interface IndexResult {
  sessionId: string;
  title: string;
  written: boolean;
  skipped: boolean;
}

const synthOptionsFrom = (options: IndexOptions): SynthesizeOptions => {
  const synthOptions: SynthesizeOptions = {};
  if (options.dryRun) synthOptions.llm = false;
  else if (options.llm !== undefined) synthOptions.llm = options.llm;
  if (options.onWarn) synthOptions.onWarn = options.onWarn;
  if (options.onLlmOutcome) synthOptions.onLlmOutcome = options.onLlmOutcome;
  return synthOptions;
};

/** Index a single transcript file into all primary surfaces. */
/**
 * Write the record to claude-mem, honouring whatever a batch caller already decided about it.
 *
 * Secondary surface: it never throws and never blocks the sidecar or transcript writes. The two
 * flags exist so a backfill can answer "is the daemon up?" once for the whole run instead of
 * paying two HTTP round-trips per record to rediscover the same answer.
 */
const writeToClaudeMem = async (record: RecallRecord, options: IndexOptions): Promise<void> => {
  if (options.skipClaudeMem) return;
  const upsertOptions: UpsertToClaudeMemOptions = {};
  if (options.onWarn) upsertOptions.onWarn = options.onWarn;
  if (options.skipG0) upsertOptions.skipG0 = true;
  await upsertToClaudeMem(record, upsertOptions);
};

export const indexSession = async (
  filePath: string,
  sidecar: Sidecar,
  options: IndexOptions = {},
): Promise<IndexResult> => {
  const text = readFileSync(filePath, 'utf8');
  const parsed = parseTranscriptText(text, filePath);

  // Enrichment runs predating the dedicated indexer cwd are scattered across real project
  // dirs, so the dir-level skip cannot catch them. Recognize them by prompt and drop them:
  // indexing our own output yields no retrievable session and feeds the corpus back to itself.
  if (isIndexerTranscript(parsed.firstUserPrompt?.text)) {
    return { sessionId: parsed.sessionId, title: '(indexer run)', written: false, skipped: true };
  }

  const sourceHash = computeSourceHash(text);

  if (!options.force && sidecar.getSourceHash(parsed.sessionId) === sourceHash) {
    return { sessionId: parsed.sessionId, title: '(unchanged)', written: false, skipped: true };
  }

  const input = {
    parsed,
    project: projectFromPath(filePath),
    provenance: options.provenance ?? ('backfill' satisfies Provenance),
  };
  const record: RecallRecord = await synthesize(input, synthOptionsFrom(options));

  if (options.dryRun) {
    return { sessionId: parsed.sessionId, title: record.title, written: false, skipped: false };
  }

  sidecar.upsert(record, sourceHash);
  // Pass the hash of the content the record was actually synthesized from, so the writer can
  // refuse to stamp it onto a transcript the session has grown past during synthesis.
  const writeOptions: WriteOptions = { expectedSourceHash: sourceHash };
  if (options.baseDir) writeOptions.baseDir = options.baseDir;
  // `force` has to reach the writer too. It bypasses the sidecar hash check above so synthesis
  // re-runs, but the writer keeps its own idempotency check — leaving them out of step meant
  // --force spent the LLM budget and wrote nothing.
  if (options.force) writeOptions.force = true;
  const write = writeRecordToTranscript(filePath, record, writeOptions);

  // A stale-source skip is transient, not a no-op: the sidecar was updated but the transcript
  // was not, so this session needs re-indexing once it goes idle. Surfacing it is what makes
  // that recoverable — silently reporting "skipped" hides a real inconsistency between surfaces.
  if (write.skipReason === 'stale-source') {
    options.onWarn?.(
      `transcript grew during synthesis; in-transcript record not updated: ${filePath}`,
    );
  }

  await writeToClaudeMem(record, options);

  return {
    sessionId: parsed.sessionId,
    title: record.title,
    written: write.written,
    skipped: write.skipped,
  };
};

const transcriptsInDir = (dir: string): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // not a directory
  }
  return entries.filter((entry) => entry.endsWith('.jsonl')).map((entry) => path.join(dir, entry));
};

/** Enumerate every transcript under the projects root, optionally filtered by dir substring. */
export const listTranscripts = (projectsRoot: string, scope?: string): string[] => {
  const files: string[] = [];
  let directories: string[];
  try {
    directories = readdirSync(projectsRoot);
  } catch {
    return [];
  }
  for (const dir of directories) {
    if (dir === INDEXER_PROJECT_DIR) continue;
    if (scope && !dir.includes(scope)) continue;
    files.push(...transcriptsInDir(path.join(projectsRoot, dir)));
  }
  return files;
};

export interface BackfillOptions extends IndexOptions {
  projectsRoot?: string;
  scope?: string;
  limit?: number;
  onProgress?: (done: number, total: number, result: IndexResult) => void;
  /**
   * Hard ceiling on LLM calls for the run. `limit` caps files, not spend — and the two diverge
   * badly on a re-run where most files are skipped by the hash check.
   */
  maxLlmCalls?: number;
  /**
   * Abort after this many consecutive LLM failures. Defaults to 20; 0 disables.
   *
   * This is the guard that bounds a bad run regardless of cause. A failing call returns in
   * milliseconds against ~15s for a successful one, so an outage or a rate-limit storm does not
   * slow the loop down — it speeds it up, burning through the corpus and producing a fully
   * heuristic index that reports as a complete success.
   */
  maxConsecutiveLlmFailures?: number;
}

export interface BackfillSummary {
  total: number;
  processed: number;
  written: number;
  skipped: number;
  failed: number;
  /** Records whose LLM enrichment succeeded. */
  enriched: number;
  /** Records that fell back to the heuristic. `written` counts these too — they are not failures. */
  degraded: number;
  /** Set when the run stopped early; the summary describes a partial corpus. */
  abortedReason?: string;
}

const MS_PER_MINUTE = 60_000;
const G0_REPROBE_MINUTES = 5;
/** How long a claude-mem reachability verdict stays good before it is re-checked. */
const G0_REPROBE_INTERVAL_MS = G0_REPROBE_MINUTES * MS_PER_MINUTE;

/**
 * Decide once per interval — not once per record — whether claude-mem is worth writing to.
 *
 * `upsertToClaudeMem` probes G0 on every call: two HTTP round-trips, 3s timeout each. That is a
 * question about the daemon, not about the record, so asking it per session cost 112,074 requests
 * across the corpus and up to 93 hours of pure timeout whenever the daemon was simply off.
 *
 * The verdict is re-checked on a TTL rather than cached for the whole run, because a backfill can
 * outlive the outage that started it — a daemon that comes back an hour in should be picked up
 * without restarting the run.
 */
const createClaudeMemGate = (
  options: BackfillOptions,
): { decide: () => Promise<Pick<IndexOptions, 'skipG0' | 'skipClaudeMem'>> } => {
  let nextProbeAt = 0;
  let isReachable = false;
  let hasProbed = false;

  return {
    async decide() {
      const now = Date.now();
      if (now >= nextProbeAt) {
        const wasReachable = isReachable;
        const g0 = await verifyClaudeMemG0();
        isReachable = g0.pass;
        nextProbeAt = now + G0_REPROBE_INTERVAL_MS;
        // Announce only on transitions, so a long run with the daemon down logs once rather than
        // once per record — which is the noise equivalent of the cost this gate exists to remove.
        if (!isReachable && (!hasProbed || wasReachable)) {
          options.onWarn?.(
            `claude-mem unavailable (${g0.detail}); skipping that surface, re-checking in ${G0_REPROBE_INTERVAL_MS / MS_PER_MINUTE} min`,
          );
        } else if (isReachable && hasProbed && !wasReachable) {
          options.onWarn?.('claude-mem reachable again; resuming upserts');
        }
        hasProbed = true;
      }
      // Reachable: skip the per-record probe, the gate already answered. Unreachable: skip the
      // surface entirely rather than letting each record rediscover the outage.
      return isReachable ? { skipG0: true } : { skipClaudeMem: true };
    },
  };
};

const DEFAULT_MAX_CONSECUTIVE_LLM_FAILURES = 20;

/**
 * Bound a run's LLM spend and stop it when enrichment is systematically failing.
 *
 * Two independent limits, because they catch different disasters. `maxLlmCalls` caps deliberate
 * spend — `limit` counts files, which is not the same number once the hash check starts skipping
 * most of them. The consecutive-failure breaker catches the accidental kind: enrichment failure is
 * not an error here, so nothing throws, nothing increments `failed`, and a run that lost the LLM
 * entirely still reports "N processed, N written, 0 failed". Worse, it gets there sooner than a
 * healthy run would, because failures return in milliseconds and successes take seconds.
 *
 * The breaker is what would have bounded the original incident whatever its root cause — which is
 * the argument for having it independent of any particular failure mode.
 */
const createLlmBudget = (
  options: BackfillOptions,
  summary: BackfillSummary,
): {
  record: (outcome: { ok: boolean; error?: string }) => void;
  stopReason: () => string | undefined;
} => {
  const maxConsecutive = options.maxConsecutiveLlmFailures ?? DEFAULT_MAX_CONSECUTIVE_LLM_FAILURES;
  let calls = 0;
  let consecutiveFailures = 0;
  let lastError: string | undefined;

  return {
    record(outcome) {
      calls += 1;
      if (outcome.ok) {
        summary.enriched += 1;
        consecutiveFailures = 0;
        return;
      }
      summary.degraded += 1;
      consecutiveFailures += 1;
      lastError = outcome.error;
    },
    stopReason() {
      let reason: string | undefined;
      if (options.maxLlmCalls !== undefined && calls >= options.maxLlmCalls) {
        reason = `reached the --max-llm-calls ceiling of ${options.maxLlmCalls}`;
      } else if (maxConsecutive > 0 && consecutiveFailures >= maxConsecutive) {
        reason = `${consecutiveFailures} consecutive LLM failures, last: ${lastError ?? 'unknown'}`;
      }
      return reason;
    },
  };
};

const backfillOne = async (
  file: string,
  sidecar: Sidecar,
  options: BackfillOptions,
  summary: BackfillSummary,
): Promise<void> => {
  try {
    const result = await indexSession(file, sidecar, options);
    summary.processed += 1;
    if (result.written) summary.written += 1;
    if (result.skipped) summary.skipped += 1;
    options.onProgress?.(summary.processed, summary.total, result);
  } catch (error) {
    summary.failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    options.onWarn?.(`index failed for ${file}: ${message}`);
  }
};

/** Backfill many transcripts. Idempotent, resumable (re-runs skip up-to-date sessions). */
export const backfill = async (
  sidecar: Sidecar,
  options: BackfillOptions = {},
): Promise<BackfillSummary> => {
  const root = options.projectsRoot ?? defaultProjectsRoot();
  const all = listTranscripts(root, options.scope);
  const files = options.limit === undefined ? all : all.slice(0, options.limit);
  const summary: BackfillSummary = {
    total: files.length,
    processed: 0,
    written: 0,
    skipped: 0,
    failed: 0,
    enriched: 0,
    degraded: 0,
  };
  const claudeMem = createClaudeMemGate(options);
  const budget = createLlmBudget(options, summary);

  for (const file of files) {
    const stop = budget.stopReason();
    if (stop !== undefined) {
      summary.abortedReason = stop;
      options.onWarn?.(`backfill stopped after ${summary.processed}/${summary.total}: ${stop}`);
      break;
    }
    const perFile: IndexOptions = {
      ...options,
      ...(await claudeMem.decide()),
      onLlmOutcome: budget.record,
    };
    await backfillOne(file, sidecar, perFile, summary);
  }
  return summary;
};

export interface Coverage {
  total: number;
  indexed: number;
  pct: number;
}

/** Backfill coverage: how many on-disk transcripts are represented in the sidecar. */
export const coverage = (sidecar: Sidecar, projectsRoot?: string): Coverage => {
  const total = listTranscripts(projectsRoot ?? defaultProjectsRoot()).length;
  const indexed = sidecar.stats().total;
  return { total, indexed, pct: total === 0 ? 0 : indexed / total };
};
