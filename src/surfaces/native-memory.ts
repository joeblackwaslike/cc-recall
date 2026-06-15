// cc-recall — native-memory front page (spec §8④). SECONDARY surface, best-effort.
//
// Maintains a small CURATED markdown page — pointers to the sidecar + the N most
// significant sessions — rather than bulk storage, so it can be imported into Claude's
// native memory (e.g. an `@`-import line in CLAUDE.md) without bloating auto-injected
// context. It is regenerated from the sidecar, which remains the source of truth.

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { RecallRecord } from '../record/schema.js';
import type { Sidecar } from './sidecar.js';

const DEFAULT_TOP_N = 25;

export const defaultFrontPagePath = (): string =>
  path.join(homedir(), '.claude', 'cc-recall', 'FRONTPAGE.md');

export interface FrontPageOptions {
  path?: string;
  topN?: number;
  /** Sidecar db path, surfaced in the page so a reader knows what to query. */
  dbPath?: string;
}

const formatSession = (record: RecallRecord): string => {
  const branch = record.git_branch ? ` (${record.git_branch})` : '';
  const day = record.ended_at.slice(0, 10);
  return `- **${record.title}** — \`${record.project}\`${branch}, ${record.line_count} lines, ${day} — \`${record.session_id}\``;
};

const renderFrontPage = (top: readonly RecallRecord[], dbPath: string | undefined): string => {
  const dbHint = dbPath ? ` (db: \`${dbPath}\`)` : '';
  const lines = [
    '# cc-recall — session front page',
    '',
    '> Most Claude Code sessions are discoverable here. To find one, search the sidecar',
    `> first: \`cc-recall search "<what you remember>"\`${dbHint},`,
    '> or use `/recall:search`. Fall back to claude-mem only if the sidecar misses.',
    '',
    `## Most significant sessions (${top.length})`,
    '',
    ...top.map((record) => formatSession(record)),
    '',
  ];
  return lines.join('\n');
};

export interface FrontPageResult {
  path: string;
  count: number;
}

/** Regenerate the native-memory front page from the sidecar. Best-effort. */
export const writeFrontPage = (
  sidecar: Sidecar,
  options: FrontPageOptions = {},
): FrontPageResult => {
  const target = options.path ?? defaultFrontPagePath();
  const top = sidecar.top(options.topN ?? DEFAULT_TOP_N);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, renderFrontPage(top, options.dbPath));
  return { path: target, count: top.length };
};
