// cc-recall — shared domain types for raw Claude Code transcript JSONL.
//
// These model the on-disk transcript records as Claude Code writes them. They are
// intentionally permissive (each record carries an index signature) because the
// transcript format is owned upstream and evolves; we type only the fields we read
// and treat everything else as `unknown` rather than `any` (AGENTS.md).

export type Role = 'user' | 'assistant';

/** A single item inside a message's `content` array. */
export interface RawContentPart {
  type: string;
  [key: string]: unknown;
}

export interface TextPart extends RawContentPart {
  type: 'text';
  text: string;
}

export interface ThinkingPart extends RawContentPart {
  type: 'thinking';
  thinking: string;
}

export interface ToolUsePart extends RawContentPart {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultPart extends RawContentPart {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
}

export const isTextPart = (p: RawContentPart): p is TextPart =>
  p.type === 'text' && typeof (p as TextPart).text === 'string';

export const isThinkingPart = (p: RawContentPart): p is ThinkingPart =>
  p.type === 'thinking' && typeof (p as ThinkingPart).thinking === 'string';

export const isToolUsePart = (p: RawContentPart): p is ToolUsePart =>
  p.type === 'tool_use' && typeof (p as ToolUsePart).name === 'string';

export const isToolResultPart = (p: RawContentPart): p is ToolResultPart =>
  p.type === 'tool_result';

/** A message body. `content` is usually an array of parts but can be a bare string. */
export interface TranscriptMessage {
  role: Role;
  content: string | RawContentPart[];
  [key: string]: unknown;
}

/** Fields common to most transcript records. */
export interface BaseRecord {
  type: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isSidechain?: boolean;
  [key: string]: unknown;
}

export interface UserRecord extends BaseRecord {
  type: 'user';
  message: TranscriptMessage;
  promptSource?: string;
  userType?: string;
  slug?: string;
}

export interface AssistantRecord extends BaseRecord {
  type: 'assistant';
  message: TranscriptMessage;
}

export interface AiTitleRecord extends BaseRecord {
  type: 'ai-title';
  aiTitle: string;
}

export interface LastPromptRecord extends BaseRecord {
  type: 'last-prompt';
  lastPrompt: string;
  leafUuid?: string;
}

export interface SystemRecord extends BaseRecord {
  type: 'system';
  subtype?: string;
  content?: unknown;
}

export type TranscriptRecord =
  | UserRecord
  | AssistantRecord
  | AiTitleRecord
  | LastPromptRecord
  | SystemRecord
  | BaseRecord;

export const isUserRecord = (r: BaseRecord): r is UserRecord => r.type === 'user';
export const isAssistantRecord = (r: BaseRecord): r is AssistantRecord => r.type === 'assistant';
export const isAiTitleRecord = (r: BaseRecord): r is AiTitleRecord =>
  r.type === 'ai-title' && typeof (r as AiTitleRecord).aiTitle === 'string';
export const isLastPromptRecord = (r: BaseRecord): r is LastPromptRecord =>
  r.type === 'last-prompt' && typeof (r as LastPromptRecord).lastPrompt === 'string';

/** Normalize a message's content to an array of parts. */
export const contentParts = (message: TranscriptMessage): RawContentPart[] => {
  const { content } = message;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content;
};

/** Concatenated plain text of all `text` parts in a message. */
export const messageText = (message: TranscriptMessage): string =>
  contentParts(message)
    .filter((p): p is TextPart => isTextPart(p))
    .map((p) => p.text)
    .join('\n')
    .trim();
