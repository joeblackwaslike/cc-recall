// Rebuilding a `MigrateManifest` from `home-path.ts`'s append-only journal, for when the final
// manifest write never happened (killed mid-run). Split out from home-path.ts as its own,
// self-contained concern: given journal text, reconstruct the manifest arrays — no filesystem
// access, no destructive operations.
import {
  type DirMove,
  type FileMerge,
  type FileRewrite,
  type JournalEntry,
  type MigrateFailure,
  type MigrateManifest,
  OP_BEGIN,
  OP_DIR_MOVE,
  OP_FAILURE,
  OP_FILE_MERGE,
  OP_FILE_REWRITE,
} from './home-path-types.js';

interface JournalAccumulator {
  dirMoves: DirMove[];
  fileMerges: FileMerge[];
  rewrites: FileRewrite[];
  failures: MigrateFailure[];
}

/** Fold one journal line into the in-progress manifest arrays; `begin`/`complete` are ignored. */
const applyJournalLine = (line: JournalEntry, accumulator: JournalAccumulator): void => {
  switch (line.op) {
    case OP_DIR_MOVE: {
      accumulator.dirMoves.push({ from: line.from, to: line.to });
      break;
    }
    case OP_FILE_MERGE: {
      // Always false, correctly: mergeDir only renames (and journals) the non-collision
      // branch — a collision is skipped and never reaches appendJournal — so every
      // journaled file-merge line represents an actual, real rename.
      accumulator.fileMerges.push({ from: line.from, to: line.to, collision: false });
      break;
    }
    case OP_FILE_REWRITE: {
      accumulator.rewrites.push({ file: line.file, count: line.count });
      break;
    }
    case OP_FAILURE: {
      accumulator.failures.push({ stage: line.stage, target: line.target, error: line.error });
      break;
    }
    default: {
      break;
    }
  }
};

/**
 * A crash mid-`appendFileSync` can leave a truncated, unparsable trailing line — exactly the
 * scenario this journal exists to survive. Only the trailing line gets this tolerance: a
 * malformed line anywhere earlier means real corruption (disk error, a bug), not a graceful
 * mid-append crash, and must surface as an error rather than silently recovering a subset of
 * the migration with no indication anything was skipped.
 */
const parseJournalLines = (text: string): JournalEntry[] => {
  const rawLines = text.split('\n').filter((line) => line.trim() !== '');
  const entries: JournalEntry[] = [];
  for (const [index, raw] of rawLines.entries()) {
    try {
      entries.push(JSON.parse(raw) as JournalEntry);
    } catch (error) {
      if (index === rawLines.length - 1) continue;
      throw new Error(`migrate journal is corrupted at line ${index + 1}: ${raw}`, {
        cause: error,
      });
    }
  }
  return entries;
};

/**
 * Rebuild a manifest from the append-only journal. `begin` supplies `from`/`to`;
 * `dir-move`/`file-merge`/`file-rewrite`/`failure` lines populate the manifest arrays via
 * `applyJournalLine`; `begin`/`complete` are ignored beyond that — no special-casing of
 * partial-vs-complete is needed, since `restoreRewrites`/`restoreMerges`/`restoreMoves` (in
 * home-path.ts) are already idempotent and `existsSync`-guarded.
 */
export const manifestFromJournal = (text: string): MigrateManifest => {
  const lines = parseJournalLines(text);
  const begin = lines.find((line) => line.op === OP_BEGIN);
  if (!begin) throw new Error('migrate journal is missing its begin entry');

  const dirMoves: DirMove[] = [];
  const fileMerges: FileMerge[] = [];
  const rewrites: FileRewrite[] = [];
  const failures: MigrateFailure[] = [];
  for (const line of lines) {
    applyJournalLine(line, { dirMoves, fileMerges, rewrites, failures });
  }
  return {
    from: begin.from,
    to: begin.to,
    dryRun: false,
    dirMoves,
    fileMerges,
    rewrites,
    failures,
  };
};
