import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backfill, coverage, indexSession } from './engine.js';
import { RECALL_RECORD_TYPE } from './record/schema.js';
import { type Sidecar, openSidecar } from './surfaces/sidecar.js';

const PROJECT_DIR = '-Users-joe-proj';
const SESSION = 's-e';

const transcript = `${JSON.stringify({
  type: 'user',
  sessionId: SESSION,
  cwd: '/Users/joe/proj',
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
      cwd: '/Users/joe/proj',
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
