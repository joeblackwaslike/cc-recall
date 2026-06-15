// cc-recall — in-transcript edit-in-place (spec §8②, §13: safety-critical).
//
// Non-destructively injects a `recall-record` line and a cc-recall-owned `ai-title`
// marker into a session transcript. Every edit is:
//   - backed up before the first write (never edit without a backup),
//   - idempotent by source-content hash (re-running an unchanged source is a no-op),
//   - atomic (write to a temp file, then rename), and
//   - integrity-checked (re-parse the whole file; auto-restore the backup on failure).
// The sidecar is fully rebuildable from transcripts, so this is never a single point
// of data loss — but we still treat it as the highest-risk component.

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { RECALL_RECORD_TYPE, type RecallRecord } from '../record/schema.js';
import { parseTranscriptText } from '../transcript/parse.js';

/** Marker stamped on the ai-title record we own, so re-runs replace (not duplicate) it. */
const MARKER_SOURCE = 'cc-recall';
const AI_TITLE_TYPE = 'ai-title';
const TMP_SUFFIX = '.cc-recall-tmp';

export const defaultBaseDir = (): string => path.join(homedir(), '.claude', 'cc-recall');

export const backupPathFor = (sessionId: string, baseDir = defaultBaseDir()): string =>
  path.join(baseDir, 'backups', `${sessionId}.jsonl`);

export interface WriteOptions {
  /** Base dir for backups; defaults to ~/.claude/cc-recall. */
  baseDir?: string;
}

export interface WriteResult {
  written: boolean;
  /** True when the source was unchanged since the last write (no-op). */
  skipped: boolean;
  sourceHash: string;
  backupPath: string;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

interface Classified {
  /** Original non-injected lines, verbatim and in order. */
  kept: string[];
  hadRecallRecord: boolean;
  /** Source hash embedded in our existing ai-title marker, if any. */
  markerHash: string | undefined;
}

const applyLine = (line: string, accumulator: Classified): void => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let value: { type?: unknown; source?: unknown; sourceHash?: unknown };
  try {
    value = JSON.parse(trimmed) as typeof value;
  } catch {
    accumulator.kept.push(line); // preserve unparseable lines verbatim — never lose data
    return;
  }
  if (value.type === RECALL_RECORD_TYPE) {
    accumulator.hadRecallRecord = true;
  } else if (value.type === AI_TITLE_TYPE && value.source === MARKER_SOURCE) {
    if (typeof value.sourceHash === 'string') accumulator.markerHash = value.sourceHash;
  } else {
    accumulator.kept.push(line);
  }
};

const classify = (text: string): Classified => {
  const accumulator: Classified = { kept: [], hadRecallRecord: false, markerHash: undefined };
  for (const line of text.split('\n')) applyLine(line, accumulator);
  return accumulator;
};

/**
 * Hash of the transcript's source content, excluding cc-recall's injected lines.
 * Stable across our own edits, so callers can skip unchanged sessions before
 * paying for synthesis.
 */
export const computeSourceHash = (text: string): string => sha256(classify(text).kept.join('\n'));

const buildContent = (
  kept: readonly string[],
  record: RecallRecord,
  sourceHash: string,
): string => {
  const marker = JSON.stringify({
    type: AI_TITLE_TYPE,
    sessionId: record.session_id,
    aiTitle: record.title,
    source: MARKER_SOURCE,
    sourceHash,
  });
  return `${[...kept, marker, JSON.stringify(record)].join('\n')}\n`;
};

const ensureBackup = (filePath: string, backupPath: string): void => {
  if (existsSync(backupPath)) return;
  mkdirSync(path.dirname(backupPath), { recursive: true });
  copyFileSync(filePath, backupPath);
};

const atomicWrite = (filePath: string, content: string): void => {
  const tmp = `${filePath}${TMP_SUFFIX}`;
  writeFileSync(tmp, content);
  renameSync(tmp, filePath);
};

const passesIntegrity = (filePath: string, record: RecallRecord, origErrors: number): boolean => {
  const reparsed = parseTranscriptText(readFileSync(filePath, 'utf8'), filePath);
  return (
    reparsed.parseErrors === origErrors &&
    reparsed.aiTitle === record.title &&
    reparsed.records.some((entry) => entry.type === RECALL_RECORD_TYPE)
  );
};

/**
 * Inject (or replace) the cc-recall record + title in a transcript, safely.
 * Returns `{ skipped: true }` when the source is unchanged since the last write.
 */
export const writeRecordToTranscript = (
  filePath: string,
  record: RecallRecord,
  options: WriteOptions = {},
): WriteResult => {
  const baseDir = options.baseDir ?? defaultBaseDir();
  const backupPath = backupPathFor(record.session_id, baseDir);
  const original = readFileSync(filePath, 'utf8');
  const { kept, hadRecallRecord, markerHash } = classify(original);
  const sourceHash = sha256(kept.join('\n'));

  if (hadRecallRecord && markerHash === sourceHash) {
    return { written: false, skipped: true, sourceHash, backupPath };
  }

  const origErrors = parseTranscriptText(original, filePath).parseErrors;
  ensureBackup(filePath, backupPath);
  atomicWrite(filePath, buildContent(kept, record, sourceHash));

  if (!passesIntegrity(filePath, record, origErrors)) {
    copyFileSync(backupPath, filePath); // auto-restore
    throw new Error(`integrity check failed for ${record.session_id}; restored from backup`);
  }
  return { written: true, skipped: false, sourceHash, backupPath };
};

/** Restore a transcript from its backup. Returns false if no backup exists. */
export const revertTranscript = (
  filePath: string,
  sessionId: string,
  options: WriteOptions = {},
): boolean => {
  const backupPath = backupPathFor(sessionId, options.baseDir ?? defaultBaseDir());
  if (!existsSync(backupPath)) return false;
  copyFileSync(backupPath, filePath);
  return true;
};
