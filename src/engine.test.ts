import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backfill, coverage, indexSession } from './engine.js';
import { RECALL_RECORD_TYPE } from './record/schema.js';
import { type Sidecar, openSidecar } from './surfaces/sidecar.js';

const PROJECT_DIR = '-Users-joe-proj';
const SESSION = 's-e';
const CWD = '/Users/joe/proj';
const FIXTURE_TIMESTAMP = '2026-01-01T00:00:00.000Z';

const transcript = `${JSON.stringify({
  type: 'user',
  sessionId: SESSION,
  cwd: CWD,
  timestamp: FIXTURE_TIMESTAMP,
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

/**
 * A stale-source skip (transcript grew mid-synthesis) must not starve the retry forever
 * (cc-recall-m32): the next pass, once the transcript has gone idle, has to actually write.
 * Extracted out of the `describe` block to keep it under the `max-lines-per-function` cap.
 */
const expectStaleSourceSkipRetriesOnNextPass = async (
  file: string,
  sidecar: Sidecar,
  baseDir: string,
): Promise<void> => {
  // First pass: the injected llm runner appends mid-synthesis, so the writer declines with
  // skipReason 'stale-source' — same setup as the warning test above.
  const first = await indexSession(file, sidecar, {
    baseDir,
    llm: () => appendMidSynthesis(file),
  });
  expect(first.written).toBe(false);
  // Sidecar is already stamped with the new content's hash even though the transcript wasn't
  // written — that's the divergence m32 describes.
  const afterFirst = readFileSync(file, 'utf8');
  expect(afterFirst).not.toContain(RECALL_RECORD_TYPE);

  // Backdate: the mid-synthesis append left a fresh mtime, which would otherwise trip the
  // unrelated active-session guard (cc-recall-kg8) and mask the retry gate under test here.
  const past = new Date(Date.now() - ONE_HOUR_MS);
  utimesSync(file, past, past);

  // Second pass: transcript content hasn't changed since the append (no further mid-synthesis
  // append this time), so a purely source-hash-based guard would treat this as already-current
  // and skip it forever. The fix must retry anyway, because the transcript was never written.
  const second = await indexSession(file, sidecar, { llm: false, baseDir });
  expect(second.skipped).toBe(false);
  expect(second.written).toBe(true);
  const afterSecond = readFileSync(file, 'utf8');
  expect(afterSecond).toContain(RECALL_RECORD_TYPE);
};

/**
 * An active-session skip must not starve the retry forever either (cc-recall-m32). Unlike the
 * stale-source path above, content does NOT change between passes here -- pass 2's source hash
 * is byte-identical to pass 1's. That is exactly the condition under which the pre-fix guard
 * (comparing only `sidecar.getSourceHash(id)` to the current hash) wrongly matched and skipped
 * forever: pass 1's `sidecar.upsert` stamps that hash regardless of whether the transcript write
 * itself lands, so a guard that doesn't also check `transcript_synced_hash` can't tell "already
 * written" apart from "declined, never written."
 */
const expectActiveSessionSkipRetriesOnNextPass = async (
  file: string,
  sidecar: Sidecar,
  baseDir: string,
): Promise<void> => {
  // Pass 1: undo the beforeEach backdate so the transcript's mtime looks fresh, well inside
  // ACTIVE_SESSION_GRACE_MS -- this is what makes the writer's liveness heuristic decline the
  // write with skipReason 'active-session' rather than 'stale-source' (content isn't changing).
  utimesSync(file, new Date(), new Date());
  const warnings: string[] = [];
  const first = await indexSession(file, sidecar, {
    baseDir,
    llm: false,
    onWarn: (m) => {
      warnings.push(m);
    },
  });
  expect(first.written).toBe(false);
  expect(warnings.some((w) => w.includes('looked live'))).toBe(true);
  const afterFirst = readFileSync(file, 'utf8');
  expect(afterFirst).not.toContain(RECALL_RECORD_TYPE);

  // Pass 2: age the mtime past the liveness threshold. Content is untouched -- byte-identical to
  // pass 1 -- so the write must still happen: the transcript was never actually synced.
  const past = new Date(Date.now() - ONE_HOUR_MS);
  utimesSync(file, past, past);
  const second = await indexSession(file, sidecar, { llm: false, baseDir });
  expect(second.skipped).toBe(false);
  expect(second.written).toBe(true);
  const afterSecond = readFileSync(file, 'utf8');
  expect(afterSecond).toContain(RECALL_RECORD_TYPE);
};

const GARBAGE_PROJECT_DIR = '-';

const garbageTranscript = (sessionId: string): string =>
  `${JSON.stringify({
    type: 'user',
    sessionId,
    cwd: '/',
    timestamp: FIXTURE_TIMESTAMP,
    message: { role: 'user', content: [{ type: 'text', text: 'garbage' }] },
  })}\n`;

/**
 * A session whose project dir is the degenerate slug "-" (Claude Code's encoding of a
 * degenerate cwd like "/") must never be indexed (cc-recall-xkf).
 */
const expectGarbageProjectDirIsSkipped = async (
  root: string,
  sidecar: Sidecar,
  baseDir: string,
): Promise<void> => {
  const garbageDir = path.join(root, GARBAGE_PROJECT_DIR);
  mkdirSync(garbageDir, { recursive: true });
  const garbageFile = path.join(garbageDir, 'ghost.jsonl');
  writeFileSync(garbageFile, garbageTranscript('ghost'));
  const past = new Date(Date.now() - ONE_HOUR_MS);
  utimesSync(garbageFile, past, past);

  const result = await indexSession(garbageFile, sidecar, { llm: false, baseDir });
  expect(result.skipped).toBe(true);
  expect(result.written).toBe(false);
  expect(sidecar.get('ghost')).toBeUndefined();
};

/**
 * Same bug, enumeration side: the garbage dir must never be enumerated at all, not merely
 * skipped after being read (cc-recall-xkf).
 */
const expectGarbageProjectDirExcludedFromBackfill = async (
  root: string,
  sidecar: Sidecar,
  baseDir: string,
): Promise<void> => {
  const garbageDir = path.join(root, GARBAGE_PROJECT_DIR);
  mkdirSync(garbageDir, { recursive: true });
  writeFileSync(path.join(garbageDir, 'ghost2.jsonl'), garbageTranscript('ghost2'));

  const summary = await backfill(sidecar, { projectsRoot: root, baseDir, llm: false });
  // Only the real fixture session from beforeEach should be counted — the garbage dir must
  // never be enumerated at all, not merely skipped after being read.
  expect(summary.total).toBe(1);
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
    // Backdate: most tests in this block backfill this fixture, which represents a historical,
    // already-closed session, not one actively appending right now (cc-recall-kg8's guard).
    // `appendMidSynthesis` explicitly re-touches the file to simulate a live append and is
    // exempted from this by using an injected `llm` runner, not a real timing gap.
    const past = new Date(Date.now() - ONE_HOUR_MS);
    utimesSync(file, past, past);
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

  it('retries the transcript write on the next pass after a stale-source skip (cc-recall-m32)', async () => {
    await expectStaleSourceSkipRetriesOnNextPass(file, sidecar, baseDir);
  });

  it('retries the transcript write on the next pass after an active-session skip (cc-recall-m32)', async () => {
    await expectActiveSessionSkipRetriesOnNextPass(file, sidecar, baseDir);
  });

  it('skips a session whose project directory is the degenerate slug "-" (cc-recall-xkf)', async () => {
    await expectGarbageProjectDirIsSkipped(root, sidecar, baseDir);
  });

  it('excludes the degenerate "-" project directory from backfill enumeration', async () => {
    await expectGarbageProjectDirExcludedFromBackfill(root, sidecar, baseDir);
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
