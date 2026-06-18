import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTranscriptText } from '../transcript/parse.js';
import { migrateHomePaths, revertHomePaths } from './home-path.js';

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

describe('migrateHomePaths', () => {
  let root: string;
  let baseDir: string;
  beforeEach(() => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cc-recall-mig-'));
    root = path.join(tmp, 'projects');
    baseDir = path.join(tmp, 'base');
    seed(root, OLD_FOO, U1, '/Users/joeblack/foo');
    mkdirSync(path.join(root, NEW_BAR), { recursive: true }); // pre-existing collision target
    seed(root, OLD_BAR, U2, '/Users/joeblack/bar');
    seed(root, WASLIKE, U3, '/Users/joe/x'); // repo owner under NEW home — must NOT be touched
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
    expect(moved.cwd).toBe('/Users/joe/foo');

    expect(existsSync(path.join(root, NEW_BAR, U2))).toBe(true); // merged into pre-existing dir
    expect(existsSync(path.join(root, OLD_BAR))).toBe(false);
    expect(existsSync(path.join(root, WASLIKE, U3))).toBe(true); // boundary guard
  });

  it('reverts an applied migration from its manifest', () => {
    migrateHomePaths({ from: FROM, to: TO, projectsRoot: root, baseDir, dryRun: false });
    revertHomePaths({ baseDir });
    expect(existsSync(path.join(root, OLD_FOO, U1))).toBe(true);
    const restored = parseTranscriptText(readFileSync(path.join(root, OLD_FOO, U1), 'utf8'), U1);
    expect(restored.cwd).toBe('/Users/joeblack/foo');
  });
});
