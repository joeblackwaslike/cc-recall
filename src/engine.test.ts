import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backfill, coverage, indexSession } from './engine.js';
import { RECALL_RECORD_TYPE } from './record/schema.js';
import { type Sidecar, openSidecar } from './surfaces/sidecar.js';

const PROJECT_DIR = '-Users-joe-proj';
const SESSION = 's-e';
const CWD = '/Users/joe/proj';

const transcript = `${JSON.stringify({
  type: 'user',
  sessionId: SESSION,
  cwd: CWD,
  timestamp: '2026-01-01T00:00:00.000Z',
  message: { role: 'user', content: [{ type: 'text', text: 'wire up the engine' }] },
})}\n`;

const STUB_ENRICHMENT = JSON.stringify({
  title: 'stub',
  summary: 'stub',
  asks_implemented: [],
  completions: [],
  facets: { completed: [], questioned: [], asked_about: [] },
  distinctive_phrases: [],
});

/** Stands in for a live session appending while synthesis is in flight. */
const appendMidSynthesis = (file: string): Promise<string> => {
  writeFileSync(
    file,
    `${transcript.trimEnd()}\n${JSON.stringify({
      type: 'user',
      sessionId: SESSION,
      cwd: CWD,
      timestamp: '2026-01-02T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'appended mid-synthesis' }] },
    })}\n`,
  );
  return Promise.resolve(STUB_ENRICHMENT);
};

describe('engine', () => {
  let root: string;
  let baseDir: string;
  let file: string;
  let sidecar: Sidecar;
  beforeEach(() => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cc-recall-eng-'));
    root = path.join(tmp, 'projects');
    baseDir = path.join(tmp, 'base');
    mkdirSync(path.join(root, PROJECT_DIR), { recursive: true });
    file = path.join(root, PROJECT_DIR, `${SESSION}.jsonl`);
    writeFileSync(file, transcript);
    sidecar = openSidecar(':memory:');
  });
  afterEach(() => {
    sidecar.close();
    rmSync(path.dirname(root), { recursive: true, force: true });
  });

  it('indexes a session into the sidecar and transcript (heuristic, no LLM)', async () => {
    const result = await indexSession(file, sidecar, {
      llm: false,
      baseDir,
      provenance: 'forward',
    });
    expect(result.written).toBe(true);
    expect(sidecar.get(SESSION)?.title).toBe('wire up the engine');
    expect(sidecar.get(SESSION)?.project).toBe(PROJECT_DIR);
    expect(sidecar.get(SESSION)?.provenance).toBe('forward');
  });

  it('skips an unchanged session on re-index', async () => {
    await indexSession(file, sidecar, { llm: false, baseDir });
    const second = await indexSession(file, sidecar, { llm: false, baseDir });
    expect(second.skipped).toBe(true);
    expect(second.written).toBe(false);
  });

  it('dry-run neither writes the sidecar nor the transcript', async () => {
    const result = await indexSession(file, sidecar, { dryRun: true, baseDir });
    expect(result.written).toBe(false);
    expect(sidecar.get(SESSION)).toBeUndefined();
  });

  // The stale-source skip is only recoverable if someone can see it happened — a silent skip
  // leaves the sidecar advanced while the transcript lags, with nothing to act on.
  // The injected llm runner executes between indexSession's read and its write, which is
  // precisely the window a live session appends in.
  it('warns when the transcript grows past the content the record was synthesized from', async () => {
    const warnings: string[] = [];
    await indexSession(file, sidecar, {
      baseDir,
      llm: () => appendMidSynthesis(file),
      onWarn: (m) => {
        warnings.push(m);
      },
    });

    expect(warnings.some((w) => w.includes('grew during synthesis'))).toBe(true);
    // The appended turn survives — the write was declined, not applied over stale content.
    const after = readFileSync(file, 'utf8');
    expect(after).toContain('appended mid-synthesis');
    // And the write really was declined: no cc-recall record was injected.
    expect(after).not.toContain(RECALL_RECORD_TYPE);
  });

  it('backfill is idempotent across runs', async () => {
    const first = await backfill(sidecar, { projectsRoot: root, baseDir, llm: false });
    expect(first.written).toBe(1);
    expect(coverage(sidecar, root).indexed).toBe(1);
    const second = await backfill(sidecar, { projectsRoot: root, baseDir, llm: false });
    expect(second.skipped).toBe(1);
    expect(second.written).toBe(0);
  });
});

const THREE = 3;
const SIX = 6;
const EIGHT = 8;
const TEN = 10;
const TWO = 2;

const seedBatch = (dir: string, count: number): void => {
  for (let index = 0; index < count; index += 1) {
    const id = `s-batch-${index}`;
    writeFileSync(
      path.join(dir, `${id}.jsonl`),
      `${JSON.stringify({
        type: 'user',
        sessionId: id,
        cwd: CWD,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: `session ${index}` }] },
      })}\n`,
    );
  }
};

/**
 * Enrichment failure is deliberately not an error — one degraded record beats a failed run. The
 * hazard is that nothing throws, `failed` stays 0, and a run that lost the LLM entirely reports a
 * clean sweep. It also gets there sooner than a healthy run, because a failing call returns in
 * milliseconds where a successful one takes seconds.
 */
describe('engine — LLM degradation is visible and bounded', () => {
  let root: string;
  let baseDir: string;
  let projectDir: string;
  let sidecar: Sidecar;

  beforeEach(() => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cc-recall-deg-'));
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

  it('counts heuristic fallbacks separately from writes', async () => {
    seedBatch(projectDir, THREE);
    const summary = await backfill(sidecar, {
      projectsRoot: root,
      baseDir,
      skipClaudeMem: true,
      llm: () => Promise.reject(new Error('429 rate limited')),
    });
    // Every record still lands — that is the intended degradation. What must not happen is the
    // summary being indistinguishable from a healthy run.
    expect(summary.written).toBe(THREE);
    expect(summary.failed).toBe(0);
    expect(summary.degraded).toBe(THREE);
    expect(summary.enriched).toBe(0);
  });

  it('aborts once LLM failures are consecutive and systematic', async () => {
    seedBatch(projectDir, TEN);
    const summary = await backfill(sidecar, {
      projectsRoot: root,
      baseDir,
      skipClaudeMem: true,
      maxConsecutiveLlmFailures: THREE,
      llm: () => Promise.reject(new Error('worker down')),
    });
    expect(summary.abortedReason).toMatch(/consecutive LLM failures/);
    expect(summary.processed).toBeLessThan(summary.total);
  });

  it('does not abort when failures are intermittent rather than systematic', async () => {
    seedBatch(projectDir, SIX);
    let calls = 0;
    const summary = await backfill(sidecar, {
      projectsRoot: root,
      baseDir,
      skipClaudeMem: true,
      maxConsecutiveLlmFailures: THREE,
      llm: () => {
        calls += 1;
        return calls % TWO === 0
          ? Promise.reject(new Error('flaky'))
          : Promise.resolve(STUB_ENRICHMENT);
      },
    });
    // A success resets the counter, so alternating failures must never trip the breaker.
    expect(summary.abortedReason).toBeUndefined();
    expect(summary.processed).toBe(summary.total);
    expect(summary.enriched).toBeGreaterThan(0);
    expect(summary.degraded).toBeGreaterThan(0);
  });

  it('stops at the LLM call ceiling even with files remaining', async () => {
    seedBatch(projectDir, EIGHT);
    const summary = await backfill(sidecar, {
      projectsRoot: root,
      baseDir,
      skipClaudeMem: true,
      maxLlmCalls: TWO,
      llm: () => Promise.resolve(STUB_ENRICHMENT),
    });
    expect(summary.abortedReason).toMatch(/max-llm-calls/);
    expect(summary.processed).toBeLessThan(summary.total);
  });
});

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
    seedBatch(projectDir, TWO);
    // First pass: session 0 enriched, session 1 degraded.
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
});
