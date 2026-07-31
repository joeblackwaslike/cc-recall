// The revert path bails when the transcript changes between its two reads. That guard exists to
// stop a live session's appended turns from being rebuilt away from a stale view, and its whole
// failure mode is silence: if a refactor drops it, nothing throws and nothing looks wrong until
// a resumed session loses conversation. Reaching it needs the file to change *between* two
// synchronous reads, so `node:fs` is mocked here — in its own file, so the rest of the suite
// keeps running against the real thing.
import type * as NodeFs from 'node:fs';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECALL_RECORD_TYPE, type RecallRecord } from '../record/schema.js';
import { synthesizeHeuristic } from '../record/synthesizer.js';
import { parseTranscriptText } from '../transcript/parse.js';
import { didRevertTranscript, writeRecordToTranscript } from './transcript-writer.js';

// Arm this only AFTER per-test setup has finished: `beforeEach` calls writeRecordToTranscript,
// which reads the file itself, so a hook armed earlier would fire on the wrong read. It is
// one-shot (cleared as it fires) and reset in afterEach, so the ordering is safe as written.
//
// The symptom if that ordering is ever broken is the dangerous kind: the hook fires during
// setup, the transcript is never mutated between the revert's two reads, the guard never trips
// — and the test still passes, having exercised nothing. A vacuous pass, not a failure.
const fsHook = vi.hoisted(() => ({ afterNextRead: null as null | (() => void) }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  // `readFileSync` is overloaded on its options argument; the wrapper is a pass-through, so it
  // is declared against the widest signature and re-asserted to the original type.
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    const contents = actual.readFileSync(...args);
    const hook = fsHook.afterNextRead;
    fsHook.afterNextRead = null;
    hook?.();
    return contents;
  }) as typeof actual.readFileSync;
  return { ...actual, default: actual, readFileSync };
});

const SESSION = 's-race';
const FIRST_PROMPT = 'do the thing';
const APPENDED = 'appended while the revert was in flight';

const turn = (text: string, timestamp: string): string =>
  JSON.stringify({
    type: 'user',
    sessionId: SESSION,
    cwd: '/x',
    timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });

const native = `${[
  turn(FIRST_PROMPT, '2026-01-01T00:00:00.000Z'),
  JSON.stringify({ type: 'ai-title', sessionId: SESSION, aiTitle: 'native title' }),
].join('\n')}\n`;

const makeRecord = (): RecallRecord => {
  const parsed = parseTranscriptText(native, `/x/${SESSION}.jsonl`);
  return {
    ...synthesizeHeuristic({ parsed, project: 'proj', provenance: 'forward' }),
    title: 'cc synthesized title',
  };
};

describe('transcript-writer — revert concurrent-modification guard', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cc-recall-race-'));
    file = path.join(dir, `${SESSION}.jsonl`);
    writeFileSync(file, native);
    writeRecordToTranscript(file, makeRecord(), { baseDir: dir });
  });

  afterEach(() => {
    fsHook.afterNextRead = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves the transcript untouched and says so when it changes mid-revert', () => {
    const warnings: string[] = [];

    // Simulate Claude Code appending a turn in the window between the two reads.
    fsHook.afterNextRead = () => {
      writeFileSync(
        file,
        `${readFileSync(file, 'utf8').trimEnd()}\n${turn(APPENDED, '2026-02-01T00:00:00.000Z')}\n`,
      );
    };

    const isReverted = didRevertTranscript(file, SESSION, {
      baseDir: dir,
      onWarn: (message) => {
        warnings.push(message);
      },
    });

    expect(isReverted).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/transcript changed while reverting/);

    // The distinction that matters: `false` here must not mean "stripped anyway" or "half
    // stripped". Our record is still present and the concurrent turn survived.
    const after = readFileSync(file, 'utf8');
    expect(after).toContain(RECALL_RECORD_TYPE);
    expect(after).toContain(APPENDED);

    // Bailing out must not leave a snapshot behind. The guard returns before any snapshot is
    // taken, and this pins that ordering — moving `takePreWriteSnapshot` above the guard would
    // leak a .prewrite on every concurrent-modification bail, silently, until some later
    // successful write happened to reuse and discard the same path.
    expect(readdirSync(dir).filter((f) => f.endsWith('.prewrite'))).toEqual([]);
  });

  it('strips normally when nothing changes underneath it', () => {
    const warnings: string[] = [];

    const isReverted = didRevertTranscript(file, SESSION, {
      baseDir: dir,
      onWarn: (message) => {
        warnings.push(message);
      },
    });

    expect(isReverted).toBe(true);
    expect(warnings).toEqual([]);
    expect(readFileSync(file, 'utf8')).not.toContain(RECALL_RECORD_TYPE);
  });
});
