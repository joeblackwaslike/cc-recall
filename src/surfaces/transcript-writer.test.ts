import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RECALL_RECORD_TYPE, type RecallRecord } from '../record/schema.js';
import { synthesizeHeuristic } from '../record/synthesizer.js';
import { parseTranscriptText } from '../transcript/parse.js';
import { didRevertTranscript, writeRecordToTranscript } from './transcript-writer.js';

const SESSION = 's-w';
const FIRST_PROMPT = 'do the thing';
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

describe('transcript-writer', () => {
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
  describe('does not lose content added after the first index', () => {
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

    it('skips the write when the transcript changed between read and write', () => {
      // First write establishes the record; then the file grows the way a live session does.
      writeRecordToTranscript(file, makeRecord(), { baseDir: dir });
      const grown = `${readFileSync(file, 'utf8').trimEnd()}\n${laterTurn('appended mid-run')}\n`;
      writeFileSync(file, grown);

      // A subsequent write must not rebuild the file from stale content.
      writeRecordToTranscript(file, makeRecord(), { baseDir: dir });
      expect(readFileSync(file, 'utf8')).toContain('appended mid-run');
    });
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
