// cc-recall — transcript → RecallRecord synthesizer (spec §7, §9).
//
// Shared by forward capture (SessionEnd) and backfill. Two layers:
//   1. a deterministic HEURISTIC baseline extracted purely from the transcript, and
//   2. an LLM ENRICHMENT pass via `claude -p` (headless) that produces the title,
//      summary, and the three retrieval facets.
// The LLM runner is injectable and the whole pass degrades gracefully: any failure
// (CLI absent, timeout, unparseable output) falls back to the heuristic record, so
// retrieval never depends on the LLM being available (AGENTS.md).

import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ParsedTranscript } from '../transcript/parse.js';
import {
  type AssistantRecord,
  type BaseRecord,
  type ToolUsePart,
  contentParts,
  isAssistantRecord,
  isToolUsePart,
  messageText,
} from '../types.js';
import {
  type Provenance,
  RECALL_RECORD_TYPE,
  type RecallRecord,
  SCHEMA_VERSION,
  SYNTHESIZER_VERSION,
  type ToolCount,
} from './schema.js';

const TOP_TOOLS_LIMIT = 10;
const TITLE_MAX = 80;
const SUMMARY_MAX = 600;
const HANDOFF_MIN_LEN = 200;
const LLM_TIMEOUT_MS = 60_000;
const MAX_DIGEST_PROMPTS = 12;
const PROMPT_SNIPPET = 500;
const MAX_DIGEST_COMPLETIONS = 4;

/** Tools whose invocation means a file was created or modified. */
const EDIT_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'replace_symbol_body',
  'insert_after_symbol',
  'insert_before_symbol',
  'create_text_file',
  'replace_content',
]);

const FILE_PATH_KEYS = ['file_path', 'filePath', 'notebook_path', 'path', 'relative_path'];

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const firstLine = (text: string): string => text.split('\n', 1)[0] ?? '';

const collectToolUses = (records: readonly BaseRecord[]): ToolUsePart[] =>
  records
    .filter((record): record is AssistantRecord => isAssistantRecord(record))
    .flatMap((record) =>
      contentParts(record.message).filter((part): part is ToolUsePart => isToolUsePart(part)),
    );

const fileFromInput = (input: unknown): string | undefined => {
  if (typeof input !== 'object' || input === null) return undefined;
  const object = input as Record<string, unknown>;
  for (const key of FILE_PATH_KEYS) {
    const value = object[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
};

const deriveFilesTouched = (toolUses: readonly ToolUsePart[]): string[] => {
  const files = new Set<string>();
  for (const toolUse of toolUses) {
    if (!EDIT_TOOLS.has(toolUse.name)) continue;
    const file = fileFromInput(toolUse.input);
    if (file) files.add(file);
  }
  return [...files];
};

const deriveTopTools = (toolUses: readonly ToolUsePart[]): ToolCount[] => {
  const counts = new Map<string, number>();
  for (const toolUse of toolUses) counts.set(toolUse.name, (counts.get(toolUse.name) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, TOP_TOOLS_LIMIT);
};

const HANDOFF_RE = /\bhand-?off\b/i;

const detectHandoffIn = (parsed: ParsedTranscript): RecallRecord['handoff_in'] => {
  const first = parsed.firstUserPrompt;
  if (!first || !HANDOFF_RE.test(firstLine(first.text))) return null;
  return { from_session: null, text: first.text };
};

const lastSubstantialAssistantText = (records: readonly BaseRecord[]): string | undefined => {
  for (const record of [...records].reverse()) {
    if (!isAssistantRecord(record)) continue;
    const text = messageText(record.message);
    if (text.length > HANDOFF_MIN_LEN) return text;
  }
  return undefined;
};

const detectHandoffOut = (parsed: ParsedTranscript): RecallRecord['handoff_out'] => {
  const { lastPrompt } = parsed;
  if (!lastPrompt || !HANDOFF_RE.test(lastPrompt)) return null;
  return { to_session: null, text: lastSubstantialAssistantText(parsed.records) ?? lastPrompt };
};

const heuristicTitle = (parsed: ParsedTranscript): string => {
  if (parsed.aiTitle) return parsed.aiTitle;
  const first = parsed.firstUserPrompt?.text;
  return first ? truncate(firstLine(first), TITLE_MAX) : 'Untitled session';
};

const heuristicSummary = (parsed: ParsedTranscript): string => {
  const first = parsed.firstUserPrompt?.text;
  return first ? truncate(first.replaceAll(/\s+/g, ' ').trim(), SUMMARY_MAX) : '';
};

export interface SynthesisInput {
  parsed: ParsedTranscript;
  /** encoded-cwd project dir name */
  project: string;
  provenance: Provenance;
  /** ISO timestamp; defaults to now. */
  generatedAt?: string;
}

/** Build the deterministic, LLM-free baseline record. Always succeeds. */
export const synthesizeHeuristic = (input: SynthesisInput): RecallRecord => {
  const { parsed, project, provenance } = input;
  const toolUses = collectToolUses(parsed.records);
  const record: RecallRecord = {
    type: RECALL_RECORD_TYPE,
    schema_version: SCHEMA_VERSION,
    session_id: parsed.sessionId,
    project,
    cwd: parsed.cwd,
    started_at: parsed.startedAt,
    ended_at: parsed.endedAt,
    line_count: parsed.lineCount,
    title: heuristicTitle(parsed),
    summary: heuristicSummary(parsed),
    asks_implemented: [],
    completions: [],
    handoff_in: detectHandoffIn(parsed),
    handoff_out: detectHandoffOut(parsed),
    artifacts: {
      files_touched: deriveFilesTouched(toolUses),
      top_tools: deriveTopTools(toolUses),
      distinctive_phrases: [],
    },
    facets: { completed: [], questioned: [], asked_about: [] },
    provenance,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    synthesizer_version: SYNTHESIZER_VERSION,
  };
  // exactOptionalPropertyTypes: only set git_branch when present.
  if (parsed.gitBranch) record.git_branch = parsed.gitBranch;
  return record;
};

const llmEnrichmentSchema = z.object({
  title: z.string().min(1),
  summary: z.string(),
  asks_implemented: z.array(z.string()),
  completions: z.array(z.string()),
  facets: z.object({
    completed: z.array(z.string()),
    questioned: z.array(z.string()),
    asked_about: z.array(z.string()),
  }),
  distinctive_phrases: z.array(z.string()),
});

type LlmEnrichment = z.infer<typeof llmEnrichmentSchema>;

const buildDigest = (parsed: ParsedTranscript): string => {
  const prompts = parsed.genuineUserPrompts
    .slice(0, MAX_DIGEST_PROMPTS)
    .map(
      (prompt, index) =>
        `[ask ${index + 1}] ${truncate(prompt.text.replaceAll(/\s+/g, ' ').trim(), PROMPT_SNIPPET)}`,
    );
  const completions = [...parsed.records]
    .reverse()
    .filter((record): record is AssistantRecord => isAssistantRecord(record))
    .map((record) => messageText(record.message))
    .filter((text) => text.length > HANDOFF_MIN_LEN)
    .slice(0, MAX_DIGEST_COMPLETIONS)
    .map((text) => `[summary] ${truncate(text.replaceAll(/\s+/g, ' ').trim(), PROMPT_SNIPPET)}`);
  return [
    `cwd: ${parsed.cwd}`,
    `existing title: ${parsed.aiTitle ?? '(none)'}`,
    '',
    'User asks:',
    ...prompts,
    '',
    'Assistant wrap-ups (most recent first):',
    ...completions,
  ].join('\n');
};

const buildLlmPrompt = (parsed: ParsedTranscript): string =>
  [
    'You are indexing a Claude Code session transcript so it can be found later by what',
    'was DONE, ASKED, and QUESTIONED. Read the digest and reply with ONLY a JSON object',
    '(no prose, no code fences) of this exact shape:',
    '{"title":"<=80 chars, what was actually done (not how it started)",',
    '"summary":"2-4 sentences","asks_implemented":["user requests that became real changes"],',
    '"completions":["end-of-work results stated"],',
    '"facets":{"completed":[],"questioned":[],"asked_about":[]},',
    '"distinctive_phrases":["rare/specific terms useful for search"]}',
    '',
    'Digest:',
    buildDigest(parsed),
  ].join('\n');

const extractJson = (raw: string): unknown => {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in LLM output');
  return JSON.parse(raw.slice(start, end + 1));
};

/** Invoke an LLM with a prompt and return its raw text output. */
export type LlmRunner = (prompt: string) => Promise<string>;

/** Default runner: pipe the prompt to `claude -p` over stdin. */
export const runClaudeHeadless: LlmRunner = (prompt) =>
  new Promise<string>((resolve, reject) => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- intentionally invoke the user's installed `claude` CLI via PATH
    const child = spawn('claude', ['-p'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('claude -p timed out'));
    }, LLM_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `claude -p exited ${code ?? 'null'}`));
    });
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- EPIPE swallowed; close event handles the failure
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });

const applyEnrichment = (base: RecallRecord, enrichment: LlmEnrichment): RecallRecord => ({
  ...base,
  title: truncate(enrichment.title, TITLE_MAX),
  summary: truncate(enrichment.summary, SUMMARY_MAX),
  asks_implemented: enrichment.asks_implemented,
  completions: enrichment.completions,
  facets: enrichment.facets,
  artifacts: { ...base.artifacts, distinctive_phrases: enrichment.distinctive_phrases },
});

export interface SynthesizeOptions {
  /** Injected LLM runner; pass `false` to force heuristic-only. Defaults to claude -p. */
  llm?: LlmRunner | false;
  /** Called with a message when the LLM pass fails and the heuristic is used instead. */
  onWarn?: (message: string) => void;
}

/** Synthesize a record: heuristic baseline enriched by the LLM, with graceful fallback. */
export const synthesize = async (
  input: SynthesisInput,
  options: SynthesizeOptions = {},
): Promise<RecallRecord> => {
  const base = synthesizeHeuristic(input);
  const runner = options.llm === false ? undefined : (options.llm ?? runClaudeHeadless);
  if (!runner) return base;
  try {
    const raw = await runner(buildLlmPrompt(input.parsed));
    const enrichment = llmEnrichmentSchema.parse(extractJson(raw));
    return applyEnrichment(base, enrichment);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onWarn?.(`LLM synthesis failed, using heuristic: ${message}`);
    return base;
  }
};
