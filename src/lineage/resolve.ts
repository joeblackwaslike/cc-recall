// cc-recall — batch lineage resolution across the sidecar.
// Queries all sessions with unresolved handoffs, runs the Jaccard matcher
// against candidates, and persists resolved links back to the sidecar.

import type { RecallRecord } from '../record/schema.js';
import type { Sidecar } from '../surfaces/sidecar.js';
import { resolveHandoffIn, resolveHandoffOut } from './match.js';

export interface ResolveResult {
  resolved: number;
  unresolved: number;
}

interface RecordOutcome {
  changed: boolean;
  resolved: number;
  unresolved: number;
}

/** Try to resolve an unlinked handoff_out; mutates the record in place. */
const tryResolveOut = (
  record: RecallRecord,
  candidates: readonly RecallRecord[],
): RecordOutcome => {
  if (!record.handoff_out || record.handoff_out.to_session) {
    return { changed: false, resolved: 0, unresolved: 0 };
  }
  const match = resolveHandoffOut(record, candidates);
  if (!match) {
    return { changed: false, resolved: 0, unresolved: 1 };
  }
  record.handoff_out = { ...record.handoff_out, to_session: match };
  return { changed: true, resolved: 1, unresolved: 0 };
};

/** Try to resolve an unlinked handoff_in; mutates the record in place. */
const tryResolveIn = (record: RecallRecord, candidates: readonly RecallRecord[]): RecordOutcome => {
  if (!record.handoff_in || record.handoff_in.from_session) {
    return { changed: false, resolved: 0, unresolved: 0 };
  }
  const match = resolveHandoffIn(record, candidates);
  if (!match) {
    return { changed: false, resolved: 0, unresolved: 1 };
  }
  record.handoff_in = { ...record.handoff_in, from_session: match };
  return { changed: true, resolved: 1, unresolved: 0 };
};

/**
 * Scan every record in the sidecar for unresolved handoff_out / handoff_in
 * links, attempt to match them against candidates, and persist any newly
 * resolved links. Returns counts of resolved and still-unresolved handoffs.
 */
export const resolveAllHandoffs = (sidecar: Sidecar): ResolveResult => {
  const all = sidecar.listAll();
  let resolved = 0;
  let unresolved = 0;

  for (const record of all) {
    const outResult = tryResolveOut(record, all);
    const inResult = tryResolveIn(record, all);

    resolved += outResult.resolved + inResult.resolved;
    unresolved += outResult.unresolved + inResult.unresolved;

    if (outResult.changed || inResult.changed) {
      sidecar.upsert(record, sidecar.getSourceHash(record.session_id));
    }
  }

  return { resolved, unresolved };
};
