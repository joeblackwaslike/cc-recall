import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { synthesizeHeuristic } from '../record/synthesizer.js';
import { parseTranscriptText } from '../transcript/parse.js';
import { writeFrontPage } from './native-memory.js';
import { type Sidecar, openSidecar } from './sidecar.js';

const TS = '2026-01-01T00:00:00.000Z';
const BIG = 's-big';
const SMALL = 's-small';
const REFACTOR = 'the big important refactor';
const userLine = (sessionId: string, text: string, timestamp: string): string =>
  JSON.stringify({
    type: 'user',
    sessionId,
    cwd: '/x',
    timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });

describe('native-memory front page', () => {
  let sidecar: Sidecar;
  let dir: string;
  beforeEach(() => {
    sidecar = openSidecar(':memory:');
    dir = mkdtempSync(path.join(tmpdir(), 'cc-recall-fp-'));
    const seed = (id: string, parsedText: string, hash: string): void => {
      const parsed = parseTranscriptText(parsedText, `/x/${id}.jsonl`);
      sidecar.upsert(
        synthesizeHeuristic({ parsed, project: 'proj', provenance: 'backfill' }),
        hash,
      );
    };
    seed(
      BIG,
      `${userLine(BIG, REFACTOR, TS)}\n${userLine(BIG, 'more', '2026-01-02T00:00:00.000Z')}`,
      'h1',
    );
    seed(SMALL, userLine(SMALL, 'tiny', TS), 'h2');
  });
  afterEach(() => {
    sidecar.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a curated page with the most significant sessions first', () => {
    const target = path.join(dir, 'FRONTPAGE.md');
    const result = writeFrontPage(sidecar, { path: target, topN: 10, dbPath: '/db/x.db' });
    expect(result.count).toBe(2);
    const content = readFileSync(target, 'utf8');
    expect(content).toContain('Most significant sessions');
    expect(content).toContain(REFACTOR);
    // the larger session is listed before the smaller one
    expect(content.indexOf(REFACTOR)).toBeLessThan(content.indexOf('tiny'));
  });
});
