import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RECALL_RECORD_TYPE, type RecallRecord } from '../record/schema.js';
import { synthesizeHeuristic } from '../record/synthesizer.js';
import { parseTranscriptText } from '../transcript/parse.js';
import { revertTranscript, writeRecordToTranscript } from './transcript-writer.js';

const SESSION = 's-w';
const native = `${[
  JSON.stringify({
    type: 'user',
    sessionId: SESSION,
    cwd: '/x',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
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
    expect(reparsed.firstUserPrompt?.text).toBe('do the thing');
  });

  it('is idempotent: a second write on an unchanged source is a no-op', () => {
    writeRecordToTranscript(file, makeRecord(), { baseDir: dir });
    const second = writeRecordToTranscript(file, makeRecord(), { baseDir: dir });
    expect(second.skipped).toBe(true);
    expect(second.written).toBe(false);
  });

  it('reverts to the pre-edit backup', () => {
    writeRecordToTranscript(file, makeRecord(), { baseDir: dir });
    expect(revertTranscript(file, SESSION, { baseDir: dir })).toBe(true);
    const reparsed = parseTranscriptText(readFileSync(file, 'utf8'), file);
    expect(reparsed.records.some((r) => r.type === RECALL_RECORD_TYPE)).toBe(false);
    expect(reparsed.aiTitle).toBe('native title');
  });

  it('returns false when reverting with no backup', () => {
    expect(revertTranscript(file, 'never-written', { baseDir: dir })).toBe(false);
  });
});
