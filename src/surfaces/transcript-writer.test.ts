import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RECALL_RECORD_TYPE, type RecallRecord } from '../record/schema.js';
import { synthesizeHeuristic } from '../record/synthesizer.js';
import { parseTranscriptText } from '../transcript/parse.js';
import {
  computeSourceHash,
  didRevertTranscript,
  writeRecordToTranscript,
} from './transcript-writer.js';

const SESSION = 's-w';
const FIRST_PROMPT = 'do the thing';
const MINUTES = 10;
const SECONDS_PER_MINUTE = 60;
const TEN_MINUTES_MS = MINUTES * SECONDS_PER_MINUTE * 1000;
const native = `${[
  JSON.stringify({
    type: 'user',
    sessionId: SESSION,
    cwd: '/x',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: FIRST_PROMPT }] },
  }),
  JSON.stringify({ type: 'ai-title', sessionId: SESSION, aiTitle: 'native title' }),
].join('\n')}\n`;

const makeRecord = (): RecallRecord => {
  const parsed = parseTranscriptText(native, `/x/${SESSION}.jsonl`);
  return {
    ...synthesizeHeuristic({ parsed, project: 'proj', provenance: 'forward' }),
    title: 'cc synthesized title',
  };
};

/** A line representing conversation added after cc-recall first indexed the session. */
const laterTurn = (text: string): string =>
  JSON.stringify({
    type: 'user',
    sessionId: SESSION,
    cwd: '/x',
    timestamp: '2026-02-01T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });

/**
 * Fresh temp dir + a transcript containing only native (non-cc-recall) lines.
 *
 * Registers its own `beforeEach`/`afterEach` at call time, so call it exactly once per
 * `describe` — a second call in the same block would register a second pair against the same
 * closure and the later setup would win, silently leaking the first temp dir.
 */
const useTranscript = (): { get: () => { dir: string; file: string } } => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cc-recall-'));
    file = path.join(dir, `${SESSION}.jsonl`);
    writeFileSync(file, native);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return { get: () => ({ dir, file }) };
};

describe('transcript-writer', () => {
  const ctx = useTranscript();
  let dir: string;
  let file: string;
  beforeEach(() => {
    ({ dir, file } = ctx.get());
  });

  it('injects a recall-record and overrides the title, non-destructively', () => {
    const result = writeRecordToTranscript(file, makeRecord(), { baseDir: dir });
    expect(result.written).toBe(true);
    const reparsed = parseTranscriptText(readFileSync(file, 'utf8'), file);
    expect(reparsed.parseErrors).toBe(0);
    expect(reparsed.aiTitle).toBe('cc synthesized title');
    expect(reparsed.records.some((r) => r.type === RECALL_RECORD_TYPE)).toBe(true);
    // original user line is preserved
    expect(reparsed.firstUserPrompt?.text).toBe(FIRST_PROMPT);
  });

  it('is idempotent: a second write on an unchanged source is a no-op', () => {
    writeRecordToTranscript(file, makeRecord(), { baseDir: dir });
    const second = writeRecordToTranscript(file, makeRecord(), { baseDir: dir });
    expect(second.skipped).toBe(true);
    expect(second.written).toBe(false);
  });

  it('reverts to the pre-edit backup', () => {
    writeRecordToTranscript(file, makeRecord(), { baseDir: dir });
    expect(didRevertTranscript(file, SESSION, { baseDir: dir })).toBe(true);
    const reparsed = parseTranscriptText(readFileSync(file, 'utf8'), file);
    expect(reparsed.records.some((r) => r.type === RECALL_RECORD_TYPE)).toBe(false);
    expect(reparsed.aiTitle).toBe('native title');
  });

  it('returns false when reverting with no backup', () => {
    expect(didRevertTranscript(file, 'never-written', { baseDir: dir })).toBe(false);
  });

  // The pre-fix implementation restored a snapshot taken the FIRST time cc-recall touched the
  // file, so reverting a session that had since been resumed silently discarded everything
  // added in between. These pin the two paths where that could happen.
});

/** Abandoned pre-write snapshots accumulate beside the transcript they protect. */
const snapshotsIn = (dir: string): string[] =>
  readdirSync(dir).filter((f) => f.endsWith('.prewrite'));

describe('transcript-writer — snapshot hygiene', () => {
  const ctx = useTranscript();

  it('a successful write leaves no .prewrite snapshot behind', () => {
    const { dir, file } = ctx.get();
    writeRecordToTranscript(file, makeRecord(), { baseDir: dir });
    expect(snapshotsIn(dir)).toEqual([]);
  });

  // The more dangerous path: a snapshot taken and then abandoned accumulates beside the
  // transcript it protects, which is exactly what the `finally` exists to prevent.
  it('a failed write leaves no .prewrite snapshot behind, and rolls the content back', () => {
    const { dir, file } = ctx.get();
    const before = readFileSync(file, 'utf8');

    expect(() =>
      writeRecordToTranscript(file, makeRecord(), { baseDir: dir, verifyIntegrity: () => false }),
    ).toThrow(/integrity check failed/);

    // Cleanup and rollback are separate guarantees; asserting only the former would pass even
    // if the restore silently wrote the wrong content.
    expect(snapshotsIn(dir)).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('transcript-writer — content preservation', () => {
  const ctx = useTranscript();
  let dir: string;
  let file: string;
  beforeEach(() => {
    ({ dir, file } = ctx.get());
  });
  it('revert preserves turns appended since indexing', () => {
    writeRecordToTranscript(file, makeRecord(), { baseDir: dir });

    // Session is resumed and grows well past what the original backup captured.
    const grown = `${readFileSync(file, 'utf8').trimEnd()}\n${laterTurn('much later work')}\n`;
    writeFileSync(file, grown);

    expect(didRevertTranscript(file, SESSION, { baseDir: dir })).toBe(true);

    const after = readFileSync(file, 'utf8');
    expect(after).toContain('much later work');
    expect(after).toContain(FIRST_PROMPT);
    const reparsed = parseTranscriptText(after, file);
    expect(reparsed.records.some((r) => r.type === RECALL_RECORD_TYPE)).toBe(false);
  });

  it('refuses to strip a record belonging to a different session', () => {
    writeRecordToTranscript(file, makeRecord(), { baseDir: dir });
    expect(didRevertTranscript(file, 'some-other-session', { baseDir: dir })).toBe(false);
    const after = parseTranscriptText(readFileSync(file, 'utf8'), file);
    expect(after.records.some((r) => r.type === RECALL_RECORD_TYPE)).toBe(true);
  });

  // The window that matters spans the CALLER's read, synthesis, and this write. The writer does
  // read the file — once, to compute the source hash — but deliberately does not re-read to
  // compare, because two reads microseconds apart would catch nothing here. A record synthesized
  // from older content must not be stamped with the current hash, or the next run's idempotency
  // check matches and skips forever, leaving the in-transcript record stale while the sidecar
  // moves on. The revert path *does* re-read and is right to — its window is synchronous and
  // bounded, while this one contains an LLM call. Same module, opposite conclusion, because the
  // two windows are different shapes.
  it('refuses to write a record synthesized from content the file has grown past', () => {
    const before = writeRecordToTranscript(file, makeRecord(), { baseDir: dir });
    const staleHash = before.sourceHash;

    const grown = `${readFileSync(file, 'utf8').trimEnd()}\n${laterTurn('appended during synthesis')}\n`;
    writeFileSync(file, grown);

    const result = writeRecordToTranscript(file, makeRecord(), {
      baseDir: dir,
      expectedSourceHash: staleHash,
    });
    expect(result.written).toBe(false);
    expect(result.skipped).toBe(true);
    // Distinguishable from an ordinary idempotent no-op, so the caller can act on it.
    expect(result.skipReason).toBe('stale-source');
    expect(readFileSync(file, 'utf8')).toContain('appended during synthesis');
  });

  it('writes when the expected hash still matches the grown file', () => {
    writeRecordToTranscript(file, makeRecord(), { baseDir: dir });

    // Source genuinely changed, so idempotency won't short-circuit — and this time the
    // caller synthesized from the grown content, so its hash matches and the write proceeds.
    const grown = `${readFileSync(file, 'utf8').trimEnd()}\n${laterTurn('newer turn')}\n`;
    writeFileSync(file, grown);
    const fresh = computeSourceHash(grown);

    const result = writeRecordToTranscript(
      file,
      { ...makeRecord(), title: 'second pass' },
      { baseDir: dir, expectedSourceHash: fresh },
    );
    expect(result.written).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('newer turn');
  });

  // The single most important property in this module, and the exact C2 defect: when a write
  // fails its integrity check, it must restore what was on disk immediately before THIS write —
  // not the first-ever backup, which for a resumed session is weeks behind.
  it('integrity failure restores the pre-write state, not the stale original backup', () => {
    // First write establishes the original backup at the session's initial size.
    writeRecordToTranscript(file, makeRecord(), { baseDir: dir });

    // Session is resumed and grows well past what that backup captured.
    const grown = `${readFileSync(file, 'utf8').trimEnd()}\n${laterTurn('work done weeks later')}\n`;
    writeFileSync(file, grown);

    expect(() =>
      writeRecordToTranscript(file, makeRecord(), {
        baseDir: dir,
        verifyIntegrity: () => false,
      }),
    ).toThrow(/integrity check failed/);

    const after = readFileSync(file, 'utf8');
    expect(after).toBe(grown); // exactly the pre-write state
    expect(after).toContain('work done weeks later'); // and NOT the original backup
  });

  it('opting into the original backup is still available and explicit', () => {
    writeRecordToTranscript(file, makeRecord(), { baseDir: dir });
    const wasReverted = didRevertTranscript(file, SESSION, {
      baseDir: dir,
      fromOriginalBackup: true,
    });
    expect(wasReverted).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(native);
  });
});

// `renameSync` replaces the target path's inode. A process holding an append fd to the OLD
// inode at that moment keeps writing into it invisibly forever after — no hash check catches
// this, because it only detects content that already changed, not a write about to happen.
// cc-recall-kg8.
describe('transcript-writer — live-session guard', () => {
  const ctx = useTranscript();
  let dir: string;
  let file: string;
  beforeEach(() => {
    ({ dir, file } = ctx.get());
  });
  afterEach(() => {
    // `process.env.X = undefined` coerces to the string "undefined" (Node's env setter stringifies
    // everything), which would leave the var "set" for the next test -- delete is the only correct
    // way to actually unset it, despite the noDelete performance advice for hot-path object shapes.
    // biome-ignore lint/performance/noDelete: correct semantics here, not a hot path
    delete process.env.CLAUDE_SESSION_ID;
  });

  it('skips a backfill write on a transcript with a fresh mtime', () => {
    // useTranscript's beforeEach just wrote the file, so its mtime is already "now".
    const result = writeRecordToTranscript(
      file,
      { ...makeRecord(), provenance: 'backfill' },
      { baseDir: dir },
    );
    expect(result.written).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('active-session');
    expect(readFileSync(file, 'utf8')).toBe(native); // untouched
  });

  it('does not apply the liveness guard to a forward (SessionEnd) write', () => {
    // A forward write's transcript ALWAYS has a fresh mtime -- SessionEnd fires right after the
    // session's last append. Applying the same guard here would skip every ordinary write.
    const result = writeRecordToTranscript(
      file,
      { ...makeRecord(), provenance: 'forward' },
      { baseDir: dir },
    );
    expect(result.written).toBe(true);
  });

  it('skips a backfill write when the transcript belongs to the currently running session', () => {
    // Backdate mtime well past the grace window, so only the session-id signal can be
    // responsible for the skip -- isolates that check from the mtime one.
    const oldTime = new Date(Date.now() - TEN_MINUTES_MS);
    utimesSync(file, oldTime, oldTime);
    process.env.CLAUDE_SESSION_ID = SESSION;

    const result = writeRecordToTranscript(
      file,
      { ...makeRecord(), provenance: 'backfill' },
      { baseDir: dir },
    );
    expect(result.skipReason).toBe('active-session');
  });

  it('writes a backfill record once the transcript has gone idle', () => {
    const oldTime = new Date(Date.now() - TEN_MINUTES_MS);
    utimesSync(file, oldTime, oldTime);

    const result = writeRecordToTranscript(
      file,
      { ...makeRecord(), provenance: 'backfill' },
      { baseDir: dir },
    );
    expect(result.written).toBe(true);
  });
});
