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
/** Owner-only: the temp file holds conversation history until the rename replaces the target. */
const TMP_FILE_MODE = 0o600;

/**
 * Errno codes meaning "this filesystem or platform does not support directory fsync" — an
 * expected absence of a durability nicety, not a degradation worth reporting. Kernels and
 * Node versions disagree on which of these they surface for the same condition, so the whole
 * family is treated as quiet; anything outside it means durability is silently degrading.
 */
const QUIET_FSYNC_CODES = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS']);

const writeStderr = (message: string): void => {
  try {
    process.stderr.write(`cc-recall: ${message}\n`);
  } catch {
    /* stderr can be closed or already EPIPE'd; there is no channel below this one */
  }
};

/**
 * Deliver a non-fatal warning without ever becoming one.
 *
 * Every call site runs *after* the write has committed, so a throw here would fail an operation
 * that already succeeded — the exact failure those call sites exist to prevent. Two ways that
 * could happen are both closed off: an absent `onWarn` falls back to stderr rather than dropping
 * the message, and a throwing `onWarn` is reported rather than propagated. A warn channel that
 * fails silently is the one defect guaranteed to erase its own evidence.
 */
const reportWarning = (onWarn: ((message: string) => void) | undefined, message: string): void => {
  if (onWarn) {
    try {
      onWarn(message);
      return;
    } catch (error) {
      writeStderr(`warn channel threw (${String(error)}) while reporting: ${message}`);
      return;
    }
  }
  writeStderr(message);
};

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
  /**
   * Source hash of the content the record was synthesized from. When it no longer matches the
   * file, the write is skipped: the caller read the transcript, spent time building the record,
   * and the session has appended since. Writing anyway would stamp the *current* hash onto a
   * record describing older content, and the next run's idempotency check would then match and
   * skip — leaving the in-transcript record permanently stale while the sidecar moved on.
   *
   * Any caller that reads the transcript before calling this should pass it, not only
   * asynchronous ones — a long synchronous gap has the same effect. Omitting it disables the
   * check entirely, which is why `indexSession` always supplies it.
   */
  expectedSourceHash?: string;
  /**
   * Called when an operation declines to act for a reason the caller would otherwise be unable
   * to distinguish from an ordinary no-op — currently the revert path bailing on a concurrent
   * modification, which returns the same `false` as "no record found".
   */
  onWarn?: (message: string) => void;
  /**
   * Integrity predicate, injectable so the restore path can be exercised. Mirrors the
   * `SynthesizeOptions.llm` seam. Without it the most safety-critical branch in this module —
   * what a failed write restores — is unreachable from a test, which is precisely the branch
   * that used to roll a resumed session back to its first-indexed state.
   */
  verifyIntegrity?: (filePath: string, record: RecallRecord, origErrors: number) => boolean;
}

interface WriteOutcome {
  sourceHash: string;
  backupPath: string;
}

/**
 * A write either happened or was skipped for a stated reason — never both, and never neither.
 *
 * Modelled as a union rather than a record with an optional `skipReason` so the reason cannot
 * be read off a successful write: `unchanged` is the ordinary idempotent no-op, `stale-source`
 * means the record described content the transcript has since grown past and the session needs
 * re-indexing. Those demand different handling, and an optional field on a flat shape lets a
 * caller check `skipReason` on a `written: true` result and silently get `undefined` forever.
 */
export type WriteResult =
  | (WriteOutcome & { written: true; skipped: false; skipReason?: never })
  | (WriteOutcome & { written: false; skipped: true; skipReason: 'unchanged' | 'stale-source' });

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
 * Written once and never refreshed — it is an archival record of the pristine file, not a
 * restore target. Restoring it would roll a resumed session back to its first-indexed state;
 * `takePreWriteSnapshot` is what the auto-restore path uses instead.
 */
const ensureOriginalBackup = (filePath: string, backupPath: string): void => {
  if (existsSync(backupPath)) return;
  mkdirSync(path.dirname(backupPath), { recursive: true });
  copyFileSync(filePath, backupPath);
};

/**
 * Snapshot of the file as it exists for THIS write, used by the integrity auto-restore.
 *
 * For a session that has grown since it was first indexed, restoring the original backup would
 * destroy every turn accumulated since — while reporting "restored from backup" as though that
 * were the safe outcome. Snapshotting the current file makes the restore exact regardless of
 * how far the session has moved on.
 *
 * Kept beside the transcript rather than in the backups directory: the snapshot belongs to one
 * in-flight write, has the same lifetime as the temp file `atomicWrite` puts there, and derives
 * from the path it protects instead of depending on the shape of an unrelated backup path.
 */
const takePreWriteSnapshot = (filePath: string): string => {
  const snapshot = `${filePath}${PREWRITE_SUFFIX}`;
  copyFileSync(filePath, snapshot);
  return snapshot;
};

/**
 * Remove a pre-write snapshot. ENOENT means it was already gone, which is the expected outcome
 * on the paths that discard eagerly. Anything else — EACCES, EROFS — means the snapshot is
 * still on disk and will accumulate, so it is reported rather than swallowed.
 */
const discardSnapshot = (snapshot: string, onWarn?: (message: string) => void): void => {
  try {
    unlinkSync(snapshot);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      reportWarning(
        onWarn,
        `failed to remove pre-write snapshot (${code ?? 'unknown'}): ${snapshot}`,
      );
    }
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
const atomicWrite = (
  filePath: string,
  content: string,
  onWarn?: (message: string) => void,
): void => {
  const tmp = `${filePath}${TMP_SUFFIX}`;
  // An explicit mode rather than the process umask: between this open and the rename there is a
  // real file holding conversation history, and the default umask would leave it group- or
  // world-readable for that window. `'w'` truncates at open, so `writeFileSync(fd, ...)` writes
  // from position 0 — and unlike the path overload it does not close the fd, which is why
  // `finally` does.
  const fd = openSync(tmp, 'w', TMP_FILE_MODE);
  let didStage = false;
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
    didStage = true;
  } finally {
    closeSync(fd);
    if (!didStage) {
      // A partial temp file would otherwise sit at a predictable path until the next write
      // happened to overwrite it — no data loss, but it survives as a plausible-looking file.
      try {
        unlinkSync(tmp);
      } catch {
        /* the write already failed; there is nothing more useful to do here */
      }
    }
  }
  renameSync(tmp, filePath);

  // `renameSync` above is the commit point: the content is visible at the real path. Everything
  // below is a durability nicety, so *nothing* here may fail the operation — a throw would send
  // the caller into the restore path over content that is fine. That applies to `openSync` as
  // much as `fsyncSync`: a missing or unreadable directory is a reason to skip the fsync, not to
  // undo a committed write. `dirFd` is only closed when it was actually opened, so a failed open
  // can neither leak nor double-close.
  //
  // Two distinct reasons the fsync can fail, and they are not the same finding:
  //   - the filesystem does not implement it (tmpfs and other virtual filesystems, Windows).
  //     Kernels and Node versions disagree on the code, so `QUIET_FSYNC_CODES` covers the family
  //     and stays silent — on ext4/xfs/btrfs it simply succeeds.
  //   - everything else, EMFILE / EIO / EACCES / a path that stopped being a directory among
  //     them (an illustrative list, not an exhaustive one — any code outside the quiet set lands
  //     here). These mean durability is degrading silently, which is exactly the condition
  //     nobody discovers until an incident.
  let dirFd: number | undefined;
  try {
    dirFd = openSync(path.dirname(filePath), 'r');
    fsyncSync(dirFd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // `?? ''` deliberately makes an absent code *not* quiet: an error that arrives without one
    // is unclassifiable, and unclassifiable is not the same as known-benign.
    if (!QUIET_FSYNC_CODES.has(code ?? '')) {
      reportWarning(
        onWarn,
        `directory fsync failed (${code ?? 'unknown'}), write committed but not durable: ${filePath}`,
      );
    }
  } finally {
    if (dirFd !== undefined) closeSync(dirFd);
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
    return { written: false, skipped: true, skipReason: 'unchanged', sourceHash, backupPath };
  }

  // Claude Code appends to live transcripts while we work. This function does read the file
  // once above, to compute `sourceHash` for the idempotency check — what it deliberately does
  // not do is re-read to compare, because the dangerous window is not inside this function. It
  // spans the caller's read, synthesis (up to the LLM timeout), and this write, so the guard
  // belongs at the caller level via `expectedSourceHash`: the record must have been synthesized
  // from the content at that hash, not from an older snapshot.
  if (options.expectedSourceHash !== undefined && options.expectedSourceHash !== sourceHash) {
    return { written: false, skipped: true, skipReason: 'stale-source', sourceHash, backupPath };
  }

  const origErrors = parseTranscriptText(original, filePath).parseErrors;
  ensureOriginalBackup(filePath, backupPath);
  const snapshot = takePreWriteSnapshot(filePath);
  try {
    atomicWrite(filePath, buildContent(kept, record, sourceHash), options.onWarn);

    const verify = options.verifyIntegrity ?? isIntegrityValid;
    if (!verify(filePath, record, origErrors)) {
      copyFileSync(snapshot, filePath); // restore what we read, not the first-ever backup
      throw new Error(`integrity check failed for ${record.session_id}; restored pre-write state`);
    }
  } finally {
    // Also runs when atomicWrite itself throws (disk full, EACCES), so a failed write does not
    // leave a .prewrite file behind beside the transcript it shadows.
    discardSnapshot(snapshot, options.onWarn);
  }
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

  // Same race as the write path: a live session can append between this read and the write,
  // and `kept` was derived from the earlier content. Re-read and bail rather than rebuilding
  // the file from a stale view — the caller can revert again once the session is idle.
  //
  // This returns the same `false` as "no record for this session", which are very different
  // outcomes: one means nothing to do, the other means try again shortly. `onWarn` is what
  // separates them, so a caller is not left guessing which it hit.
  if (readFileSync(filePath, 'utf8') !== current) {
    reportWarning(
      options.onWarn,
      `transcript changed while reverting; left untouched: ${filePath}`,
    );
    return false;
  }

  // The write path snapshots before calling atomicWrite so a mid-write failure has somewhere to
  // restore from; stripping is a write like any other, and was the one path here without that
  // protection. `kept` is the whole file minus our lines, so a failure that left the transcript
  // half-rewritten would take real conversation with it.
  const snapshot = takePreWriteSnapshot(filePath);
  try {
    atomicWrite(filePath, kept.length === 0 ? '' : `${kept.join('\n')}\n`, options.onWarn);
  } catch (error) {
    copyFileSync(snapshot, filePath);
    throw error;
  } finally {
    discardSnapshot(snapshot, options.onWarn);
  }
  return true;
};
