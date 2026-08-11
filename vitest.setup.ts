// Isolates every test file from the real ~/.claude/cc-recall/metrics directory.
//
// Without this, any test that exercises synthesize()/indexSession() with a working LLM runner
// (mocked child_process.spawn still resolves "successfully") writes real enrichment_spawn
// events into the developer's own adoption.jsonl and is subject to the real spawn-rate ceiling
// -- discovered when a full local test run wrote 30 fake events and started throttling actual
// cc-recall usage to heuristic-only for the following hour. Individual tests that need a
// specific metrics dir (e.g. the spawn-ceiling suite) still override this via `vi.stubEnv`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const scratchDir = mkdtempSync(path.join(tmpdir(), 'cc-recall-test-metrics-'));
process.env.CC_RECALL_METRICS_DIR = scratchDir;

// Don't leave orphaned scratch dirs behind on every run -- the exact "unbounded growth from
// never-cleaned-up state" class of bug this whole ticket exists to guard against.
afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});
