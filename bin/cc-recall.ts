#!/usr/bin/env node
// cc-recall CLI entry (spec §6, §9, §12).
//
// Thin command layer over the engine: index / backfill / migrate / search / revert /
// doctor. All heavy lifting lives in src/ so the same logic is reachable from hooks and
// future platform adapters. `doctor` is the G0 acceptance test (spec §12).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import {
  type BackfillOptions,
  type IndexOptions,
  type IndexResult,
  backfill,
  coverage,
  indexSession,
} from '../src/engine.js';
import { migrateHomePaths, revertHomePaths } from '../src/migrate/home-path.js';
import { verifyClaudeMemG0 } from '../src/surfaces/claude-mem.js';
import { defaultFrontPagePath, writeFrontPage } from '../src/surfaces/native-memory.js';
import { openSidecar } from '../src/surfaces/sidecar.js';
import { revertTranscript } from '../src/surfaces/transcript-writer.js';
import { parseTranscriptText } from '../src/transcript/parse.js';

const PCT = 100;

const DB_FLAG = '--db <path>';
const DB_DESC = 'sidecar database path';
const BASE_FLAG = '--base-dir <path>';
const BASE_DESC = 'backup base directory';
const NO_LLM_FLAG = '--no-llm';
const NO_LLM_DESC = 'skip LLM enrichment (heuristic only)';
const DRY_RUN_DESC = 'preview only — no writes';
const FORCE_DESC = 'reindex even if unchanged';

const baseDirDefault = (): string => path.join(homedir(), '.claude', 'cc-recall');
const dbDefault = (): string => path.join(baseDirDefault(), 'index.db');

const out = (message: string): void => {
  process.stdout.write(`${message}\n`);
};
const err = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

interface DbOptions {
  db: string;
  baseDir: string;
}
interface IndexCliOptions extends DbOptions {
  llm: boolean;
  force?: boolean;
  dryRun?: boolean;
}
interface BackfillCliOptions extends DbOptions {
  llm: boolean;
  scope?: string;
  limit?: string;
  dryRun?: boolean;
  force?: boolean;
}
interface MigrateCliOptions {
  from: string;
  to: string;
  baseDir: string;
  apply?: boolean;
  revert?: boolean;
}
interface SearchCliOptions {
  db: string;
  limit: string;
}

const indexVerb = (result: IndexResult): string => {
  if (result.skipped) return 'skip';
  return result.written ? 'wrote' : 'ok';
};

const indexOptionsFrom = (cli: IndexCliOptions): IndexOptions => {
  const options: IndexOptions = {
    provenance: 'forward',
    baseDir: cli.baseDir,
    onWarn: err,
    force: cli.force ?? false,
    dryRun: cli.dryRun ?? false,
  };
  if (!cli.llm) options.llm = false;
  return options;
};

const backfillOptionsFrom = (cli: BackfillCliOptions): BackfillOptions => {
  const options: BackfillOptions = {
    baseDir: cli.baseDir,
    onWarn: err,
    dryRun: cli.dryRun ?? false,
    force: cli.force ?? false,
    onProgress: (done, total, result) => {
      err(`[${done}/${total}] ${result.skipped ? 'skip' : 'idx'} ${result.sessionId}`);
    },
  };
  if (!cli.llm) options.llm = false;
  if (cli.scope) options.scope = cli.scope;
  if (cli.limit) options.limit = Number(cli.limit);
  return options;
};

const runIndex = async (file: string, cli: IndexCliOptions): Promise<void> => {
  const sidecar = openSidecar(cli.db);
  try {
    const result = await indexSession(file, sidecar, indexOptionsFrom(cli));
    out(`${indexVerb(result)}  ${result.sessionId}  ${result.title}`);
  } finally {
    sidecar.close();
  }
};

const runBackfill = async (cli: BackfillCliOptions): Promise<void> => {
  const sidecar = openSidecar(cli.db);
  try {
    const summary = await backfill(sidecar, backfillOptionsFrom(cli));
    out(
      `backfill: ${summary.processed}/${summary.total} processed, ${summary.written} written, ${summary.skipped} skipped, ${summary.failed} failed`,
    );
  } finally {
    sidecar.close();
  }
};

const runMigrate = (options: MigrateCliOptions): void => {
  if (options.revert) {
    const manifest = revertHomePaths({ baseDir: options.baseDir });
    out(`reverted: ${manifest.dirMoves.length} dirs, ${manifest.rewrites.length} files`);
    return;
  }
  const manifest = migrateHomePaths({
    from: options.from,
    to: options.to,
    baseDir: options.baseDir,
    dryRun: !options.apply,
  });
  out(
    `${manifest.dryRun ? 'DRY-RUN' : 'APPLIED'}: ${manifest.dirMoves.length} dir moves, ${manifest.fileMerges.length} merges, ${manifest.rewrites.length} rewrites`,
  );
  if (manifest.dryRun) out('re-run with --apply to perform the migration');
};

const runSearch = (query: string, options: SearchCliOptions): void => {
  const sidecar = openSidecar(options.db);
  try {
    const hits = sidecar.search(query, Number(options.limit));
    if (hits.length === 0) {
      out('no matches');
      return;
    }
    for (const hit of hits) out(`${hit.record.session_id}  ${hit.record.title}`);
  } finally {
    sidecar.close();
  }
};

const runRevert = (file: string, options: { baseDir: string }): void => {
  const parsed = parseTranscriptText(readFileSync(file, 'utf8'), file);
  const reverted = revertTranscript(file, parsed.sessionId, { baseDir: options.baseDir });
  out(reverted ? `reverted ${parsed.sessionId}` : `no backup for ${parsed.sessionId}`);
};

const reportSidecar = (db: string): void => {
  const sidecar = openSidecar(db);
  try {
    const stats = sidecar.stats();
    sidecar.search('integrity probe'); // exercises the FTS path
    out(`sidecar: OK — ${stats.total} sessions at ${db}`);
    const cov = coverage(sidecar);
    out(
      `coverage: ${(cov.pct * PCT).toFixed(1)}% (${cov.indexed}/${cov.total} transcripts indexed)`,
    );
  } catch (error) {
    process.exitCode = 1;
    err(`sidecar: FAILED — ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    sidecar.close();
  }
};

const runDoctor = async (options: { db: string }): Promise<void> => {
  reportSidecar(options.db);
  // G0 (spec §12): claude-mem must pass before surface ③ is enabled.
  const g0 = await verifyClaudeMemG0();
  out(
    g0.pass
      ? `claude-mem G0: PASS — ${g0.detail} (v${g0.health.version ?? '?'})`
      : `claude-mem G0: FAIL — ${g0.detail} (surface ③ stays disabled — sidecar unaffected)`,
  );
};

const runFrontPage = (options: { db: string; out: string; topN: string }): void => {
  const sidecar = openSidecar(options.db);
  try {
    const result = writeFrontPage(sidecar, {
      path: options.out,
      topN: Number(options.topN),
      dbPath: options.db,
    });
    out(`front page: ${result.count} sessions → ${result.path}`);
  } finally {
    sidecar.close();
  }
};

const program = new Command();
program
  .name('cc-recall')
  .description(
    'Make every Claude Code session discoverable by what was done, asked, and questioned.',
  )
  .version('0.1.0');

program
  .command('index <file>')
  .description('Index a single transcript into the sidecar + transcript')
  .option(DB_FLAG, DB_DESC, dbDefault())
  .option(BASE_FLAG, BASE_DESC, baseDirDefault())
  .option(NO_LLM_FLAG, NO_LLM_DESC)
  .option('--force', FORCE_DESC)
  .option('--dry-run', DRY_RUN_DESC)
  .action((file: string, options: IndexCliOptions) => runIndex(file, options));

program
  .command('backfill')
  .description('Index every transcript (idempotent, resumable)')
  .option(DB_FLAG, DB_DESC, dbDefault())
  .option(BASE_FLAG, BASE_DESC, baseDirDefault())
  .option('--scope <substring>', 'only project dirs containing this substring')
  .option('--limit <n>', 'stop after N transcripts')
  .option(NO_LLM_FLAG, NO_LLM_DESC)
  .option('--dry-run', DRY_RUN_DESC)
  .option('--force', FORCE_DESC)
  .action((options: BackfillCliOptions) => runBackfill(options));

program
  .command('migrate')
  .description('Home-path normalization (dry-run by default)')
  .option('--from <path>', 'old home', '/Users/joeblack')
  .option('--to <path>', 'new home', '/Users/joe')
  .option('--base-dir <path>', 'backup/manifest base directory', baseDirDefault())
  .option('--apply', 'perform the migration (default is dry-run)')
  .option('--revert', 'reverse a prior migration from its manifest')
  .action((options: MigrateCliOptions) => {
    runMigrate(options);
  });

program
  .command('search <query>')
  .description('Full-text search the sidecar')
  .option(DB_FLAG, DB_DESC, dbDefault())
  .option('--limit <n>', 'max results', '20')
  .action((query: string, options: SearchCliOptions) => {
    runSearch(query, options);
  });

program
  .command('revert <file>')
  .description('Restore a transcript from its cc-recall backup')
  .option(BASE_FLAG, BASE_DESC, baseDirDefault())
  .action((file: string, options: { baseDir: string }) => {
    runRevert(file, options);
  });

program
  .command('doctor')
  .description('Health + G0 acceptance check (sidecar, coverage, claude-mem)')
  .option(DB_FLAG, DB_DESC, dbDefault())
  .action((options: { db: string }) => runDoctor(options));

program
  .command('frontpage')
  .description('Regenerate the native-memory front page from the sidecar')
  .option(DB_FLAG, DB_DESC, dbDefault())
  .option('--out <path>', 'front page output path', defaultFrontPagePath())
  .option('--top-n <n>', 'number of sessions to list', '25')
  .action((options: { db: string; out: string; topN: string }) => {
    runFrontPage(options);
  });

await program.parseAsync(process.argv);
