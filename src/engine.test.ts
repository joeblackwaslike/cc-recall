import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backfill, coverage, indexSession } from './engine.js';
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

  it('backfill is idempotent across runs', async () => {
    const first = await backfill(sidecar, { projectsRoot: root, baseDir, llm: false });
    expect(first.written).toBe(1);
    expect(coverage(sidecar, root).indexed).toBe(1);
    const second = await backfill(sidecar, { projectsRoot: root, baseDir, llm: false });
    expect(second.skipped).toBe(1);
    expect(second.written).toBe(0);
  });
});
