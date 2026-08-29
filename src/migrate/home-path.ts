// cc-recall — Phase 0 home-path normalization (spec §P0, §13).
//
// When the home dir moves (e.g. /Users/joeblack → /Users/joe), every `~/.claude/
// projects/<encoded-cwd>/` slug for the old home becomes invisible from the live tree.
// This consolidates identity in two layers, both safe (dry-run default, backups,
// manifest, reversible):
//   1. directory slug: `-Users-joeblack-<rest>` → `-Users-joe-<rest>`, merging into an
//      existing new-home dir when present (UUIDs are unique, so no filename clash), and
//   2. in-transcript paths: rewrite `/Users/joeblack/…` → `/Users/joe/…` so tools that
//      read `cwd` resolve into the live tree.
//
// Resilience: every destructive op (dir move, file merge, file rewrite) is individually
// try/caught and appended to a `migrate-journal.jsonl` as it completes, so a throw partway
// through a run never aborts the whole migration and never leaves zero record of what
// happened — `revertHomePaths` can rebuild a manifest from the journal alone if the final
// manifest write never happened.

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../surfaces/transcript-writer.js';
import { parseTranscriptText } from '../transcript/parse.js';

const DEFAULT_FROM = '/Users/joeblack';
const DEFAULT_TO = '/Users/joe';
export const MANIFEST_NAME = 'migrate-manifest.json';
export const JOURNAL_NAME = 'migrate-journal.jsonl';
const REWRITE_BACKUPS = 'migrate-backups';

export interface MigrateOptions {
  from?: string;
  to?: string;
  projectsRoot?: string;
  baseDir?: string;
  /** Default true — nothing is written unless explicitly disabled. */
  dryRun?: boolean;
}

export interface DirMove {
  from: string;
  to: string;
}
export interface FileMerge {
  from: string;
  to: string;
  /** Target already existed — a genuine collision we skipped (should not happen with UUIDs). */
  collision: boolean;
}
export interface FileRewrite {
  file: string;
  count: number;
}

const OP_BEGIN = 'begin';
const OP_DIR_MOVE = 'dir-move';
const OP_FILE_MERGE = 'file-merge';
const OP_FILE_REWRITE = 'file-rewrite';
const OP_FAILURE = 'failure';
const OP_COMPLETE = 'complete';

type FailureStage = typeof OP_DIR_MOVE | typeof OP_FILE_MERGE | typeof OP_FILE_REWRITE;

export interface MigrateFailure {
  stage: FailureStage;
  target: string;
  error: string;
}

export interface MigrateManifest {
  from: string;
  to: string;
  dryRun: boolean;
  dirMoves: DirMove[];
  fileMerges: FileMerge[];
  rewrites: FileRewrite[];
  /** Additive — absent or empty on a clean run; an old pre-fix manifest has no such field. */
  failures?: MigrateFailure[];
}

type JournalEntry =
  | { op: typeof OP_BEGIN; from: string; to: string; ts: number }
  | { op: typeof OP_DIR_MOVE; from: string; to: string; ts: number }
  | { op: typeof OP_FILE_MERGE; from: string; to: string; ts: number }
  | { op: typeof OP_FILE_REWRITE; file: string; count: number; ts: number }
  | { op: typeof OP_FAILURE; stage: FailureStage; target: string; error: string; ts: number }
  | { op: typeof OP_COMPLETE; ts: number; failures: number };

const encodeHome = (home: string): string => home.replaceAll('/', '-');

const escapeRegExp = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const defaults = (
  options: MigrateOptions,
): { from: string; to: string; projectsRoot: string; baseDir: string; isDryRun: boolean } => ({
  from: options.from ?? DEFAULT_FROM,
  to: options.to ?? DEFAULT_TO,
  projectsRoot: options.projectsRoot ?? path.join(homedir(), '.claude', 'projects'),
  baseDir: options.baseDir ?? path.join(homedir(), '.claude', 'cc-recall'),
  isDryRun: options.dryRun ?? true,
});

const journalPath = (baseDir: string): string => path.join(baseDir, JOURNAL_NAME);

const appendJournal = (baseDir: string, entry: JournalEntry): void => {
  appendFileSync(journalPath(baseDir), `${JSON.stringify(entry)}\n`);
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface FailureSink {
  baseDir: string;
  isDryRun: boolean;
  failures: MigrateFailure[];
}

/**
 * Record a failed op: push it onto the in-memory `failures` list and, on an apply run, append
 * a `failure` journal line. Shared by all three op sites (dir-move, file-merge, file-rewrite)
 * so a mid-loop throw is handled identically everywhere and the loop it's called from can move
 * on to the next item.
 */
const recordFailure = (
  sink: FailureSink,
  stage: FailureStage,
  target: string,
  error: unknown,
): void => {
  const message = errorMessage(error);
  // The in-memory record comes first and unconditionally: it's what the caller actually reads
  // (manifest.failures), so it must land even if the journal itself is unwritable right now.
  sink.failures.push({ stage, target, error: message });
  if (!sink.isDryRun) {
    // Best-effort only. A failing journal append here (e.g. the same ENOSPC that just failed
    // the op's own success-append) must not itself escape and abort the run — that would just
    // relocate the single-throw-kills-everything bug this file exists to fix, from the
    // operation path onto the failure-recording path.
    try {
      appendJournal(sink.baseDir, {
        op: OP_FAILURE,
        stage,
        target,
        error: message,
        ts: Date.now(),
      });
    } catch {
      // Nowhere further to report it — sink.failures above is the durable record.
    }
  }
};

/**
 * Backup location for a rewritten transcript, namespaced by the encoded slug of its source
 * directory. Every rewrite target lives at `projectsRoot/<slug>/<file>` where `<slug>` never
 * contains a literal `/` (it's itself a `/`→`-` encoding), and `projectsRoot` is fixed for the
 * whole run, so `encodeHome(path.dirname(file))` is injective in `slug` — two distinct
 * destination directories can never produce the same backup namespace regardless of basename
 * collisions between them.
 */
const backupPathFor = (baseDir: string, file: string): string =>
  path.join(baseDir, REWRITE_BACKUPS, encodeHome(path.dirname(file)), path.basename(file));

/** Pre-fix flat backup layout, kept only so old backups remain revertable. */
const legacyBackupPathFor = (baseDir: string, file: string): string =>
  path.join(baseDir, REWRITE_BACKUPS, path.basename(file));

/**
 * Archive (never delete) any pre-existing manifest/journal/backups before a new apply run
 * starts, so a second `--apply` can't destroy the first run's revert data.
 */
const archiveExistingRevertData = (baseDir: string): void => {
  if (!existsSync(baseDir)) return;
  // Millisecond timestamp plus a collision-avoidance loop: two apply runs in the same second
  // (a fast test loop, a scripted retry) must never resolve to the same archive path and
  // silently overwrite each other's revert data.
  const archive = (name: string): void => {
    const src = path.join(baseDir, name);
    if (!existsSync(src)) return;
    let suffix = Date.now();
    let dest = `${src}.${suffix}.bak`;
    while (existsSync(dest)) {
      suffix += 1;
      dest = `${src}.${suffix}.bak`;
    }
    renameSync(src, dest);
  };
  archive(MANIFEST_NAME);
  archive(JOURNAL_NAME);
  archive(REWRITE_BACKUPS);
};

/** Slug dirs under the old home, paired with their new-home destination. */
const planDirectories = (projectsRoot: string, from: string, to: string): DirMove[] => {
  const slugFrom = encodeHome(from);
  const slugTo = encodeHome(to);
  const moves: DirMove[] = [];
  for (const name of readdirSync(projectsRoot)) {
    // Require a path boundary after the home slug so `-Users-joeblackwaslike-*`
    // (a repo owner under the NEW home) is never mistaken for the old home.
    if (name !== slugFrom && !name.startsWith(`${slugFrom}-`)) continue;
    const newName = `${slugTo}${name.slice(slugFrom.length)}`;
    moves.push({ from: path.join(projectsRoot, name), to: path.join(projectsRoot, newName) });
  }
  return moves;
};

/**
 * `readdirSync`, recording (not throwing) on failure — a source dir can become unreadable
 * mid-run same as any other op. `undefined` distinguishes "enumeration failed" from a
 * legitimately empty directory.
 */
const readdirOrRecordFailure = (
  dir: string,
  sink: FailureSink,
  stage: FailureStage,
): string[] | undefined => {
  try {
    return readdirSync(dir);
  } catch (error) {
    recordFailure(sink, stage, dir, error);
    return undefined;
  }
};

const mergeDir = (
  move: DirMove,
  isDryRun: boolean,
  baseDir: string,
  failures: MigrateFailure[],
): FileMerge[] => {
  const merges: FileMerge[] = [];
  const sink: FailureSink = { baseDir, isDryRun, failures };
  const entries = readdirOrRecordFailure(move.from, sink, OP_DIR_MOVE);
  if (entries === undefined) return merges;

  for (const file of entries) {
    const from = path.join(move.from, file);
    const to = path.join(move.to, file);
    const isCollision = existsSync(to);
    merges.push({ from, to, collision: isCollision });
    if (isDryRun || isCollision) continue;
    try {
      renameSync(from, to);
      appendJournal(baseDir, { op: OP_FILE_MERGE, from, to, ts: Date.now() });
    } catch (error) {
      recordFailure(sink, OP_FILE_MERGE, from, error);
    }
  }

  const remaining = readdirOrRecordFailure(move.from, sink, OP_DIR_MOVE);
  if (!isDryRun && remaining?.length === 0) {
    try {
      rmdirSync(move.from);
    } catch (error) {
      recordFailure(sink, OP_DIR_MOVE, move.from, error);
    }
  }
  return merges;
};

const applyDirectories = (
  moves: readonly DirMove[],
  isDryRun: boolean,
  baseDir: string,
  failures: MigrateFailure[],
): FileMerge[] => {
  const merges: FileMerge[] = [];
  for (const move of moves) {
    if (existsSync(move.to)) {
      merges.push(...mergeDir(move, isDryRun, baseDir, failures));
    } else if (!isDryRun) {
      try {
        renameSync(move.from, move.to);
        appendJournal(baseDir, { op: OP_DIR_MOVE, from: move.from, to: move.to, ts: Date.now() });
      } catch (error) {
        recordFailure({ baseDir, isDryRun, failures }, OP_DIR_MOVE, move.from, error);
      }
    }
  }
  return merges;
};

/**
 * Transcript files to rewrite. On apply they live at the destination; in a dry-run the
 * moves have not happened yet, so we preview against the still-in-place source files.
 */
const jsonlFilesIn = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((entry) => entry.endsWith('.jsonl'))
        .map((entry) => path.join(dir, entry))
    : [];

const rewriteTargets = (
  moves: readonly DirMove[],
  merges: readonly FileMerge[],
  isDryRun: boolean,
): string[] => {
  const key: 'from' | 'to' = isDryRun ? 'from' : 'to';
  const merged = merges
    .filter((m) => !m.collision)
    .map((m) => m[key])
    .filter((f) => f.endsWith('.jsonl'));
  const fromMoves = moves.flatMap((move) => jsonlFilesIn(move[key]));
  return [...new Set([...merged, ...fromMoves])];
};

const rewriteFile = (
  file: string,
  from: string,
  to: string,
  isDryRun: boolean,
  baseDir: string,
): number => {
  const text = readFileSync(file, 'utf8');
  // Only rewrite the home when it is the start of a path (followed by `/` or a closing quote).
  const pattern = new RegExp(`${escapeRegExp(from)}(?=[/"])`, 'g');
  const count = text.matchAll(pattern).toArray().length;
  if (count === 0 || isDryRun) return count;

  const origErrors = parseTranscriptText(text, file).parseErrors;
  const backupPath = backupPathFor(baseDir, file);
  mkdirSync(path.dirname(backupPath), { recursive: true });
  if (!existsSync(backupPath)) copyFileSync(file, backupPath);

  const rewritten = text.replaceAll(pattern, () => to);
  const tmp = `${file}.cc-recall-tmp`;
  writeFileSync(tmp, rewritten);
  renameSync(tmp, file);

  if (parseTranscriptText(readFileSync(file, 'utf8'), file).parseErrors !== origErrors) {
    copyFileSync(backupPath, file);
    throw new Error(`home-path rewrite corrupted ${file}; restored from backup`);
  }
  return count;
};

const applyRewrites = (
  targets: readonly string[],
  rename: { from: string; to: string },
  sink: FailureSink,
): FileRewrite[] => {
  const { baseDir, isDryRun } = sink;
  const rewrites: FileRewrite[] = [];
  for (const file of targets) {
    try {
      const count = rewriteFile(file, rename.from, rename.to, isDryRun, baseDir);
      if (count > 0) {
        rewrites.push({ file, count });
        if (!isDryRun) {
          appendJournal(baseDir, { op: OP_FILE_REWRITE, file, count, ts: Date.now() });
        }
      }
    } catch (error) {
      recordFailure(sink, OP_FILE_REWRITE, file, error);
    }
  }
  return rewrites;
};

/** Run (or preview) the home-path migration. Dry-run by default. */
export const migrateHomePaths = (options: MigrateOptions = {}): MigrateManifest => {
  const { from, to, projectsRoot, baseDir, isDryRun } = defaults(options);

  if (!isDryRun) {
    archiveExistingRevertData(baseDir);
    mkdirSync(baseDir, { recursive: true });
    appendJournal(baseDir, { op: OP_BEGIN, from, to, ts: Date.now() });
  }

  const dirMoves = planDirectories(projectsRoot, from, to);
  const failures: MigrateFailure[] = [];
  const fileMerges = applyDirectories(dirMoves, isDryRun, baseDir, failures);
  const targets = rewriteTargets(dirMoves, fileMerges, isDryRun);
  const rewrites = applyRewrites(targets, { from, to }, { baseDir, isDryRun, failures });

  const manifest: MigrateManifest = {
    from,
    to,
    dryRun: isDryRun,
    dirMoves,
    fileMerges,
    rewrites,
    failures,
  };
  if (!isDryRun) {
    // Best-effort, same as recordFailure's own append: a failing `complete` journal line must
    // not stop the final manifest write below — the manifest, not the trailing journal marker,
    // is what a normal (non-crash-recovery) revert reads.
    try {
      appendJournal(baseDir, { op: OP_COMPLETE, ts: Date.now(), failures: failures.length });
    } catch {
      // Nowhere further to report it — the manifest write immediately below is the durable
      // record that matters here.
    }
    atomicWrite(path.join(baseDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  }
  return manifest;
};

const restoreRewrites = (manifest: MigrateManifest, baseDir: string): void => {
  for (const rewrite of manifest.rewrites) {
    const namespaced = backupPathFor(baseDir, rewrite.file);
    const backupPath = existsSync(namespaced)
      ? namespaced
      : legacyBackupPathFor(baseDir, rewrite.file);
    if (existsSync(backupPath)) copyFileSync(backupPath, rewrite.file);
  }
};

const restoreMerges = (manifest: MigrateManifest): void => {
  for (const merge of manifest.fileMerges) {
    if (merge.collision || !existsSync(merge.to) || existsSync(merge.from)) continue;
    mkdirSync(path.dirname(merge.from), { recursive: true });
    renameSync(merge.to, merge.from);
  }
};

const restoreMoves = (manifest: MigrateManifest): void => {
  for (const move of manifest.dirMoves) {
    if (existsSync(move.to) && !existsSync(move.from)) renameSync(move.to, move.from);
  }
};

interface JournalAccumulator {
  dirMoves: DirMove[];
  fileMerges: FileMerge[];
  rewrites: FileRewrite[];
}

/** Fold one journal line into the in-progress manifest arrays; `failure`/`complete` are ignored. */
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
    default: {
      break;
    }
  }
};

/**
 * Rebuild a manifest from the append-only journal when the final manifest write never
 * happened (killed mid-run). `begin` supplies `from`/`to`; `dir-move`/`file-merge`/
 * `file-rewrite` lines populate the three arrays via `applyJournalLine`; `failure`/`complete`
 * are ignored — no special-casing of partial-vs-complete is needed, since
 * `restoreRewrites`/`restoreMerges`/`restoreMoves` are already idempotent and
 * `existsSync`-guarded.
 */
/**
 * A crash mid-`appendFileSync` can leave a truncated, unparsable trailing line — exactly the
 * scenario this journal exists to survive. Drop it rather than let `JSON.parse` throw and take
 * down the entire revert with it.
 */
const parseJournalLine = (line: string): JournalEntry | undefined => {
  try {
    return JSON.parse(line) as JournalEntry;
  } catch {
    return undefined;
  }
};

const manifestFromJournal = (text: string): MigrateManifest => {
  const lines = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => parseJournalLine(line))
    .filter((line): line is JournalEntry => line !== undefined);
  const begin = lines.find((line) => line.op === OP_BEGIN);
  if (!begin) throw new Error('migrate journal is missing its begin entry');

  const dirMoves: DirMove[] = [];
  const fileMerges: FileMerge[] = [];
  const rewrites: FileRewrite[] = [];
  for (const line of lines) {
    applyJournalLine(line, { dirMoves, fileMerges, rewrites });
  }
  return { from: begin.from, to: begin.to, dryRun: false, dirMoves, fileMerges, rewrites };
};

/** Manifest if it was written, else rebuilt from the journal, else undefined (neither exists). */
const loadManifest = (baseDir: string): MigrateManifest | undefined => {
  const manifestPath = path.join(baseDir, MANIFEST_NAME);
  if (existsSync(manifestPath)) {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as MigrateManifest;
  }
  const journalFile = journalPath(baseDir);
  if (existsSync(journalFile)) {
    return manifestFromJournal(readFileSync(journalFile, 'utf8'));
  }
  return undefined;
};

/** Reverse a previously-applied migration using its manifest, or its journal if the manifest
 * write never completed. */
export const revertHomePaths = (options: MigrateOptions = {}): MigrateManifest => {
  const { baseDir } = defaults(options);
  const manifest = loadManifest(baseDir);
  if (!manifest) throw new Error(`no migration manifest or journal at ${baseDir}`);

  restoreRewrites(manifest, baseDir);
  restoreMerges(manifest);
  restoreMoves(manifest);
  return manifest;
};
