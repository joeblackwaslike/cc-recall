// cc-recall — transcript JSONL reader (spec §6).
//
// Reads a Claude Code `.jsonl` transcript into typed records and derives the session
// metadata the synthesizer needs: dominant cwd, Git branch, start/end timestamps
// (from in-transcript records, NEVER mtime — spec §7), the latest ai-title, and the
// genuine human prompts (separated from tool-results and SDK-injected prompts).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type BaseRecord,
  contentParts,
  isAiTitleRecord,
  isLastPromptRecord,
  isTextPart,
  isToolResultPart,
  isUserRecord,
  messageText,
} from '../types.js';

export interface UserPrompt {
  uuid: string | undefined;
  text: string;
  timestamp: string | undefined;
}

export interface ParsedTranscript {
  filePath: string | undefined;
  sessionId: string;
  records: BaseRecord[];
  /** Lines that failed to JSON.parse (transcripts are occasionally truncated). */
  parseErrors: number;
  lineCount: number;
  cwd: string;
  gitBranch: string | undefined;
  startedAt: string;
  endedAt: string;
  aiTitle: string | undefined;
  /** The most recent `last-prompt` record — the final human turn of the session. */
  lastPrompt: string | undefined;
  genuineUserPrompts: UserPrompt[];
  firstUserPrompt: UserPrompt | undefined;
}

const isRecord = (value: unknown): value is BaseRecord =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { type?: unknown }).type === 'string';

/** Pick the most frequently occurring non-empty value. */
const dominant = (values: readonly string[]): string | undefined => {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count <= bestCount) {
      continue;
    }

    best = value;
    bestCount = count;
  }
  return best;
};

/**
 * A genuine human prompt: a `user` record that carries real text the person typed,
 * as opposed to a tool-result echo or an SDK/skill-injected prompt.
 */
const genuinePrompt = (record: BaseRecord): UserPrompt | undefined => {
  if (!isUserRecord(record)) return undefined;
  if (record.isSidechain) return undefined;
  if (record.promptSource === 'sdk') return undefined;
  if (record.isMeta === true) return undefined;

  const parts = contentParts(record.message);
  if (parts.some((p) => isToolResultPart(p))) return undefined;
  if (parts.every((p) => !isTextPart(p))) return undefined;

  const text = messageText(record.message);
  if (!text || text.startsWith('<command-') || text.startsWith('Caveat:')) {
    return undefined;
  }
  return {
    uuid: typeof record.uuid === 'string' ? record.uuid : undefined,
    text,
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
  };
};

interface TranscriptScan {
  timestamps: string[];
  cwds: string[];
  branches: string[];
  genuineUserPrompts: UserPrompt[];
  aiTitle: string | undefined;
  lastPrompt: string | undefined;
  sessionId: string | undefined;
}

/** Decode newline-delimited JSON into records, counting unparseable lines. */
const parseLines = (text: string): { records: BaseRecord[]; parseErrors: number } => {
  const records: BaseRecord[] = [];
  let parseErrors = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (isRecord(value)) records.push(value);
      else parseErrors += 1;
    } catch {
      parseErrors += 1;
    }
  }
  return { records, parseErrors };
};

/** Fold a single record into the running scan accumulator. */
const applyRecord = (scan: TranscriptScan, record: BaseRecord): void => {
  if (typeof record.timestamp === 'string') scan.timestamps.push(record.timestamp);
  if (typeof record.cwd === 'string') scan.cwds.push(record.cwd);
  if (typeof record.gitBranch === 'string') scan.branches.push(record.gitBranch);
  if (!scan.sessionId && typeof record.sessionId === 'string') {
    scan.sessionId = record.sessionId;
  }
  if (isAiTitleRecord(record)) scan.aiTitle = record.aiTitle;
  if (isLastPromptRecord(record)) scan.lastPrompt = record.lastPrompt;
  const prompt = genuinePrompt(record);
  if (prompt) scan.genuineUserPrompts.push(prompt);
};

/** Single pass over records collecting the fields we derive metadata from. */
const scanRecords = (records: readonly BaseRecord[]): TranscriptScan => {
  const scan: TranscriptScan = {
    timestamps: [],
    cwds: [],
    branches: [],
    genuineUserPrompts: [],
    aiTitle: undefined,
    lastPrompt: undefined,
    sessionId: undefined,
  };
  for (const record of records) applyRecord(scan, record);
  return scan;
};

/** Parse raw transcript text (newline-delimited JSON) into a ParsedTranscript. */
export const parseTranscriptText = (text: string, filePath?: string): ParsedTranscript => {
  const { records, parseErrors } = parseLines(text);
  const scan = scanRecords(records);

  const timestamps = scan.timestamps.toSorted((a, b) => a.localeCompare(b));
  const fallbackId = filePath ? path.basename(filePath).replace(/\.jsonl$/, '') : 'unknown';

  return {
    filePath,
    sessionId: scan.sessionId ?? fallbackId,
    records,
    parseErrors,
    lineCount: records.length,
    cwd: dominant(scan.cwds) ?? '',
    gitBranch: dominant(scan.branches),
    startedAt: timestamps[0] ?? '',
    endedAt: timestamps.at(-1) ?? '',
    aiTitle: scan.aiTitle,
    lastPrompt: scan.lastPrompt,
    genuineUserPrompts: scan.genuineUserPrompts,
    firstUserPrompt: scan.genuineUserPrompts[0],
  };
};

/** Read and parse a transcript file from disk. */
export const parseTranscriptFile = async (filePath: string): Promise<ParsedTranscript> => {
  const text = await readFile(filePath, 'utf8');
  return parseTranscriptText(text, filePath);
};
