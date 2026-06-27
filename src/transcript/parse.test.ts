import { describe, expect, it } from 'vitest';
import { parseTranscriptText } from './parse.js';

const CWD = '/Users/joe/github/joeblackwaslike/pieces-dev';
const HANDOFF_PROMPT = 'can I get a handoff prompt?';

// A synthetic transcript modeling the real shapes found in the S0 spike:
// a handoff-first human prompt, a tool_result echo (role=user), an SDK-injected
// prompt, an assistant turn, an ai-title appended twice (take the last), a
// last-prompt record, and a multi-day timestamp spread.
const lines = [
  {
    type: 'user',
    uuid: 'u1',
    sessionId: 's-123',
    cwd: CWD,
    gitBranch: 'main',
    timestamp: '2026-06-10T01:10:24.991Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text: '# Handoff: continue the babysitter work' }],
    },
  },
  {
    type: 'user',
    uuid: 'u2',
    sessionId: 's-123',
    cwd: CWD,
    timestamp: '2026-06-10T01:10:33.775Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
    },
  },
  {
    type: 'user',
    uuid: 'u3',
    sessionId: 's-123',
    promptSource: 'sdk',
    cwd: CWD,
    timestamp: '2026-06-10T01:10:40.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'Launching skill: foo' }] },
  },
  {
    type: 'assistant',
    uuid: 'a1',
    sessionId: 's-123',
    cwd: CWD,
    timestamp: '2026-06-11T12:00:00.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/x.ts' } },
      ],
    },
  },
  { type: 'ai-title', sessionId: 's-123', aiTitle: 'First drifted title' },
  { type: 'ai-title', sessionId: 's-123', aiTitle: 'Final title' },
  {
    type: 'user',
    uuid: 'u4',
    sessionId: 's-123',
    cwd: CWD,
    timestamp: '2026-06-12T16:21:27.248Z',
    message: { role: 'user', content: [{ type: 'text', text: HANDOFF_PROMPT }] },
  },
  {
    type: 'last-prompt',
    sessionId: 's-123',
    lastPrompt: HANDOFF_PROMPT,
    leafUuid: 'u4',
  },
];

const transcript = lines.map((l) => JSON.stringify(l)).join('\n');

describe('parseTranscriptText', () => {
  it('derives session metadata from in-transcript records', () => {
    const parsed = parseTranscriptText(transcript, '/repo/s-123.jsonl');
    expect(parsed.sessionId).toBe('s-123');
    expect(parsed.cwd).toBe(CWD);
    expect(parsed.gitBranch).toBe('main');
    expect(parsed.startedAt).toBe('2026-06-10T01:10:24.991Z');
    expect(parsed.endedAt).toBe('2026-06-12T16:21:27.248Z');
    expect(parsed.parseErrors).toBe(0);
  });

  it('takes the last ai-title and the last-prompt', () => {
    const parsed = parseTranscriptText(transcript);
    expect(parsed.aiTitle).toBe('Final title');
    expect(parsed.lastPrompt).toBe(HANDOFF_PROMPT);
  });

  it('extracts genuine human prompts, excluding tool-results and sdk prompts', () => {
    const parsed = parseTranscriptText(transcript);
    expect(parsed.genuineUserPrompts.map((p) => p.uuid)).toEqual(['u1', 'u4']);
    expect(parsed.firstUserPrompt?.text).toContain('# Handoff');
  });

  it('counts unparseable lines without throwing', () => {
    const parsed = parseTranscriptText(`${transcript}\nnot json\n{"type":"x"`);
    expect(parsed.parseErrors).toBe(2);
    expect(parsed.records).toHaveLength(lines.length);
  });

  it('falls back to the filename for session id when records lack one', () => {
    const parsed = parseTranscriptText('{"type":"system"}', '/repo/abc-def.jsonl');
    expect(parsed.sessionId).toBe('abc-def');
  });
});
