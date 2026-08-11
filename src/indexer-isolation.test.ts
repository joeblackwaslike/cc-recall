// Regression suite for the enrichment-subprocess cost/loop defects.
//
// A backfill run spawned ~2,825 headless sessions in ~43h, consuming an estimated 69% of a
// weekly quota. Three compounding defects: the subprocess inherited the interactive model
// (~20x unit cost), inherited the full settings prefix (~24x context over payload), and wrote
// its own transcript into the corpus it was consuming — so the work queue could never drain.
//
// The convergence test at the bottom is the one that pins the bug class; the rest check the
// mechanics that produce it.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => void;

interface Emitter {
  on: (event: string, callback: Handler) => void;
  fire: (event: string, ...args: unknown[]) => void;
}

/** Minimal stand-in for the child_process event surface `runClaudeHeadless` actually uses. */
const emitter = (): Emitter => {
  const handlers = new Map<string, Handler>();
  return {
    on: (event: string, callback: Handler) => {
      handlers.set(event, callback);
    },
    fire: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
  };
};

const { spawnCalls, stdinWrites, killSignals } = vi.hoisted(() => ({
  spawnCalls: [] as { command: string; args: string[]; options: Record<string, unknown> }[],
  stdinWrites: [] as string[],
  killSignals: [] as unknown[],
}));

const ENRICHMENT_JSON = JSON.stringify({
  title: 'stub',
  summary: 'stub',
  asks_implemented: [],
  completions: [],
  facets: { completed: [], questioned: [], asked_about: [] },
  distinctive_phrases: [],
});

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    spawnCalls.push({ command, args, options });
    const stdout = emitter();
    const child = {
      ...emitter(),
      stdout,
      stderr: emitter(),
      stdin: {
        ...emitter(),
        end: (data: unknown) => {
          stdinWrites.push(String(data));
        },
      },
      kill: (signal: unknown) => {
        killSignals.push(signal);
      },
    };
    queueMicrotask(() => {
      stdout.fire('data', Buffer.from(ENRICHMENT_JSON));
      child.fire('close', 0);
    });
    return child;
  },
}));

const { INDEXER_CWD, isIndexerTranscript, runClaudeHeadless, synthesize } = await import(
  './record/synthesizer.js'
);
const { parseTranscriptText } = await import('./transcript/parse.js');
const { INDEXER_PROJECT_DIR, backfill, indexSession, listTranscripts } = await import(
  './engine.js'
);
const { openSidecar } = await import('./surfaces/sidecar.js');

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const OVERRIDE_MODEL = 'claude-sonnet-5';
const WHITESPACE_ONLY = '\t \n';
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const ONE_HOUR_MS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE * 1000;

/** The argv `runClaudeHeadless` should produce for a given model. */
const invocation = (model: string): string[] => ['-p', '--model', model];
const REAL_PROJECT_DIR = '-Users-joe-proj';

const transcriptOf = (sessionId: string, firstPrompt: string): string =>
  `${JSON.stringify({
    type: 'user',
    sessionId,
    cwd: '/Users/joe/proj',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: firstPrompt }] },
  })}\n`;

// Golden fixture, deliberately NOT derived from the production constant
// (`INDEXER_PROMPT_SIGNATURE` in src/record/synthesizer.ts).
//
// Enrichment transcripts already written to disk carry exactly this opening text, and detection
// must keep matching them indefinitely. Importing the production constant here would make this
// test pass trivially if that constant were ever edited — silently stranding every historical
// transcript. The duplication is the assertion.
const INDEXER_PROMPT =
  'You are indexing a Claude Code session transcript so it can be found later by what\nwas DONE, ASKED, and QUESTIONED.';

describe('enrichment subprocess invocation', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    stdinWrites.length = 0;
    vi.stubEnv('CC_RECALL_MODEL', undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('pins the model instead of inheriting the interactive default', async () => {
    await runClaudeHeadless('prompt');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.args).toEqual(invocation(DEFAULT_MODEL));
  });

  it('honours CC_RECALL_MODEL without a module reload', async () => {
    vi.stubEnv('CC_RECALL_MODEL', OVERRIDE_MODEL);
    await runClaudeHeadless('prompt');
    expect(spawnCalls[0]?.args).toEqual(invocation(OVERRIDE_MODEL));
  });

  it.each([
    ['empty', ''],
    ['whitespace', WHITESPACE_ONLY],
  ])('falls back to the default when CC_RECALL_MODEL is %s', async (_label, value) => {
    vi.stubEnv('CC_RECALL_MODEL', value);
    await runClaudeHeadless('prompt');
    expect(spawnCalls[0]?.args).toEqual(invocation(DEFAULT_MODEL));
  });

  it('trims a padded CC_RECALL_MODEL rather than passing it through', async () => {
    vi.stubEnv('CC_RECALL_MODEL', '  claude-sonnet-5  ');
    await runClaudeHeadless('prompt');
    expect(spawnCalls[0]?.args).toEqual(invocation(OVERRIDE_MODEL));
  });

  it('runs in the dedicated indexer cwd so its own transcript is excludable', async () => {
    await runClaudeHeadless('prompt');
    expect(spawnCalls[0]?.options.cwd).toBe(INDEXER_CWD);
  });

  it('still delivers the prompt over stdin', async () => {
    await runClaudeHeadless('summarise this');
    expect(stdinWrites).toEqual(['summarise this']);
  });

  // Closes the loop between generation and detection. Without this, editing the prompt text
  // would keep generating enrichment runs that the detector no longer recognises — the corpus
  // would quietly start re-indexing its own output again, which is the original defect.
  it('generates a prompt its own detector recognises (round-trip)', async () => {
    const parsed = parseTranscriptText(transcriptOf('rt', 'do a thing'), '/repo/rt.jsonl');
    await synthesize({ parsed, project: 'proj', provenance: 'backfill' });
    expect(stdinWrites).toHaveLength(1);
    expect(isIndexerTranscript(stdinWrites[0])).toBe(true);
  });
});

describe('isIndexerTranscript', () => {
  it('recognises an enrichment run by its opening prompt', () => {
    expect(isIndexerTranscript(INDEXER_PROMPT)).toBe(true);
  });

  it('tolerates leading whitespace', () => {
    expect(isIndexerTranscript(`\n  ${INDEXER_PROMPT}`)).toBe(true);
  });

  // The sentinel spans a literal newline, so a CRLF-stored transcript would fail a naive
  // startsWith and be re-indexed as a real session — quietly reopening the self-indexing loop.
  it('matches a transcript stored with CRLF line endings', () => {
    expect(isIndexerTranscript(INDEXER_PROMPT.replaceAll('\n', '\r\n'))).toBe(true);
  });

  it('does not match ordinary sessions or undefined', () => {
    expect(isIndexerTranscript('index the users table')).toBe(false);
    expect(isIndexerTranscript(undefined)).toBe(false);
  });
});

describe('corpus exclusion and convergence', () => {
  let root: string;
  let baseDir: string;
  let sidecar: ReturnType<typeof openSidecar>;

  const writeTranscript = (dir: string, id: string, prompt: string): string => {
    mkdirSync(path.join(root, dir), { recursive: true });
    const file = path.join(root, dir, `${id}.jsonl`);
    writeFileSync(file, transcriptOf(id, prompt));
    // Backdate: these fixtures represent historical, already-closed sessions being backfilled,
    // not a session actively appending right now. A real mtime this fresh would (correctly) be
    // treated as possibly live by the writer's active-session guard (cc-recall-kg8).
    const past = new Date(Date.now() - ONE_HOUR_MS);
    utimesSync(file, past, past);
    return file;
  };

  beforeEach(() => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cc-recall-iso-'));
    root = path.join(tmp, 'projects');
    baseDir = path.join(tmp, 'base');
    mkdirSync(root, { recursive: true });
    sidecar = openSidecar(':memory:');
  });
  afterEach(() => {
    sidecar.close();
    rmSync(path.dirname(root), { recursive: true, force: true });
  });

  it('excludes the indexer project dir from enumeration', () => {
    writeTranscript(REAL_PROJECT_DIR, 'real', 'wire up the engine');
    writeTranscript(INDEXER_PROJECT_DIR, 'enrich', INDEXER_PROMPT);
    expect(listTranscripts(root).map((f) => path.basename(f))).toEqual(['real.jsonl']);
  });

  it('skips a historical indexer transcript sitting in a real project dir', async () => {
    const file = writeTranscript(REAL_PROJECT_DIR, 'stray', INDEXER_PROMPT);
    const result = await indexSession(file, sidecar, { llm: false, baseDir });
    expect(result.skipped).toBe(true);
    expect(result.written).toBe(false);
    expect(sidecar.get('stray')).toBeUndefined();
  });

  it('does not invoke the LLM for an indexer transcript', async () => {
    const file = writeTranscript(REAL_PROJECT_DIR, 'stray', INDEXER_PROMPT);
    let wasCalled = false;
    await indexSession(file, sidecar, {
      baseDir,
      llm: () => {
        wasCalled = true;
        return Promise.resolve(ENRICHMENT_JSON);
      },
    });
    expect(wasCalled).toBe(false);
  });

  // The hook-triggered path (SessionEnd forward capture): the hook hands indexSession the
  // transcript path directly, straight from an enrichment subprocess's own dedicated cwd. It
  // never goes through listTranscripts' directory-level exclusion (that only protects the
  // backfill scan above), so only isIndexerTranscript's content check protects this path from
  // re-triggering the LLM — this is the mechanism Phase 1 confirmed for Incident B.
  it('skips a transcript inside the indexer project dir when indexed directly (hook forward-capture path)', async () => {
    const file = writeTranscript(INDEXER_PROJECT_DIR, 'own-run', INDEXER_PROMPT);
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

  // The invariant the original defect violated: every enrichment run wrote a transcript back
  // into the corpus, so the queue grew as fast as it drained and backfill never terminated.
  it('reaches a fixed point — enrichment output does not become new work', async () => {
    writeTranscript(REAL_PROJECT_DIR, 'real', 'wire up the engine');
    const before = listTranscripts(root).length;

    const first = await backfill(sidecar, { projectsRoot: root, baseDir, llm: false });
    expect(first.written).toBe(1);

    // Simulate the side effect of that run: the subprocess writes its own transcript, plus a
    // stray one landing in a real project dir the way pre-fix runs did.
    writeTranscript(INDEXER_PROJECT_DIR, 'enrich-1', INDEXER_PROMPT);
    writeTranscript(REAL_PROJECT_DIR, 'enrich-stray', INDEXER_PROMPT);

    expect(listTranscripts(root)).toHaveLength(before + 1); // only the stray is even visible

    const second = await backfill(sidecar, { projectsRoot: root, baseDir, llm: false });
    expect(second.written).toBe(0); // nothing new was real work
    expect(listTranscripts(root)).toHaveLength(before + 1); // and the queue did not grow again

    // `written === 0` alone would also hold if backfill had *errored* on the stray transcript.
    // Assert it was actively skipped and nothing failed, so the test stays diagnostic.
    expect(second.failed).toBe(0);
    expect(second.skipped).toBe(2); // the pre-existing real session, plus the stray enrichment run
  });
});

// A hard ceiling enforced BEFORE spawning, not just cleanup after: covers both the hook path
// (one `synthesize` call per hook-triggered CLI invocation) and backfill (many calls in one
// process) since both funnel through the same `synthesize` gate.
describe('spawn-rate ceiling', () => {
  let metricsRoot: string;

  beforeEach(() => {
    metricsRoot = mkdtempSync(path.join(tmpdir(), 'cc-recall-spawn-'));
    vi.stubEnv('CC_RECALL_METRICS_DIR', metricsRoot);
    vi.stubEnv('CC_RECALL_SPAWN_CEILING', '1');
    vi.stubEnv('CC_RECALL_SPAWN_WINDOW_MS', String(ONE_HOUR_MS));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(metricsRoot, { recursive: true, force: true });
  });

  it('pauses to heuristic-only once the rolling-window spawn ceiling is reached, and logs an incident', async () => {
    const parsedFirst = parseTranscriptText(
      transcriptOf('gate-1', 'first ask'),
      '/repo/gate-1.jsonl',
    );
    const parsedSecond = parseTranscriptText(
      transcriptOf('gate-2', 'second ask'),
      '/repo/gate-2.jsonl',
    );
    let calls = 0;
    const llm = (): Promise<string> => {
      calls += 1;
      return Promise.resolve(ENRICHMENT_JSON);
    };

    const first = await synthesize(
      { parsed: parsedFirst, project: 'proj', provenance: 'backfill' },
      { llm },
    );
    expect(calls).toBe(1);
    expect(first.title).toBe('stub'); // enrichment applied
    expect(first.enrichment).toBe('llm');

    const warnings: string[] = [];
    const outcomes: { ok: boolean; error?: string }[] = [];
    const second = await synthesize(
      { parsed: parsedSecond, project: 'proj', provenance: 'backfill' },
      {
        llm,
        onWarn: (message) => {
          warnings.push(message);
        },
        onLlmOutcome: (outcome) => {
          outcomes.push(outcome);
        },
      },
    );
    // Ceiling of 1/window was already spent by the first call — the LLM must not run again.
    expect(calls).toBe(1);
    expect(second.title).toBe('second ask'); // heuristic fallback, not the enrichment stub
    expect(second.enrichment).toBe('heuristic');
    expect(second.enrichment_error).toMatch(/spawn-rate ceiling/);
    expect(warnings.some((message) => message.includes('spawn-rate ceiling'))).toBe(true);
    // Reported through the same onLlmOutcome channel as a real LLM failure — not the deliberate
    // `llm: false` case — so a sustained block trips backfill's own consecutive-failure breaker
    // instead of silently degrading the rest of the corpus at full LLM cost.
    expect(outcomes).toEqual([{ ok: false, error: second.enrichment_error }]);

    const incidentsFile = path.join(metricsRoot, 'incidents.jsonl');
    expect(existsSync(incidentsFile)).toBe(true);
    expect(readFileSync(incidentsFile, 'utf8')).toContain('spawn_ceiling_paused');
  });

  it('does not spend the ceiling when the LLM is disabled (llm: false)', async () => {
    const parsed = parseTranscriptText(transcriptOf('no-llm', 'ask'), '/repo/no-llm.jsonl');
    const record = await synthesize(
      { parsed, project: 'proj', provenance: 'backfill' },
      { llm: false },
    );
    expect(record.title).toBe('ask');
    expect(record.enrichment).toBe('heuristic');
    expect(record.enrichment_error).toBeUndefined();
    expect(existsSync(path.join(metricsRoot, 'adoption.jsonl'))).toBe(false);
  });
});
