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
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { RECALL_RECORD_TYPE, type RecallRecord } from '../record/schema.js';
import { LLM_TIMEOUT_MS } from '../record/synthesizer.js';
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
   * Rewrite even when the transcript already carries a record for this exact source hash.
   *
   * The engine has its own `force` that bypasses the *sidecar* hash check so synthesis re-runs.
   * Without this flag the writer's independent idempotency check still short-circuits, so
   * `backfill --force` paid for one LLM call per transcript and then wrote none of them,
   * reporting "0 written, N skipped". A command that reports "skipped" after spending a full
   * quota is the worst possible framing of that outcome.
   */
  force?: boolean;
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
  | (WriteOutcome & {
      written: false;
      skipped: true;
      skipReason: 'unchanged' | 'stale-source' | 'active-session';
    });

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

/** Re-read and hash the file as it exists on disk right now. */
const currentSourceHash = (filePath: string): string =>
  computeSourceHash(readFileSync(filePath, 'utf8'));

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
 * Remove a staging file whose write failed.
 *
 * The write already failed, so this cannot fail it further. It is still worth reporting: a
 * staging file that survives for a *permissions* reason means the next attempt will fail the
 * same way at `openSync`, and without this the operator sees only the second failure with no
 * indication that the first one left anything behind. (It does not block the next `renameSync` —
 * POSIX rename replaces the destination atomically, and the next write truncates the staging
 * path anyway. The signal is the permissions problem, not the file.)
 */
const discardStagingFile = (tmp: string, onWarn?: (message: string) => void): void => {
  try {
    unlinkSync(tmp);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      reportWarning(onWarn, `failed to remove partial staging file (${code ?? 'unknown'}): ${tmp}`);
    }
  }
};

/**
 * fsync the directory so the rename itself survives a crash.
 *
 * Runs *after* the commit point, so nothing here may throw: a failure would send the caller into
 * a restore path over content that is perfectly fine. Two distinct reasons it can fail, and they
 * are not the same finding:
 *
 *   - the filesystem does not implement it (tmpfs and other virtual filesystems, Windows).
 *     Kernels and Node versions disagree on the code, so `QUIET_FSYNC_CODES` covers the family
 *     and stays silent — on ext4/xfs/btrfs it simply succeeds.
 *   - everything else — EMFILE / EIO / EACCES / a path that stopped being a directory among them
 *     (illustrative, not exhaustive: any code outside the quiet set lands here). These mean
 *     durability is degrading silently, the condition nobody discovers until an incident.
 */
const fsyncParentDirectory = (filePath: string, onWarn?: (message: string) => void): void => {
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
    // `closeSync` can itself throw (EBADF, or EIO on some filesystems). Post-`renameSync` that
    // would be a throw from a *committed* write, which is exactly what this whole block exists
    // to prevent — and worse than a plain failure, because a caller with a restore path would
    // roll back content that landed correctly. Releasing the fd is best-effort like everything
    // else after the commit point.
    if (dirFd !== undefined) {
      try {
        closeSync(dirFd);
      } catch (error) {
        writeStderr(
          `failed to close directory fd after fsync (${(error as NodeJS.ErrnoException).code ?? 'unknown'}): ${filePath}`,
        );
      }
    }
  }
};

/**
 * Write via temp file + rename, durably.
 *
 * `renameSync` alone gives metadata atomicity but not durability: without fsync on the temp fd
 * there is a window where a crash leaves a zero-length or partially-written file at the real
 * path, and without fsync on the directory the rename itself may not survive. Both matter here
 * because the auto-restore path would otherwise be restoring over damaged content.
 *
 * `renameSync` is the commit point. Everything before it may fail the operation; nothing after
 * it may.
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
    if (!didStage) discardStagingFile(tmp, onWarn);
  }
  renameSync(tmp, filePath);
  fsyncParentDirectory(filePath, onWarn);
};

/**
 * How long after a transcript's last write it's still treated as possibly live.
 *
 * `renameSync` replaces the target path's inode; a process holding an append fd to the OLD
 * inode keeps writing into it forever after the rename, invisibly — the write lands nowhere
 * any path references, and the data is lost the moment that fd closes. No hash check catches
 * this, because the hash only detects content that already changed, not a write about to
 * happen. mtime recency is the only signal available without inspecting live process state, so
 * it's a heuristic, not a guarantee — double `LLM_TIMEOUT_MS`, derived rather than a second
 * hardcoded number, so the two can't silently drift apart if the timeout ever changes. A live
 * session can resume writing at any time, not just within that specific window, hence the
 * multiplier rather than an exact match.
 */
const ACTIVE_SESSION_GRACE_MULTIPLIER = 2;
const ACTIVE_SESSION_GRACE_MS = LLM_TIMEOUT_MS * ACTIVE_SESSION_GRACE_MULTIPLIER;

/**
 * Whether `filePath`'s mtime is recent enough to be possibly live. A heuristic, not a
 * guarantee -- and the only piece of the liveness check that our own prior write can trigger
 * a false positive on, since writing IS what sets mtime.
 */
const hasRecentMtime = (filePath: string): boolean => {
  try {
    return Date.now() - statSync(filePath).mtimeMs < ACTIVE_SESSION_GRACE_MS;
  } catch (error) {
    // ENOENT is the one case that's actually safe to treat as idle: the file is gone, so there's
    // nothing to race against. Anything else (EACCES, a transient I/O error) is anomalous at this
    // point -- the caller already read this same path successfully moments earlier in this same
    // call -- and this heuristic's whole job is to be cautious, so an error it can't explain
    // means "possibly active", not "definitely not".
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
};

/**
 * Whether `filePath` might belong to a session that's still running.
 *
 * Scoped to non-`forward` provenance only by the caller: a `forward` write is triggered by
 * `SessionEnd`, which by definition fires after that session's own process has exited — its
 * transcript always has a fresh mtime and is never live, so applying this check there would
 * skip every ordinary forward-capture write. The risk this guards against is backfill or a
 * manual re-index sweeping a transcript that belongs to a *different*, currently-running
 * session (another terminal, a resumed `--continue`) that this process has no other way to see.
 *
 * `isMtimeCheckExempt` exempts only the heuristic half, not the `CLAUDE_SESSION_ID` match: our own
 * prior write can produce a false-positive fresh mtime, but it can never produce a false-positive
 * *session ID* match — that signal is definitive and Claude Code's, not something cc-recall's own
 * write could cause. Suppressing it too would mean a `--force` repair of a transcript belonging
 * to the session literally invoking us right now goes unguarded.
 */
const isPossiblyActive = (
  filePath: string,
  sessionId: string,
  isMtimeCheckExempt: boolean,
): boolean => {
  if (process.env.CLAUDE_SESSION_ID === sessionId) return true;
  if (isMtimeCheckExempt) return false;
  return hasRecentMtime(filePath);
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
/**
 * Every reason `writeRecordToTranscript` can decline before attempting the write, in priority
 * order. `undefined` means proceed.
 *
 * `unchanged`/`stale-source` are precise, hash-confirmed diagnoses; `active-session` is a
 * weaker heuristic guess and is checked last so a confirmed reason always wins when both apply
 * (e.g. a live append that already changed the content reports `stale-source`, not the vaguer
 * `active-session`, even though the fresh mtime would also match).
 */
const preWriteSkipReason = (
  filePath: string,
  record: RecallRecord,
  options: WriteOptions,
  sourceHash: string,
  isUnchangedByUs: boolean,
): WriteResult['skipReason'] | undefined => {
  if (!options.force && isUnchangedByUs) return 'unchanged';
  // No `!options.force` guard here, unlike `unchanged` above: `force` means "write even if the
  // sidecar thinks this is already indexed," not "write even over content newer than what was
  // synthesized." Those are different questions -- force never bypasses a confirmed mismatch.
  if (options.expectedSourceHash !== undefined && options.expectedSourceHash !== sourceHash) {
    return 'stale-source';
  }
  // `forward` writes are triggered by SessionEnd, whose transcript is never live by the time the
  // hook fires — skip the liveness heuristic there so it can't skip an ordinary write. Everything
  // else (backfill, manual) can be sweeping a transcript that belongs to a session running
  // somewhere else entirely, which no hash check can see coming. The mtime half is skipped when
  // `isUnchangedByUs`: a `force` re-write of content cc-recall already wrote is not a liveness
  // risk just because *our own* prior write left a fresh mtime behind. The session-ID half is
  // never skipped -- see isPossiblyActive's doc comment for why.
  if (
    record.provenance !== 'forward' &&
    isPossiblyActive(filePath, record.session_id, isUnchangedByUs)
  ) {
    return 'active-session';
  }
  return undefined;
};

/**
 * Stage, commit, and verify the write, backup/snapshot bookkeeping included.
 * Assumes every pre-write skip check has already passed.
 */
interface CommitWriteInput {
  filePath: string;
  record: RecallRecord;
  kept: readonly string[];
  sourceHash: string;
  backupPath: string;
  origErrors: number;
  options: WriteOptions;
}

const commitWrite = ({
  filePath,
  record,
  kept,
  sourceHash,
  backupPath,
  origErrors,
  options,
}: CommitWriteInput): WriteResult => {
  ensureOriginalBackup(filePath, backupPath);
  const snapshot = takePreWriteSnapshot(filePath);
  try {
    // ensureOriginalBackup/takePreWriteSnapshot are themselves filesystem I/O with nonzero
    // duration, so re-check right before the write that nothing landed since the hash was
    // computed above -- the narrowest this window gets without OS-level locking this module
    // doesn't have.
    if (currentSourceHash(filePath) !== sourceHash) {
      return { written: false, skipped: true, skipReason: 'stale-source', sourceHash, backupPath };
    }
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
  // True when the file's content is exactly what cc-recall itself last wrote for it -- the
  // ordinary idempotent case, `force` or not. Decides whether a fresh mtime means "possibly
  // live" or just "we wrote this a moment ago", which `force` alone can't tell.
  const isUnchangedByUs = hadRecallRecord && markerHash === sourceHash;

  // Claude Code appends to live transcripts while we work. This function does read the file
  // once above, to compute `sourceHash` for the idempotency check — what it deliberately does
  // not do is re-read to compare here, because the dangerous window is not inside this function.
  // It spans the caller's read, synthesis (up to the LLM timeout), and this write, so that guard
  // belongs at the caller level via `expectedSourceHash` (checked in `preWriteSkipReason`): the
  // record must have been synthesized from the content at that hash, not an older snapshot.
  // `didRevertTranscript` re-reads and compares for the same reason it's safe to there and not
  // here — its window is synchronous and bounded; this one contains an LLM call.
  const skipReason = preWriteSkipReason(filePath, record, options, sourceHash, isUnchangedByUs);
  if (skipReason !== undefined) {
    return { written: false, skipped: true, skipReason, sourceHash, backupPath };
  }

  const origErrors = parseTranscriptText(original, filePath).parseErrors;
  return commitWrite({ filePath, record, kept, sourceHash, backupPath, origErrors, options });
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
    // Restore is best-effort and must not become the error the caller sees. If the snapshot copy
    // fails too — the disk that killed the write is often the same disk — throwing that instead
    // would replace the root cause with its own symptom, and the operator loses the only line
    // that explains what actually happened.
    try {
      copyFileSync(snapshot, filePath);
    } catch (restoreError) {
      // Both paths are named because this warning may be the only artifact that survives: the
      // snapshot is discarded in `finally` either way, and if the throw below is caught higher
      // up, this line is all the operator gets.
      reportWarning(
        options.onWarn,
        `restore after failed strip also failed, transcript may be partially written: ${filePath} (snapshot: ${snapshot}; write failed with: ${String(error)}; restore failed with: ${String(restoreError)})`,
      );
    }
    throw error;
  } finally {
    discardSnapshot(snapshot, options.onWarn);
  }
  return true;
};
