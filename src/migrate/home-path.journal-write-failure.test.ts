// Two things need a failing appendFileSync to reach deterministically, so `node:fs` is mocked
// here — in its own file, so the rest of the suite keeps running against the real thing:
//   1. A destructive op that SUCCEEDS but whose own post-op journal append then fails (e.g.
//      disk full) must not be recorded as an operation failure — the file really did move; only
//      the journal bookkeeping for it is missing (a known, tracked residual gap, not something
//      this run should report as "N op(s) failed").
//   2. A destructive op that genuinely FAILS, whose failure gets recorded via recordFailure —
//      recordFailure's own journal append for that failure entry can throw for the same reason,
//      and that second throw must not itself escape and abort the run.
import type * as NodeFs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsHook = vi.hoisted(() => ({ failAppendsAfterFirst: false, appendCount: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const appendFileSync = ((...args: Parameters<typeof actual.appendFileSync>) => {
    fsHook.appendCount += 1;
    if (fsHook.failAppendsAfterFirst && fsHook.appendCount > 1) {
      throw new Error('ENOSPC: no space left on device, write');
    }
    actual.appendFileSync(...args);
  }) as typeof actual.appendFileSync;
  return { ...actual, default: actual, appendFileSync };
});

// Imported after the mock so it picks up the mocked `appendFileSync`.
const { migrateHomePaths } = await import('./home-path.js');
const { parseTranscriptText } = await import('../transcript/parse.js');

const FROM = '/Users/joeblack';
const TO = '/Users/joe';
const OLD_FOO = '-Users-joeblack-foo';
const NEW_FOO = '-Users-joe-foo';
const U1 = 'u1.jsonl';

const userLine = (sessionId: string, cwd: string): string =>
  JSON.stringify({
    type: 'user',
    sessionId,
    cwd,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: `work in ${cwd}/sub dir` }] },
  });

describe('migrateHomePaths — journal write failures', () => {
  let root: string;
  let baseDir: string;
  beforeEach(() => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cc-recall-mig-jwf-'));
    root = path.join(tmp, 'projects');
    baseDir = path.join(tmp, 'base');
    mkdirSync(path.join(root, OLD_FOO), { recursive: true });
    writeFileSync(path.join(root, OLD_FOO, U1), `${userLine(U1, '/Users/joeblack/foo')}\n`);
    // A directory named `bad.jsonl`, not a file, alongside the real seeded file — a genuine
    // operation failure (EISDIR) that must go through recordFailure, independent of the journal
    // mock below.
    mkdirSync(path.join(root, OLD_FOO, 'bad.jsonl'), { recursive: true });
    fsHook.failAppendsAfterFirst = false;
    fsHook.appendCount = 0;
  });
  afterEach(() => {
    rmSync(path.dirname(root), { recursive: true, force: true });
  });

  it('a post-success journal append failure is not reported as an operation failure, and recordFailure surviving its own append failure does not abort the run', () => {
    // First appendFileSync call is the `begin` line (pre-flight, allowed to succeed); every
    // append after that fails — including the dir-move's own success-append, the rewrite's own
    // genuine EISDIR failure's recordFailure append, and any other post-op append in the run.
    fsHook.failAppendsAfterFirst = true;

    const manifest = migrateHomePaths({
      from: FROM,
      to: TO,
      projectsRoot: root,
      baseDir,
      dryRun: false,
    });

    // The dir-move (renameSync) genuinely succeeded — only its journal append failed. That must
    // not appear in failures: reporting a succeeded operation as failed misleads a user into
    // retrying something that already happened.
    expect(manifest.failures?.some((f) => f.stage === 'dir-move')).toBe(false);
    // The rewrite's EISDIR is a real operation failure and must still be recorded — and
    // recordFailure's own (also-mocked-to-fail) journal append for it must not crash the run.
    expect(manifest.failures?.some((f) => f.stage === 'file-rewrite')).toBe(true);
    // The directory move itself still happened on disk.
    expect(existsSync(path.join(root, OLD_FOO))).toBe(false);
    const moved = parseTranscriptText(readFileSync(path.join(root, NEW_FOO, U1), 'utf8'), U1);
    expect(moved.cwd).toBe('/Users/joe/foo');
  });
});
