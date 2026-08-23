import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backfill } from './engine.js';
import { type Sidecar, openSidecar } from './surfaces/sidecar.js';

// Split out of engine.test.ts to stay under the file's max-lines budget — these tests share no
// state with the rest of the suite, only the fixture helpers below.

const PROJECT_DIR = '-Users-joe-proj';
const CWD = '/Users/joe/proj';
const FIXTURE_TIMESTAMP = '2026-01-01T00:00:00.000Z';

const STUB_ENRICHMENT = JSON.stringify({
  title: 'stub',
  summary: 'stub',
  asks_implemented: [],
  completions: [],
  facets: { completed: [], questioned: [], asked_about: [] },
  distinctive_phrases: [],
});

const TWO = 2;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const ONE_HOUR_MS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE * 1000;

const seedBatch = (dir: string, count: number): void => {
  for (let index = 0; index < count; index += 1) {
    const id = `s-batch-${index}`;
    const file = path.join(dir, `${id}.jsonl`);
    writeFileSync(
      file,
      `${JSON.stringify({
        type: 'user',
        sessionId: id,
        cwd: CWD,
        timestamp: FIXTURE_TIMESTAMP,
        message: { role: 'user', content: [{ type: 'text', text: `session ${index}` }] },
      })}\n`,
    );
    // Backdate: these fixtures represent historical, already-closed sessions being backfilled,
    // not a session actively appending right now (cc-recall-kg8's active-session guard).
    const past = new Date(Date.now() - ONE_HOUR_MS);
    utimesSync(file, past, past);
  }
};

/**
 * Seeds two sessions and runs one backfill pass where the first enriches and the second degrades
 * (LLM rejects). Shared setup for the --only-heuristic repair tests below.
 */
const seedOneEnrichedOneDegraded = async (
  sidecar: Sidecar,
  projectDir: string,
  root: string,
  baseDir: string,
): Promise<void> => {
  seedBatch(projectDir, TWO);
  let call = 0;
  await backfill(sidecar, {
    projectsRoot: root,
    baseDir,
    skipClaudeMem: true,
    llm: () => {
      call += 1;
      return call === 1 ? Promise.resolve(STUB_ENRICHMENT) : Promise.reject(new Error('down'));
    },
  });
};

describe('engine — heuristic records are identifiable and repairable', () => {
  let root: string;
  let baseDir: string;
  let projectDir: string;
  let sidecar: Sidecar;

  beforeEach(() => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cc-recall-rep-'));
    root = path.join(tmp, 'projects');
    baseDir = path.join(tmp, 'base');
    projectDir = path.join(root, PROJECT_DIR);
    mkdirSync(projectDir, { recursive: true });
    sidecar = openSidecar(':memory:');
  });
  afterEach(() => {
    sidecar.close();
    rmSync(path.dirname(root), { recursive: true, force: true });
  });

  it('stamps a failed LLM pass as heuristic, with the reason', async () => {
    seedBatch(projectDir, 1);
    await backfill(sidecar, {
      projectsRoot: root,
      baseDir,
      skipClaudeMem: true,
      llm: () => Promise.reject(new Error('429 rate limited')),
    });
    const stored = sidecar.get('s-batch-0');
    expect(stored?.enrichment).toBe('heuristic');
    expect(stored?.enrichment_error).toMatch(/429/);
  });

  it('stamps a successful LLM pass as llm', async () => {
    seedBatch(projectDir, 1);
    await backfill(sidecar, {
      projectsRoot: root,
      baseDir,
      skipClaudeMem: true,
      llm: () => Promise.resolve(STUB_ENRICHMENT),
    });
    const stored = sidecar.get('s-batch-0');
    expect(stored?.enrichment).toBe('llm');
    expect(stored?.enrichment_error).toBeUndefined();
  });

  it('--only-heuristic re-synthesizes the degraded and leaves the enriched alone', async () => {
    await seedOneEnrichedOneDegraded(sidecar, projectDir, root, baseDir);

    // Repair pass with force, so the hash check does not skip everything.
    let repairCalls = 0;
    const repair = await backfill(sidecar, {
      projectsRoot: root,
      baseDir,
      skipClaudeMem: true,
      force: true,
      onlyHeuristic: true,
      llm: () => {
        repairCalls += 1;
        return Promise.resolve(STUB_ENRICHMENT);
      },
    });

    // The whole point: one LLM call, not two. The already-enriched session is skipped before
    // synthesis rather than after.
    expect(repairCalls).toBe(1);
    expect(repair.skipped).toBe(1);
    expect(sidecar.get('s-batch-1')?.enrichment).toBe('llm');
  });

  it('--only-heuristic alone repairs a degraded session, without also requiring --force', async () => {
    // The advertised repair command is `--only-heuristic`, not `--only-heuristic --force`. A
    // degraded record's transcript is typically unchanged since it was last indexed -- that's
    // the normal repair scenario -- so if onlyHeuristic doesn't bypass the unchanged-hash skip on
    // its own, the command silently does nothing for the exact case it exists to fix.
    await seedOneEnrichedOneDegraded(sidecar, projectDir, root, baseDir);

    let repairCalls = 0;
    await backfill(sidecar, {
      projectsRoot: root,
      baseDir,
      skipClaudeMem: true,
      onlyHeuristic: true,
      llm: () => {
        repairCalls += 1;
        return Promise.resolve(STUB_ENRICHMENT);
      },
    });

    expect(repairCalls).toBe(1);
    expect(sidecar.get('s-batch-1')?.enrichment).toBe('llm');
  });
});
