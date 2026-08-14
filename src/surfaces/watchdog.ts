// Whether the independent cc-recall-watchdog launchd job is actually registered.
//
// ops/cc-recall-watchdog was built in Phase 3 specifically to independently catch a silently
// non-functional in-process guard (the failure mode PM-001's 2026-08-14 recurrence confirmed:
// isIndexerTranscript() had a passing test for weeks while being completely inert in
// production). The watchdog itself was then found never installed as a launchd job for as long
// as it existed — "present in the repo" and "running on the machine" are different claims, and
// nothing checked the second one. This is that check.

import { execFileSync } from 'node:child_process';

export interface WatchdogStatus {
  installed: boolean;
  label: string;
  detail: string;
}

export const CC_RECALL_WATCHDOG_LABEL = 'com.ccrecall.watchdog-light';

/**
 * Query launchd directly rather than inspecting `~/Library/LaunchAgents/*.plist` — a plist file
 * existing only proves `install.sh` once wrote it, not that the job is currently loaded. `exit
 * 0` from `launchctl list <label>` is launchd's own claim that the job is registered right now.
 */
export const checkWatchdogInstalled = (
  label: string = CC_RECALL_WATCHDOG_LABEL,
): WatchdogStatus => {
  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- intentionally invoke the user's installed launchctl via PATH
    execFileSync('launchctl', ['list', label], { stdio: 'ignore' });
    return { installed: true, label, detail: 'registered with launchd' };
  } catch (error) {
    // Covers both "job not registered" (launchctl exits non-zero) and "launchctl itself is
    // unavailable" (non-macOS) identically: doctor reports a warning either way, never throws.
    return {
      installed: false,
      label,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};
