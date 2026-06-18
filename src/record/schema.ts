// cc-recall — the Discoverability Record (spec §7).
//
// One canonical schema, identical whether forward-captured, backfilled, or hand-edited.
// Zod is the single source of truth; the `RecallRecord` type is inferred from it so the
// runtime validator and the static type never drift (AGENTS.md: validate at boundaries).

import { z } from 'zod';

/** Bump when the record shape changes in a backward-incompatible way. */
export const SCHEMA_VERSION = 1;

/** Bump when synthesis logic changes enough to warrant re-backfilling. */
export const SYNTHESIZER_VERSION = '0.1.0';

/** Record type tag written into the transcript JSONL. */
export const RECALL_RECORD_TYPE = 'recall-record';

/** handoff_in carries `from_session`; handoff_out carries `to_session`. */
const handoffInSchema = z.object({
  from_session: z.string().nullable(),
  text: z.string(),
});

const handoffOutSchema = z.object({
  to_session: z.string().nullable(),
  text: z.string(),
});

export const toolCountSchema = z.object({
  name: z.string(),
  count: z.number().int().nonnegative(),
});

const stringArraySchema = z.array(z.string());
const toolCountArraySchema = z.array(toolCountSchema);

export const recallRecordSchema = z.object({
  type: z.literal(RECALL_RECORD_TYPE),
  schema_version: z.literal(SCHEMA_VERSION),
  session_id: z.string(),
  project: z.string(), // encoded-cwd dir name
  cwd: z.string(), // dominant cwd in the session
  git_branch: z.string().optional(),
  started_at: z.string(), // from in-transcript timestamps, NOT mtime
  ended_at: z.string(),
  line_count: z.number().int().nonnegative(),
  title: z.string(), // one line — also written to the ai-title record
  summary: z.string(), // 2–4 sentences
  asks_implemented: stringArraySchema, // user requests that became real changes
  completions: stringArraySchema, // end-of-work summaries the assistant printed
  handoff_in: handoffInSchema.nullable(),
  handoff_out: handoffOutSchema.nullable(),
  artifacts: z.object({
    files_touched: stringArraySchema,
    top_tools: toolCountArraySchema,
    distinctive_phrases: stringArraySchema,
  }),
  facets: z.object({
    // the three retrieval axes
    completed: stringArraySchema,
    questioned: stringArraySchema,
    asked_about: stringArraySchema,
  }),
  provenance: z.enum(['forward', 'backfill', 'manual']),
  generated_at: z.string(),
  synthesizer_version: z.string(),
});

export type RecallRecord = z.infer<typeof recallRecordSchema>;
export type HandoffIn = z.infer<typeof handoffInSchema>;
export type HandoffOut = z.infer<typeof handoffOutSchema>;
export type ToolCount = z.infer<typeof toolCountSchema>;
export type Provenance = RecallRecord['provenance'];

/** Parse + validate an unknown value as a RecallRecord (throws on failure). */
export const parseRecallRecord = (value: unknown): RecallRecord => recallRecordSchema.parse(value);

/** Non-throwing variant for hot paths that must degrade gracefully. */
export const safeParseRecallRecord = (
  value: unknown,
): ReturnType<typeof recallRecordSchema.safeParse> => recallRecordSchema.safeParse(value);
