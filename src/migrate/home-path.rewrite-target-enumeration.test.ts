// jsonlFilesIn's readdirSync (used by rewriteTargets to discover which transcripts need a cwd
// rewrite) previously had no failure handling of its own — an existing-but-unreadable directory
// (e.g. a permissions change after the dir move already succeeded) would throw out of
// migrateHomePaths entirely, after real destructive work had already happened. Reaching that
// deterministically needs a directory that passes `existsSync` but fails `readdirSync`, which
// isn't achievable portably with real fixtures (chmod is root/platform-fragile) — so `node:fs`
// is mocked here — in its own file, so the rest of the suite keeps running against the real
// thing.
import type * as NodeFs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsHook = vi.hoisted(() => ({ unreadableDir: null as string | null }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const readdirSync = ((...args: Parameters<typeof actual.readdirSync>) => {
    if (typeof args[0] === 'string' && args[0] === fsHook.unreadableDir) {
      throw new Error('EACCES: permission denied, scandir');
    }
    return actual.readdirSync(...args);
  }) as typeof actual.readdirSync;
  return { ...actual, default: actual, readdirSync };
});

// Imported after the mock so it picks up the mocked `readdirSync`.
const { migrateHomePaths } = await import('./home-path.js');
const { parseTranscriptText } = await import('../transcript/parse.js');

const FROM = '/Users/joeblack';
const TO = '/Users/joe';
const OLD_FOO = '-Users-joeblack-foo';
const NEW_FOO = '-Users-joe-foo';
const OLD_BAR = '-Users-joeblack-bar';
const NEW_BAR = '-Users-joe-bar';
const U1 = 'u1.jsonl';
const U2 = 'u2.jsonl';

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

describe('migrateHomePaths — rewrite-target enumeration failures', () => {
  let root: string;
  let baseDir: string;
  beforeEach(() => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cc-recall-mig-rte-'));
    root = path.join(tmp, 'projects');
    baseDir = path.join(tmp, 'base');
    seed(root, OLD_FOO, U1, '/Users/joeblack/foo');
    seed(root, OLD_BAR, U2, '/Users/joeblack/bar');
    fsHook.unreadableDir = null;
  });
  afterEach(() => {
    rmSync(path.dirname(root), { recursive: true, force: true });
  });

  it('an unreadable rewrite-target directory does not abort the run', () => {
    // OLD_FOO renames to NEW_FOO with no collision (no pre-existing NEW_FOO). After the rename
    // succeeds, rewriteTargets tries to enumerate NEW_FOO for .jsonl files — make that call fail.
    fsHook.unreadableDir = path.join(root, NEW_FOO);

    const manifest = migrateHomePaths({
      from: FROM,
      to: TO,
      projectsRoot: root,
      baseDir,
      dryRun: false,
    });

    expect(
      manifest.failures?.some((f) => f.stage === 'dir-move' && f.target.endsWith(NEW_FOO)),
    ).toBe(true);
    // The dir move itself already succeeded — only enumeration for rewriting failed.
    expect(existsSync(path.join(root, OLD_FOO))).toBe(false);
    expect(existsSync(path.join(root, NEW_FOO, U1))).toBe(true);
    // The other directory's transcript was still discovered and rewritten normally.
    const moved = parseTranscriptText(readFileSync(path.join(root, NEW_BAR, U2), 'utf8'), U2);
    expect(moved.cwd).toBe('/Users/joe/bar');
  });
});
