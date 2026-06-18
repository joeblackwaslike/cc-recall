// cc-recall — handoff_out ↔ successor first-message matching
// Jaccard token similarity + time-window filtering for lineage resolution.

import type { RecallRecord } from '../record/schema.js';

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'is',
  'it',
  'that',
  'this',
  'was',
  'are',
  'be',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'can',
  'could',
  'should',
  'may',
  'might',
  'not',
  'no',
  'so',
  'if',
  'up',
  'out',
  'just',
  'also',
  'then',
  'than',
  'very',
  'too',
  'here',
  'there',
  'when',
  'where',
  'how',
  'what',
  'which',
  'who',
  'whom',
  'we',
  'i',
  'you',
  'they',
  'me',
  'my',
  'your',
  'our',
  'its',
  'his',
  'her',
  'their',
]);

const MIN_TOKEN_LENGTH = 3;
const MATCH_THRESHOLD = 0.15;

const DAYS_IN_WINDOW = 7;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const TIME_WINDOW_MS =
  DAYS_IN_WINDOW * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

const tokenize = (text: string): Set<string> => {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return new Set(
    tokens.filter((token) => token.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(token)),
  );
};

/**
 * Jaccard similarity of significant tokens (0–1).
 * Tokenizes both texts to lowercase, filters out stopwords and tokens shorter
 * than 3 chars, computes set intersection / set union.
 */
export const scoreMatch = (textA: string, textB: string): number => {
  const setA = tokenize(textA);
  const setB = tokenize(textB);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

const withinWindow = (fromTime: string, toTime: string): boolean => {
  const fromDate = new Date(fromTime);
  const toDate = new Date(toTime);
  const from = fromDate.getTime();
  const to = toDate.getTime();
  return !Number.isNaN(from) && !Number.isNaN(to) && to >= from && to - from <= TIME_WINDOW_MS;
};

/**
 * Given a session with `handoff_out.text`, find the best-matching successor
 * among candidates. The candidate must be a different session, must start
 * within 7 days of source ending, and match `handoff_out.text` against
 * the candidate's `title`.
 *
 * Returns the session_id of the best match above threshold 0.15, or null.
 */
export const resolveHandoffOut = (
  source: RecallRecord,
  candidates: readonly RecallRecord[],
): string | null => {
  if (!source.handoff_out?.text) return null;
  let bestId: string | null = null;
  let bestScore = MATCH_THRESHOLD;
  for (const candidate of candidates) {
    if (candidate.session_id === source.session_id) continue;
    if (!withinWindow(source.ended_at, candidate.started_at)) continue;
    const score = scoreMatch(source.handoff_out.text, candidate.title);
    if (score > bestScore) {
      bestScore = score;
      bestId = candidate.session_id;
    }
  }
  return bestId;
};

/**
 * Given a session with `handoff_in.text`, find the best-matching predecessor
 * among candidates. The candidate must be a different session, must have ended
 * within 7 days before target started, and match `handoff_in.text` against
 * the candidate's `title`.
 *
 * Returns the session_id of the best match above threshold 0.15, or null.
 */
export const resolveHandoffIn = (
  target: RecallRecord,
  candidates: readonly RecallRecord[],
): string | null => {
  if (!target.handoff_in?.text) return null;
  let bestId: string | null = null;
  let bestScore = MATCH_THRESHOLD;
  for (const candidate of candidates) {
    if (candidate.session_id === target.session_id) continue;
    if (!withinWindow(candidate.ended_at, target.started_at)) continue;
    const score = scoreMatch(target.handoff_in.text, candidate.title);
    if (score > bestScore) {
      bestScore = score;
      bestId = candidate.session_id;
    }
  }
  return bestId;
};
