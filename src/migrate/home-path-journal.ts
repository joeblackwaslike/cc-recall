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
  OP_COMPLETE,
  OP_DIR_MOVE,
  OP_FAILURE,
  OP_FILE_MERGE,
  OP_FILE_REWRITE,
} from './home-path-types.js';

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number';

/**
 * `JSON.parse` only checks syntax — a syntactically valid line like `{"op":"dir-move"}` (missing
 * `to`) parses cleanly but produces an entry with `undefined` fields that blow up downstream
 * (e.g. `path.dirname(undefined)` inside a restore call) with no indication the journal was
 * corrupted. Validate each op's required fields before trusting the cast.
 */
const isValidJournalEntry = (value: unknown): value is JournalEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.op) {
    case OP_BEGIN:
    case OP_DIR_MOVE:
    case OP_FILE_MERGE: {
      return isString(v.from) && isString(v.to) && isNumber(v.ts);
    }
    case OP_FILE_REWRITE: {
      return isString(v.file) && isNumber(v.count) && isNumber(v.ts);
    }
    case OP_FAILURE: {
      return isString(v.stage) && isString(v.target) && isString(v.error) && isNumber(v.ts);
    }
    case OP_COMPLETE: {
      return isNumber(v.ts) && isNumber(v.failures);
    }
    default: {
      return false;
    }
  }
};

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
 * scenario this journal exists to survive. `appendJournal` always writes `<json>\n`, so a
 * *fully* written entry always ends the file in a newline; the only way the file's last
 * character can be something else is a write cut off mid-flight. Tolerance for an unparsable
 * line therefore requires BOTH that it's the last line AND that the file doesn't end in `\n` —
 * a newline-terminated last line was completely written, so a parse failure on it is real
 * corruption (disk error, a bug), not truncation, same as everywhere else. Shape-validation
 * failures are never tolerated regardless of position: truncation breaks JSON syntax, it
 * doesn't produce valid-but-wrong-shape JSON.
 */
const parseJournalLines = (text: string): JournalEntry[] => {
  const wasTruncated = !text.endsWith('\n');
  const rawLines = text.split('\n').filter((line) => line.trim() !== '');
  const entries: JournalEntry[] = [];
  for (const [index, raw] of rawLines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      if (wasTruncated && index === rawLines.length - 1) continue;
      throw new Error(`migrate journal is corrupted at line ${index + 1}: ${raw}`, {
        cause: error,
      });
    }
    if (!isValidJournalEntry(parsed)) {
      throw new Error(`migrate journal is corrupted at line ${index + 1}: ${raw}`);
    }
    entries.push(parsed);
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
