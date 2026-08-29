import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTranscriptText } from '../transcript/parse.js';
import { JOURNAL_NAME, MANIFEST_NAME, migrateHomePaths, revertHomePaths } from './home-path.js';

const FROM = '/Users/joeblack';
const TO = '/Users/joe';

const OLD_FOO = '-Users-joeblack-foo';
const NEW_FOO = '-Users-joe-foo';
const OLD_BAR = '-Users-joeblack-bar';
const NEW_BAR = '-Users-joe-bar';
const WASLIKE = '-Users-joeblackwaslike-proj';
const U1 = 'u1.jsonl';
const U2 = 'u2.jsonl';
const U3 = 'u3.jsonl';
const FOO_CWD = '/Users/joeblack/foo';
const MOVED_FOO_CWD = '/Users/joe/foo';
const BAR_CWD = '/Users/joeblack/bar';
const WASLIKE_CWD = '/Users/joe/x';

const userLine = (sessionId: string, cwd: string): string =>
  JSON.stringify({
    type: 'user',
    sessionId,
    cwd,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: `work in ${cwd}/sub dir` }] },
  });

const seed = (root: string, dir: string, file: string, cwd: string): void => {
  mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, dir, file), `${userLine(file, cwd)}\n`);
};

/** Shared fixture: an old-home dir to rename, one to merge into a pre-existing new-home dir
 * (collision), and a repo-owner dir under the new home that must never be touched. */
const setupFixture = (tmpPrefix: string): { root: string; baseDir: string } => {
  const tmp = mkdtempSync(path.join(tmpdir(), tmpPrefix));
  const root = path.join(tmp, 'projects');
  const baseDir = path.join(tmp, 'base');
  seed(root, OLD_FOO, U1, FOO_CWD);
  mkdirSync(path.join(root, NEW_BAR), { recursive: true }); // pre-existing collision target
  seed(root, OLD_BAR, U2, BAR_CWD);
  seed(root, WASLIKE, U3, WASLIKE_CWD); // repo owner under NEW home — must NOT be touched
  return { root, baseDir };
};

describe('migrateHomePaths', () => {
  let root: string;
  let baseDir: string;
  beforeEach(() => {
    ({ root, baseDir } = setupFixture('cc-recall-mig-'));
  });
  afterEach(() => {
    rmSync(path.dirname(root), { recursive: true, force: true });
  });

  it('dry-run plans moves without touching the filesystem', () => {
    const manifest = migrateHomePaths({
      from: FROM,
      to: TO,
      projectsRoot: root,
      baseDir,
      dryRun: true,
    });
    expect(
      manifest.dirMoves
        .map((move) => path.basename(move.to))
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual([NEW_BAR, NEW_FOO]);
    expect(existsSync(path.join(root, OLD_FOO))).toBe(true); // unchanged
  });

  it('applies dir rename + merge + cwd rewrite, leaving repo-owner dirs alone', () => {
    migrateHomePaths({ from: FROM, to: TO, projectsRoot: root, baseDir, dryRun: false });

    expect(existsSync(path.join(root, OLD_FOO))).toBe(false);
    const moved = parseTranscriptText(readFileSync(path.join(root, NEW_FOO, U1), 'utf8'), U1);
    expect(moved.cwd).toBe(MOVED_FOO_CWD);

    expect(existsSync(path.join(root, NEW_BAR, U2))).toBe(true); // merged into pre-existing dir
    expect(existsSync(path.join(root, OLD_BAR))).toBe(false);
    expect(existsSync(path.join(root, WASLIKE, U3))).toBe(true); // boundary guard
  });

  it('reverts an applied migration from its manifest', () => {
    migrateHomePaths({ from: FROM, to: TO, projectsRoot: root, baseDir, dryRun: false });
    revertHomePaths({ baseDir });
    expect(existsSync(path.join(root, OLD_FOO, U1))).toBe(true);
    const restored = parseTranscriptText(readFileSync(path.join(root, OLD_FOO, U1), 'utf8'), U1);
    expect(restored.cwd).toBe(FOO_CWD);
  });
});

describe('migrateHomePaths — mid-loop failures', () => {
  let root: string;
  let baseDir: string;
  beforeEach(() => {
    ({ root, baseDir } = setupFixture('cc-recall-mig-res-'));
  });
  afterEach(() => {
    rmSync(path.dirname(root), { recursive: true, force: true });
  });

  it('a mid-loop rewrite failure does not abort the run', () => {
    // A directory named `bad.jsonl`, not a file — `readFileSync` inside `rewriteFile` throws
    // EISDIR deterministically (portable, no chmod/root-permission fragility). It rides along
    // inside OLD_FOO's whole-dir rename (no merge here), so it surfaces as a rewrite target via
    // `jsonlFilesIn`'s name-suffix filter.
    mkdirSync(path.join(root, OLD_FOO, 'bad.jsonl'), { recursive: true });

    const manifest = migrateHomePaths({
      from: FROM,
      to: TO,
      projectsRoot: root,
      baseDir,
      dryRun: false,
    });

    expect(manifest.failures).toHaveLength(1);
    expect(manifest.failures?.[0]?.stage).toBe('file-rewrite');

    // The other seeded file in the same directory was still correctly rewritten.
    const moved = parseTranscriptText(readFileSync(path.join(root, NEW_FOO, U1), 'utf8'), U1);
    expect(moved.cwd).toBe(MOVED_FOO_CWD);

    const journal = path.join(baseDir, JOURNAL_NAME);
    expect(existsSync(journal)).toBe(true);
    const journalLines = readFileSync(journal, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { op: string });
    expect(journalLines.some((line) => line.op === 'complete')).toBe(true);
    expect(journalLines.some((line) => line.op === 'failure')).toBe(true);
  });

  it('reverts from a journal when the manifest is missing (killed before the final write)', () => {
    migrateHomePaths({ from: FROM, to: TO, projectsRoot: root, baseDir, dryRun: false });
    unlinkSync(path.join(baseDir, MANIFEST_NAME));

    revertHomePaths({ baseDir });

    expect(existsSync(path.join(root, OLD_FOO, U1))).toBe(true);
    const restored = parseTranscriptText(readFileSync(path.join(root, OLD_FOO, U1), 'utf8'), U1);
    expect(restored.cwd).toBe(FOO_CWD);
  });

  it('a directory-enumeration failure does not abort the run', () => {
    // A dangling symlink at an old-home slug: readdirSync throws ENOENT reading it,
    // deterministically and portably (no chmod/root fragility). Pre-create the merge target so
    // applyDirectories takes the mergeDir (collision) branch, whose readdirSync(move.from) is
    // what actually dereferences the symlink and fails — a plain rename of a dangling symlink
    // (the non-merge branch) succeeds without ever reading through it.
    const orphanTarget = mkdtempSync(path.join(tmpdir(), 'cc-recall-orphan-'));
    const oldBroken = '-Users-joeblack-broken';
    const newBroken = '-Users-joe-broken';
    mkdirSync(path.join(root, newBroken), { recursive: true });
    symlinkSync(orphanTarget, path.join(root, oldBroken), 'dir');
    rmSync(orphanTarget, { recursive: true, force: true });

    const manifest = migrateHomePaths({
      from: FROM,
      to: TO,
      projectsRoot: root,
      baseDir,
      dryRun: false,
    });

    expect(
      manifest.failures?.some((f) => f.stage === 'dir-move' && f.target.endsWith(oldBroken)),
    ).toBe(true);
    // The other seeded directories still migrated normally.
    expect(existsSync(path.join(root, OLD_FOO))).toBe(false);
    const moved = parseTranscriptText(readFileSync(path.join(root, NEW_FOO, U1), 'utf8'), U1);
    expect(moved.cwd).toBe(MOVED_FOO_CWD);
  });
});

describe('migrateHomePaths — journal reconstruction', () => {
  let root: string;
  let baseDir: string;
  beforeEach(() => {
    ({ root, baseDir } = setupFixture('cc-recall-mig-journal-'));
  });
  afterEach(() => {
    rmSync(path.dirname(root), { recursive: true, force: true });
  });

  it('reverts from a journal with a truncated trailing line (killed mid-append)', () => {
    migrateHomePaths({ from: FROM, to: TO, projectsRoot: root, baseDir, dryRun: false });
    unlinkSync(path.join(baseDir, MANIFEST_NAME));
    // Simulate a process kill partway through appendFileSync writing the final journal line.
    appendFileSync(path.join(baseDir, JOURNAL_NAME), '{"op":"file-rewr');

    revertHomePaths({ baseDir });

    expect(existsSync(path.join(root, OLD_FOO, U1))).toBe(true);
    const restored = parseTranscriptText(readFileSync(path.join(root, OLD_FOO, U1), 'utf8'), U1);
    expect(restored.cwd).toBe(FOO_CWD);
  });

  it('rejects a newline-terminated (fully-written) corrupt trailing line, unlike a truncated one', () => {
    migrateHomePaths({ from: FROM, to: TO, projectsRoot: root, baseDir, dryRun: false });
    unlinkSync(path.join(baseDir, MANIFEST_NAME));
    // Unlike the truncated-append case above, this line is complete and newline-terminated —
    // appendJournal always writes `<json>\n`, so a fully-written entry never lacks its trailing
    // newline. A corrupt *complete* line means real corruption, not an interrupted write, even
    // though it's also the last line.
    appendFileSync(path.join(baseDir, JOURNAL_NAME), 'not valid json at all\n');

    expect(() => revertHomePaths({ baseDir })).toThrow(/corrupt/i);
  });

  it('preserves recorded failures when a manifest is reconstructed from the journal alone', () => {
    mkdirSync(path.join(root, OLD_FOO, 'bad.jsonl'), { recursive: true });
    migrateHomePaths({ from: FROM, to: TO, projectsRoot: root, baseDir, dryRun: false });
    unlinkSync(path.join(baseDir, MANIFEST_NAME));

    const reconstructed = revertHomePaths({ baseDir });

    expect(reconstructed.failures).toHaveLength(1);
    expect(reconstructed.failures?.[0]?.stage).toBe('file-rewrite');
  });

  it('rejects a journal with a corrupted line before the trailing one, rather than silently dropping it', () => {
    migrateHomePaths({ from: FROM, to: TO, projectsRoot: root, baseDir, dryRun: false });
    unlinkSync(path.join(baseDir, MANIFEST_NAME));
    // Only a truncated *trailing* append is a tolerated crash artifact — a malformed line
    // anywhere earlier in the journal means real corruption, and must surface as an error
    // rather than being silently skipped, which would recover only part of the migration.
    const journal = path.join(baseDir, JOURNAL_NAME);
    const lines = readFileSync(journal, 'utf8').trimEnd().split('\n');
    lines.splice(1, 0, '{"op":"dir-move","from":"/x","to"garbage');
    writeFileSync(journal, `${lines.join('\n')}\n`);

    expect(() => revertHomePaths({ baseDir })).toThrow(/corrupt/i);
  });

  it('rejects a syntactically-valid but wrong-shaped journal line, rather than reconstructing undefined fields', () => {
    migrateHomePaths({ from: FROM, to: TO, projectsRoot: root, baseDir, dryRun: false });
    unlinkSync(path.join(baseDir, MANIFEST_NAME));
    // Valid JSON, missing the required `to` field — JSON.parse alone can't catch this; a
    // truncated write breaks JSON syntax, it doesn't produce valid-but-wrong-shape JSON, so this
    // is real corruption, not a tolerated truncation artifact, even though it isn't the last line.
    const journal = path.join(baseDir, JOURNAL_NAME);
    const lines = readFileSync(journal, 'utf8').trimEnd().split('\n');
    lines.splice(1, 0, '{"op":"dir-move","from":"/x"}');
    writeFileSync(journal, `${lines.join('\n')}\n`);

    expect(() => revertHomePaths({ baseDir })).toThrow(/corrupt/i);
  });
});

describe('migrateHomePaths — revert-data safety', () => {
  let root: string;
  let baseDir: string;
  beforeEach(() => {
    ({ root, baseDir } = setupFixture('cc-recall-mig-safety-'));
  });
  afterEach(() => {
    rmSync(path.dirname(root), { recursive: true, force: true });
  });

  it('backups are collision-safe across dirs with same-basename files', () => {
    const oldAlpha = '-Users-joeblack-alpha';
    const oldBeta = '-Users-joeblack-beta';
    const dup = 'dup.jsonl';
    seed(root, oldAlpha, dup, '/Users/joeblack/alpha');
    seed(root, oldBeta, dup, '/Users/joeblack/beta');

    migrateHomePaths({ from: FROM, to: TO, projectsRoot: root, baseDir, dryRun: false });
    revertHomePaths({ baseDir });

    const alphaRestored = parseTranscriptText(
      readFileSync(path.join(root, oldAlpha, dup), 'utf8'),
      dup,
    );
    const betaRestored = parseTranscriptText(
      readFileSync(path.join(root, oldBeta, dup), 'utf8'),
      dup,
    );
    expect(alphaRestored.cwd).toBe('/Users/joeblack/alpha');
    expect(betaRestored.cwd).toBe('/Users/joeblack/beta');
  });

  it('reverting an empty-source merge does not steal the pre-existing destination directory', () => {
    const oldEmpty = '-Users-joeblack-empty';
    const newEmpty = '-Users-joe-empty';
    const real = 'real-session.jsonl';
    mkdirSync(path.join(root, oldEmpty), { recursive: true }); // empty old-home dir, no files
    // Pre-existing, unrelated real content already living at the merge target — must survive.
    seed(root, newEmpty, real, '/Users/joe/empty');

    migrateHomePaths({ from: FROM, to: TO, projectsRoot: root, baseDir, dryRun: false });
    revertHomePaths({ baseDir });

    expect(existsSync(path.join(root, newEmpty, real))).toBe(true);
    expect(existsSync(path.join(root, oldEmpty))).toBe(false);
  });

  it('archives rather than destroys prior manifest/journal/backups on a second apply', () => {
    const first = migrateHomePaths({
      from: FROM,
      to: TO,
      projectsRoot: root,
      baseDir,
      dryRun: false,
    });
    expect(first.dirMoves.length).toBeGreaterThan(0);
    expect(first.rewrites.length).toBeGreaterThan(0);

    migrateHomePaths({ from: FROM, to: TO, projectsRoot: root, baseDir, dryRun: false });

    const archived = readdirSync(baseDir).filter(
      (name) => name.startsWith(`${MANIFEST_NAME}.`) && name.endsWith('.bak'),
    );
    expect(archived.length).toBeGreaterThan(0);
    const archivedName = archived[0];
    if (archivedName === undefined) throw new Error('expected an archived manifest file');
    const archivedManifest = JSON.parse(readFileSync(path.join(baseDir, archivedName), 'utf8')) as {
      dirMoves: unknown[];
      rewrites: unknown[];
    };
    expect(archivedManifest.dirMoves).toHaveLength(first.dirMoves.length);
    expect(archivedManifest.rewrites).toHaveLength(first.rewrites.length);
  });
});
