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

import {
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
import { parseTranscriptText } from '../transcript/parse.js';

const DEFAULT_FROM = '/Users/joeblack';
const DEFAULT_TO = '/Users/joe';
const MANIFEST_NAME = 'migrate-manifest.json';
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

export interface MigrateManifest {
  from: string;
  to: string;
  dryRun: boolean;
  dirMoves: DirMove[];
  fileMerges: FileMerge[];
  rewrites: FileRewrite[];
}

const encodeHome = (home: string): string => home.replaceAll('/', '-');

const escapeRegExp = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const defaults = (
  options: MigrateOptions,
): { from: string; to: string; projectsRoot: string; baseDir: string; dryRun: boolean } => ({
  from: options.from ?? DEFAULT_FROM,
  to: options.to ?? DEFAULT_TO,
  projectsRoot: options.projectsRoot ?? path.join(homedir(), '.claude', 'projects'),
  baseDir: options.baseDir ?? path.join(homedir(), '.claude', 'cc-recall'),
  dryRun: options.dryRun ?? true,
});

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

const mergeDir = (move: DirMove, dryRun: boolean): FileMerge[] => {
  const merges: FileMerge[] = [];
  for (const file of readdirSync(move.from)) {
    const from = path.join(move.from, file);
    const to = path.join(move.to, file);
    const collision = existsSync(to);
    merges.push({ from, to, collision });
    if (!dryRun && !collision) renameSync(from, to);
  }
  if (!dryRun && readdirSync(move.from).length === 0) rmdirSync(move.from);
  return merges;
};

const applyDirectories = (moves: readonly DirMove[], dryRun: boolean): FileMerge[] => {
  const merges: FileMerge[] = [];
  for (const move of moves) {
    if (existsSync(move.to)) {
      merges.push(...mergeDir(move, dryRun));
    } else if (!dryRun) {
      renameSync(move.from, move.to);
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
  dryRun: boolean,
): string[] => {
  const files = new Set<string>();
  for (const merge of merges) {
    if (merge.collision) continue;
    files.add(dryRun ? merge.from : merge.to);
  }
  for (const move of moves) {
    for (const file of jsonlFilesIn(dryRun ? move.from : move.to)) files.add(file);
  }
  return [...files];
};

const rewriteFile = (
  file: string,
  from: string,
  to: string,
  dryRun: boolean,
  baseDir: string,
): number => {
  const text = readFileSync(file, 'utf8');
  // Only rewrite the home when it is the start of a path (followed by `/` or a closing quote).
  const pattern = new RegExp(`${escapeRegExp(from)}(?=[/"])`, 'g');
  const count = [...text.matchAll(pattern)].length;
  if (count === 0 || dryRun) return count;

  const origErrors = parseTranscriptText(text, file).parseErrors;
  const backupPath = path.join(baseDir, REWRITE_BACKUPS, path.basename(file));
  mkdirSync(path.dirname(backupPath), { recursive: true });
  if (!existsSync(backupPath)) copyFileSync(file, backupPath);

  const rewritten = text.replaceAll(pattern, to);
  const tmp = `${file}.cc-recall-tmp`;
  writeFileSync(tmp, rewritten);
  renameSync(tmp, file);

  if (parseTranscriptText(readFileSync(file, 'utf8'), file).parseErrors !== origErrors) {
    copyFileSync(backupPath, file);
    throw new Error(`home-path rewrite corrupted ${file}; restored from backup`);
  }
  return count;
};

/** Run (or preview) the home-path migration. Dry-run by default. */
export const migrateHomePaths = (options: MigrateOptions = {}): MigrateManifest => {
  const { from, to, projectsRoot, baseDir, dryRun } = defaults(options);
  const dirMoves = planDirectories(projectsRoot, from, to);
  const fileMerges = applyDirectories(dirMoves, dryRun);

  const rewrites: FileRewrite[] = [];
  for (const file of rewriteTargets(dirMoves, fileMerges, dryRun)) {
    const count = rewriteFile(file, from, to, dryRun, baseDir);
    if (count > 0) rewrites.push({ file, count });
  }

  const manifest: MigrateManifest = { from, to, dryRun, dirMoves, fileMerges, rewrites };
  if (!dryRun) {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(path.join(baseDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  }
  return manifest;
};

const restoreRewrites = (manifest: MigrateManifest, baseDir: string): void => {
  for (const rewrite of manifest.rewrites) {
    const backupPath = path.join(baseDir, REWRITE_BACKUPS, path.basename(rewrite.file));
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

/** Reverse a previously-applied migration using its manifest. */
export const revertHomePaths = (options: MigrateOptions = {}): MigrateManifest => {
  const { baseDir } = defaults(options);
  const manifestPath = path.join(baseDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) throw new Error(`no migration manifest at ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as MigrateManifest;

  restoreRewrites(manifest, baseDir);
  restoreMerges(manifest);
  restoreMoves(manifest);
  return manifest;
};
