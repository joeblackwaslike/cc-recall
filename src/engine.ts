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
import { upsertToClaudeMem } from './surfaces/claude-mem.js';
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
  return synthOptions;
};

/** Index a single transcript file into all primary surfaces. */
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
  const write = writeRecordToTranscript(filePath, record, writeOptions);

  // A stale-source skip is transient, not a no-op: the sidecar was updated but the transcript
  // was not, so this session needs re-indexing once it goes idle. Surfacing it is what makes
  // that recoverable — silently reporting "skipped" hides a real inconsistency between surfaces.
  if (write.skipReason === 'stale-source') {
    options.onWarn?.(
      `transcript grew during synthesis; in-transcript record not updated: ${filePath}`,
    );
  }

  await upsertToClaudeMem(record, { onWarn: options.onWarn });

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
}

export interface BackfillSummary {
  total: number;
  processed: number;
  written: number;
  skipped: number;
  failed: number;
}

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
  };
  for (const file of files) await backfillOne(file, sidecar, options, summary);
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
