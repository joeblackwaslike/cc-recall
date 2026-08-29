// If a real destructive op succeeds but the journal append that should record it then throws
// (e.g. disk full), the per-op catch block calls recordFailure — whose own journal append for
// the *failure* entry can throw for the same reason. That second throw must not itself escape
// and abort the run; the whole point of per-op resilience is that no single write, successful
// or not, can take the rest of the migration down with it. Reaching this needs every journal
// append after the first (`begin`) to fail deterministically, so `node:fs` is mocked here — in
// its own file, so the rest of the suite keeps running against the real thing.
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
    fsHook.failAppendsAfterFirst = false;
    fsHook.appendCount = 0;
  });
  afterEach(() => {
    rmSync(path.dirname(root), { recursive: true, force: true });
  });

  it("a failing journal append inside recordFailure's own failure path does not abort the run", () => {
    // First appendFileSync call is the `begin` line (pre-flight, allowed to succeed); every
    // append after that fails — including both the op's own success-append and, in its catch
    // block, recordFailure's failure-append for the same op.
    fsHook.failAppendsAfterFirst = true;

    const manifest = migrateHomePaths({
      from: FROM,
      to: TO,
      projectsRoot: root,
      baseDir,
      dryRun: false,
    });

    expect(manifest.failures?.length).toBeGreaterThan(0);
    // The directory move itself still happened on disk — only the journal bookkeeping failed.
    expect(existsSync(path.join(root, OLD_FOO))).toBe(false);
    const moved = parseTranscriptText(readFileSync(path.join(root, NEW_FOO, U1), 'utf8'), U1);
    expect(moved.cwd).toBe('/Users/joe/foo');
  });
});
