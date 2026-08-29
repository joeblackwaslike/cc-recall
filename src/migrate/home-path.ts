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
import { manifestFromJournal } from './home-path-journal.js';
import {
  type DirMove,
  type FailureStage,
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

export type {
  DirMove,
  FailureStage,
  FileMerge,
  FileRewrite,
  JournalEntry,
  MigrateFailure,
  MigrateManifest,
} from './home-path-types.js';

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

/**
 * Best-effort: called only after the destructive op it records already succeeded. A failure
 * here is a journal-durability gap (cc-recall-j34), not an operation failure, so it must not
 * be recorded via recordFailure.
 */
const appendJournalBestEffort = (baseDir: string, entry: JournalEntry): void => {
  try {
    appendJournal(baseDir, entry);
  } catch {
    // swallow — see doc comment above
  }
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
    const entry: JournalEntry = { op: OP_FAILURE, stage, target, error: message, ts: Date.now() };
    try {
      appendJournal(sink.baseDir, entry);
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

/**
 * Slug dirs under the old home, paired with their new-home destination. `projectsRoot` itself
 * becoming unreadable is recorded like any other enumeration failure (yielding zero planned
 * moves) rather than thrown — consistent with every other directory read in this file, and it
 * lets a `complete` journal entry and a real (if empty) manifest still get written instead of
 * an unhandled exception.
 */
const planDirectories = (
  projectsRoot: string,
  from: string,
  to: string,
  sink: FailureSink,
): DirMove[] => {
  const slugFrom = encodeHome(from);
  const slugTo = encodeHome(to);
  const moves: DirMove[] = [];
  const names = readdirOrRecordFailure(projectsRoot, sink, OP_DIR_MOVE) ?? [];
  for (const name of names) {
    // Require a path boundary after the home slug so `-Users-joeblackwaslike-*`
    // (a repo owner under the NEW home) is never mistaken for the old home.
    if (name !== slugFrom && !name.startsWith(`${slugFrom}-`)) continue;
    const newName = `${slugTo}${name.slice(slugFrom.length)}`;
    moves.push({ from: path.join(projectsRoot, name), to: path.join(projectsRoot, newName) });
  }
  return moves;
};

/** Remove `move.from` once it's confirmed empty post-merge — best-effort, recorded on failure. */
const removeSourceIfEmpty = (move: DirMove, isDryRun: boolean, sink: FailureSink): void => {
  const remaining = readdirOrRecordFailure(move.from, sink, OP_DIR_MOVE);
  if (isDryRun || remaining?.length !== 0) return;
  try {
    rmdirSync(move.from);
  } catch (error) {
    recordFailure(sink, OP_DIR_MOVE, move.from, error);
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
    } catch (error) {
      recordFailure(sink, OP_FILE_MERGE, from, error);
      continue;
    }
    appendJournalBestEffort(baseDir, { op: OP_FILE_MERGE, from, to, ts: Date.now() });
  }

  removeSourceIfEmpty(move, isDryRun, sink);
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
      // `merged: true` — restoreMoves must never touch this entry (see its own comment for
      // why): a merge into a pre-existing directory, even one whose source turned out empty
      // and contributed no fileMerges, is restoreMerges' job alone.
      move.merged = true;
      merges.push(...mergeDir(move, isDryRun, baseDir, failures));
    } else if (!isDryRun) {
      const sink: FailureSink = { baseDir, isDryRun, failures };
      try {
        renameSync(move.from, move.to);
      } catch (error) {
        recordFailure(sink, OP_DIR_MOVE, move.from, error);
        continue;
      }
      appendJournalBestEffort(baseDir, {
        op: OP_DIR_MOVE,
        from: move.from,
        to: move.to,
        ts: Date.now(),
      });
    }
  }
  return merges;
};

/**
 * Transcript files to rewrite. On apply they live at the destination; in a dry-run the
 * moves have not happened yet, so we preview against the still-in-place source files. A
 * directory that exists but can't be enumerated (e.g. a permissions change) is recorded as a
 * failure and treated as contributing no targets, rather than aborting target discovery for
 * every other directory.
 */
const jsonlFilesIn = (dir: string, sink: FailureSink): string[] => {
  if (!existsSync(dir)) return [];
  const entries = readdirOrRecordFailure(dir, sink, OP_DIR_MOVE) ?? [];
  return entries.filter((entry) => entry.endsWith('.jsonl')).map((entry) => path.join(dir, entry));
};

const rewriteTargets = (
  moves: readonly DirMove[],
  merges: readonly FileMerge[],
  isDryRun: boolean,
  sink: FailureSink,
): string[] => {
  const key: 'from' | 'to' = isDryRun ? 'from' : 'to';
  const merged = merges
    .filter((m) => !m.collision)
    .map((m) => m[key])
    .filter((f) => f.endsWith('.jsonl'));
  const fromMoves = moves.flatMap((move) => jsonlFilesIn(move[key], sink));
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
    let count: number;
    try {
      count = rewriteFile(file, rename.from, rename.to, isDryRun, baseDir);
    } catch (error) {
      recordFailure(sink, OP_FILE_REWRITE, file, error);
      continue;
    }
    if (count > 0) {
      rewrites.push({ file, count });
      if (!isDryRun) {
        appendJournalBestEffort(baseDir, { op: OP_FILE_REWRITE, file, count, ts: Date.now() });
      }
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

  const failures: MigrateFailure[] = [];
  const sink: FailureSink = { baseDir, isDryRun, failures };
  // Mutated in place by applyDirectories to flag which entries went the merge route (see
  // DirMove.merged) — the same array becomes manifest.dirMoves below, in both dry-run and
  // apply mode, so restoreMoves can later tell them apart.
  const dirMoves = planDirectories(projectsRoot, from, to, sink);
  const fileMerges = applyDirectories(dirMoves, isDryRun, baseDir, failures);
  const targets = rewriteTargets(dirMoves, fileMerges, isDryRun, sink);
  const rewrites = applyRewrites(targets, { from, to }, sink);

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
    // A merge-path entry has no whole-directory rename to undo here — restoreMerges already
    // handled its files (or, if the source was empty, there was never anything to restore).
    // Treating it as a plain rename would rename move.to — the real, pre-existing directory it
    // merged into — back over move.from, stealing data that was never part of this migration.
    if (move.merged) continue;
    if (existsSync(move.to) && !existsSync(move.from)) renameSync(move.to, move.from);
  }
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
