// Shared types/constants between home-path.ts (the migration itself) and home-path-journal.ts
// (rebuilding a manifest from the journal alone) — split out to avoid a cycle between them.

export interface DirMove {
  from: string;
  to: string;
}
export interface FileMerge {
  from: string;
  to: string;
  /** Target already existed — a genuine collision we skipped (should not happen with UUIDs). */
  collision: boolean;
}
export interface FileRewrite {
  file: string;
  count: number;
}

export const OP_BEGIN = 'begin';
export const OP_DIR_MOVE = 'dir-move';
export const OP_FILE_MERGE = 'file-merge';
export const OP_FILE_REWRITE = 'file-rewrite';
export const OP_FAILURE = 'failure';
export const OP_COMPLETE = 'complete';

export type FailureStage = typeof OP_DIR_MOVE | typeof OP_FILE_MERGE | typeof OP_FILE_REWRITE;

export interface MigrateFailure {
  stage: FailureStage;
  target: string;
  error: string;
}

export interface MigrateManifest {
  from: string;
  to: string;
  dryRun: boolean;
  dirMoves: DirMove[];
  fileMerges: FileMerge[];
  rewrites: FileRewrite[];
  /** Additive — absent or empty on a clean run; an old pre-fix manifest has no such field. */
  failures?: MigrateFailure[];
}

export type JournalEntry =
  | { op: typeof OP_BEGIN; from: string; to: string; ts: number }
  | { op: typeof OP_DIR_MOVE; from: string; to: string; ts: number }
  | { op: typeof OP_FILE_MERGE; from: string; to: string; ts: number }
  | { op: typeof OP_FILE_REWRITE; file: string; count: number; ts: number }
  | { op: typeof OP_FAILURE; stage: FailureStage; target: string; error: string; ts: number }
  | { op: typeof OP_COMPLETE; ts: number; failures: number };
