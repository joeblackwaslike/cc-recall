import { describe, expect, it } from 'vitest';
import { parseTranscriptText } from '../transcript/parse.js';
import { recallRecordSchema } from './schema.js';
import { synthesize, synthesizeHeuristic } from './synthesizer.js';

const CWD = '/Users/joe/github/joeblackwaslike/pieces-dev';
const SUBSTANTIAL_LEN = 250; // exceeds the synthesizer's HANDOFF_MIN_LEN (200)
const LONG = 'x'.repeat(SUBSTANTIAL_LEN);

const sortedStrings = (values: readonly string[]): string[] =>
  [...values].sort((a, b) => a.localeCompare(b));

const lines = [
  {
    type: 'user',
    uuid: 'u1',
    sessionId: 's-1',
    cwd: CWD,
    gitBranch: 'main',
    timestamp: '2026-06-10T01:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: '# Handoff: prior work' }] },
  },
  {
    type: 'assistant',
    uuid: 'a1',
    sessionId: 's-1',
    cwd: CWD,
    timestamp: '2026-06-10T01:05:00.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/a.ts' } },
        { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/b.ts' } },
        { type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/a.ts' } },
      ],
    },
  },
  {
    type: 'user',
    uuid: 'u2',
    sessionId: 's-1',
    cwd: CWD,
    timestamp: '2026-06-10T02:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'give me a handoff prompt please' }] },
  },
  {
    type: 'assistant',
    uuid: 'a2',
    sessionId: 's-1',
    cwd: CWD,
    timestamp: '2026-06-10T02:05:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: `Handoff: ${LONG}` }] },
  },
  { type: 'last-prompt', sessionId: 's-1', lastPrompt: 'give me a handoff prompt please' },
];

const parsed = parseTranscriptText(
  lines.map((l) => JSON.stringify(l)).join('\n'),
  '/repo/s-1.jsonl',
);

describe('synthesizeHeuristic', () => {
  it('produces a schema-valid record without an LLM', () => {
    const record = synthesizeHeuristic({ parsed, project: 'proj', provenance: 'backfill' });
    expect(recallRecordSchema.safeParse(record).success).toBe(true);
    expect(record.session_id).toBe('s-1');
    expect(record.git_branch).toBe('main');
    expect(record.started_at).toBe('2026-06-10T01:00:00.000Z');
    expect(record.provenance).toBe('backfill');
  });

  it('detects edited files and tool counts from assistant tool_use', () => {
    const record = synthesizeHeuristic({ parsed, project: 'proj', provenance: 'backfill' });
    expect(sortedStrings(record.artifacts.files_touched)).toEqual(['/a.ts', '/b.ts']);
    const edit = record.artifacts.top_tools.find((t) => t.name === 'Edit');
    expect(edit?.count).toBe(2);
  });

  it('detects handoff_in from the first message and handoff_out from the last assistant turn', () => {
    const record = synthesizeHeuristic({ parsed, project: 'proj', provenance: 'backfill' });
    expect(record.handoff_in?.text).toContain('# Handoff');
    expect(record.handoff_in?.from_session).toBeNull();
    expect(record.handoff_out?.text).toContain('Handoff:');
    expect(record.handoff_out?.to_session).toBeNull();
  });
});

describe('synthesize', () => {
  it('merges enrichment from an injected LLM runner', async () => {
    const record = await synthesize(
      { parsed, project: 'proj', provenance: 'forward', generatedAt: '2026-06-10T03:00:00.000Z' },
      {
        llm: () =>
          Promise.resolve(
            `Here you go: ${JSON.stringify({
              title: 'Refactored the babysitter module',
              summary: 'Did the thing.',
              asks_implemented: ['split babysitter'],
              completions: ['shipped it'],
              facets: { completed: ['refactor'], questioned: ['naming'], asked_about: ['LTM'] },
              distinctive_phrases: ['babysitter'],
            })}`,
          ),
      },
    );
    expect(record.title).toBe('Refactored the babysitter module');
    expect(record.facets.questioned).toEqual(['naming']);
    expect(record.artifacts.distinctive_phrases).toEqual(['babysitter']);
    // heuristic-derived fields survive enrichment
    expect(sortedStrings(record.artifacts.files_touched)).toEqual(['/a.ts', '/b.ts']);
  });

  it('falls back to the heuristic record when the LLM runner throws', async () => {
    const warnings: string[] = [];
    const record = await synthesize(
      { parsed, project: 'proj', provenance: 'forward' },
      { llm: () => Promise.reject(new Error('claude not found')), onWarn: (m) => warnings.push(m) },
    );
    expect(record.title).toBe(parsed.aiTitle ?? '# Handoff: prior work');
    expect(warnings[0]).toContain('claude not found');
  });

  it('skips the LLM entirely when llm is false', async () => {
    const record = await synthesize(
      { parsed, project: 'proj', provenance: 'forward' },
      { llm: false },
    );
    expect(recallRecordSchema.safeParse(record).success).toBe(true);
  });
});
