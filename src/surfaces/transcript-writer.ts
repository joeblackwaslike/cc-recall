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
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
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
const PREWRITE_SUFFIX = '.prewrite';

export const defaultBaseDir = (): string => path.join(homedir(), '.claude', 'cc-recall');

const isValidSessionId = (id: string): boolean => /^[a-zA-Z0-9_-]+$/.test(id);

export const backupPathFor = (sessionId: string, baseDir = defaultBaseDir()): string => {
  if (!isValidSessionId(sessionId)) throw new Error(`invalid session ID: ${sessionId}`);
  return path.join(baseDir, 'backups', `${sessionId}.jsonl`);
};

export interface WriteOptions {
  /** Base dir for backups; defaults to ~/.claude/cc-recall. */
  baseDir?: string;
  /**
   * Revert only: restore the pristine pre-cc-recall snapshot rather than stripping our lines
   * from the current file. Lossy for any session that has grown since it was first indexed.
   */
  fromOriginalBackup?: boolean;
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

/**
 * First-ever snapshot: what the transcript looked like before cc-recall touched it.
 *
 * Written once and never refreshed, which is correct for its purpose (an archival record of
 * the pristine file) but makes it unsafe as a restore target — see `takePreWriteSnapshot`.
 */
const ensureOriginalBackup = (filePath: string, backupPath: string): void => {
  if (existsSync(backupPath)) return;
  mkdirSync(path.dirname(backupPath), { recursive: true });
  copyFileSync(filePath, backupPath);
};

/**
 * Snapshot of the file as it exists for THIS write, used by the integrity auto-restore.
 *
 * Restoring the first-ever backup would roll a resumed session back to whatever it contained
 * the first time cc-recall saw it — for a session indexed at 400 lines and resumed to 1,900,
 * that silently destroys 1,500 lines of real conversation while reporting "restored from
 * backup" as though it were the safe outcome.
 */
const takePreWriteSnapshot = (filePath: string, backupPath: string): string => {
  const snapshot = `${backupPath}${PREWRITE_SUFFIX}`;
  mkdirSync(path.dirname(snapshot), { recursive: true });
  copyFileSync(filePath, snapshot);
  return snapshot;
};

const discardSnapshot = (snapshot: string): void => {
  try {
    unlinkSync(snapshot);
  } catch {
    /* best effort — a stray snapshot is harmless, and failing here would mask the real result */
  }
};

/**
 * Write via temp file + rename, durably.
 *
 * `renameSync` alone gives metadata atomicity but not durability: without fsync on the temp
 * fd there is a window where a crash leaves a zero-length or partially-written file at the
 * real path, and without fsync on the directory the rename itself may not survive. Both
 * matter here because the auto-restore path would then be restoring over damaged content.
 */
const atomicWrite = (filePath: string, content: string): void => {
  const tmp = `${filePath}${TMP_SUFFIX}`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
  const dir = openSync(path.dirname(filePath), 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
};

const isIntegrityValid = (filePath: string, record: RecallRecord, origErrors: number): boolean => {
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
  ensureOriginalBackup(filePath, backupPath);

  // Claude Code appends to live transcripts, and synthesis can sit between the read above and
  // this point for as long as the LLM timeout allows. Anything appended in that window would
  // be silently discarded, since `kept` was derived from the earlier read. Re-read and bail if
  // the file moved; the caller can retry once the session is idle.
  const current = readFileSync(filePath, 'utf8');
  if (current !== original) {
    return { written: false, skipped: true, sourceHash, backupPath };
  }

  const snapshot = takePreWriteSnapshot(filePath, backupPath);
  atomicWrite(filePath, buildContent(kept, record, sourceHash));

  if (!isIntegrityValid(filePath, record, origErrors)) {
    copyFileSync(snapshot, filePath); // restore what we read, not the first-ever backup
    discardSnapshot(snapshot);
    throw new Error(`integrity check failed for ${record.session_id}; restored pre-write state`);
  }
  discardSnapshot(snapshot);
  return { written: true, skipped: false, sourceHash, backupPath };
};

/** Whether the file carries a cc-recall record belonging to this session. */
const hasRecordFor = (text: string, sessionId: string): boolean =>
  text.split('\n').some((line) => {
    if (!line.includes(RECALL_RECORD_TYPE)) return false;
    try {
      const parsed: unknown = JSON.parse(line);
      return (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { type?: unknown }).type === RECALL_RECORD_TYPE &&
        (parsed as { session_id?: unknown }).session_id === sessionId
      );
    } catch {
      return false;
    }
  });

/**
 * Remove cc-recall's injected lines from a transcript. Returns false if there was nothing
 * of ours to remove, or if the record present belongs to a different session.
 *
 * This strips from the CURRENT file rather than restoring a snapshot. Restoring the
 * first-ever backup would roll the transcript back to whatever it contained when cc-recall
 * first saw it, discarding every message the session has accumulated since — for a resumed
 * session that is weeks of conversation. Stripping is exact regardless of how much the file
 * has grown, because `classify` already isolates precisely the lines we added.
 *
 * `fromOriginalBackup` restores the pristine pre-cc-recall snapshot instead. It is opt-in and
 * lossy by construction; use it only to reconstruct the original file, never to undo a write.
 */
export const didRevertTranscript = (
  filePath: string,
  sessionId: string,
  options: WriteOptions = {},
): boolean => {
  if (options.fromOriginalBackup) {
    const backupPath = backupPathFor(sessionId, options.baseDir ?? defaultBaseDir());
    if (!existsSync(backupPath)) return false;
    copyFileSync(backupPath, filePath);
    return true;
  }

  const current = readFileSync(filePath, 'utf8');
  if (!hasRecordFor(current, sessionId)) return false;
  const { kept } = classify(current);
  atomicWrite(filePath, kept.length === 0 ? '' : `${kept.join('\n')}\n`);
  return true;
};
