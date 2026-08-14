// Regression suite for cc-recall's indexer self-recognition guard (cc-recall-hie, cc-recall-4fc).
//
// isIndexerTranscript() had a passing unit test for weeks while being completely inert in
// production: its detection field was silently filtered by promptSource: 'sdk', a tag real
// `claude -p` headless runs carry that no hand-written test fixture happened to set. The fix
// (cc-recall-hie) restored the prompt-signature signal; this file also covers the second,
// independent signal added afterward (cc-recall-4fc): any transcript inside the indexer's own
// dedicated cwd is structurally guaranteed to be one of cc-recall's own runs, not a heuristic.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INDEXER_PROJECT_DIR, indexSession } from './engine.js';
import { openSidecar } from './surfaces/sidecar.js';

const REAL_PROJECT_DIR = '-Users-joe-proj';

// Golden fixture, deliberately NOT derived from the production constant
// (`INDEXER_PROMPT_SIGNATURE` in src/record/synthesizer.ts) -- see indexer-isolation.test.ts's
// copy of this same constant for why the duplication is the assertion.
const INDEXER_PROMPT =
  'You are indexing a Claude Code session transcript so it can be found later by what\nwas DONE, ASKED, and QUESTIONED.';

const ENRICHMENT_JSON = JSON.stringify({
  title: 'stub',
  summary: 'stub',
  asks_implemented: [],
  completions: [],
  facets: { completed: [], questioned: [], asked_about: [] },
  distinctive_phrases: [],
});

const transcriptOf = (sessionId: string, firstPrompt: string, promptSource?: string): string =>
  `${JSON.stringify({
    type: 'user',
    sessionId,
    cwd: '/Users/joe/proj',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...(promptSource && { promptSource }),
    message: { role: 'user', content: [{ type: 'text', text: firstPrompt }] },
  })}\n`;

describe('self-recognition guard (cc-recall-hie)', () => {
  let root: string;
  let baseDir: string;
  let sidecar: ReturnType<typeof openSidecar>;

  beforeEach(() => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cc-recall-iso-sdk-'));
    root = path.join(tmp, 'projects');
    baseDir = path.join(tmp, 'base');
    mkdirSync(path.join(root, INDEXER_PROJECT_DIR), { recursive: true });
    sidecar = openSidecar(':memory:');
  });
  afterEach(() => {
    sidecar.close();
    rmSync(path.dirname(root), { recursive: true, force: true });
  });

  // Reproduces cc-recall-hie: `runClaudeHeadless` invokes `claude -p`, and Claude Code tags
  // that prompt's own transcript record `promptSource: 'sdk'` (confirmed against a real
  // on-disk transcript). `genuinePrompt()` (src/transcript/parse.ts) filters out any record
  // with `promptSource: 'sdk'`, so `parsed.firstUserPrompt` -- what `isIndexerTranscript()`
  // above actually reads -- comes back `undefined` for every one of the indexer's own
  // transcripts, silently defeating this guard for real headless runs even though it passes
  // for the plain fixture elsewhere in this file.
  it("skips the indexer's own transcript even though claude -p tags its prompt promptSource: sdk", async () => {
    const file = path.join(root, INDEXER_PROJECT_DIR, 'own-run-sdk.jsonl');
    writeFileSync(file, transcriptOf('own-run-sdk', INDEXER_PROMPT, 'sdk'));
    let wasCalled = false;
    const result = await indexSession(file, sidecar, {
      baseDir,
      llm: () => {
        wasCalled = true;
        return Promise.resolve(ENRICHMENT_JSON);
      },
    });
    expect(wasCalled).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.written).toBe(false);
  });
});

describe('dual-signal indexer recognition (cc-recall-4fc)', () => {
  let root: string;
  let baseDir: string;
  let metricsRoot: string;
  let sidecar: ReturnType<typeof openSidecar>;

  beforeEach(() => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cc-recall-iso-dual-'));
    root = path.join(tmp, 'projects');
    baseDir = path.join(tmp, 'base');
    mkdirSync(path.join(root, INDEXER_PROJECT_DIR), { recursive: true });
    sidecar = openSidecar(':memory:');
    metricsRoot = mkdtempSync(path.join(tmpdir(), 'cc-recall-dual-metrics-'));
    vi.stubEnv('CC_RECALL_METRICS_DIR', metricsRoot);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    sidecar.close();
    rmSync(path.dirname(root), { recursive: true, force: true });
    rmSync(metricsRoot, { recursive: true, force: true });
  });

  const mismatchIncidentKind = 'indexer_recognition_mismatch';

  const incidentsContent = (): string => {
    const file = path.join(metricsRoot, 'incidents.jsonl');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  };

  // The one case that would have caught cc-recall-hie on day one: something structurally
  // guaranteed to be an indexer run (it's in the indexer's own dedicated cwd -- runClaudeHeadless
  // always pins cwd: INDEXER_CWD) that the prompt heuristic failed to recognize. Dir-match alone
  // still skips it safely, but the disagreement itself must be loud, not silent.
  it('recognizes an indexer transcript by directory alone, and flags the prompt-heuristic disagreement', async () => {
    const file = path.join(root, INDEXER_PROJECT_DIR, 'not-signed.jsonl');
    writeFileSync(file, transcriptOf('not-signed', 'this is not the indexer prompt at all'));
    let wasCalled = false;
    const result = await indexSession(file, sidecar, {
      baseDir,
      llm: () => {
        wasCalled = true;
        return Promise.resolve(ENRICHMENT_JSON);
      },
    });
    expect(wasCalled).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.written).toBe(false);
    expect(incidentsContent()).toContain(mismatchIncidentKind);
  });

  // Expected, already-handled case (enrichment runs predating the dedicated cwd land in real
  // project dirs, per the comment above) -- not a signal disagreement, must not be flagged, or
  // the incident log stops being a trustworthy signal.
  it('does not flag a historical stray transcript recognized by prompt alone outside the dedicated cwd', async () => {
    mkdirSync(path.join(root, REAL_PROJECT_DIR), { recursive: true });
    const file = path.join(root, REAL_PROJECT_DIR, 'stray.jsonl');
    writeFileSync(file, transcriptOf('stray', INDEXER_PROMPT));
    const result = await indexSession(file, sidecar, { llm: false, baseDir });
    expect(result.skipped).toBe(true);
    expect(incidentsContent()).not.toContain(mismatchIncidentKind);
  });

  // Regression lock for cc-recall-hie's own fix composing with this one: a real indexer
  // transcript (promptSource: 'sdk', matching production) agrees on both signals -- no mismatch.
  it('does not flag agreement between both signals', async () => {
    const file = path.join(root, INDEXER_PROJECT_DIR, 'agrees.jsonl');
    writeFileSync(file, transcriptOf('agrees', INDEXER_PROMPT, 'sdk'));
    const result = await indexSession(file, sidecar, { llm: false, baseDir });
    expect(result.skipped).toBe(true);
    expect(incidentsContent()).not.toContain(mismatchIncidentKind);
  });
});
