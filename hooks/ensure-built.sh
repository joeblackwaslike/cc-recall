#!/usr/bin/env bash
# cc-recall SessionStart hook: ensures dist/ reflects the current source in the plugin cache.
# Runs pnpm install + build when missing OR stale; an up-to-date cache skips instantly.
#
# A SessionStart hook must never block the session, so a build failure cannot be fatal here.
# It must still be *visible*: the previous version discarded stdout, stderr and the exit code
# of both commands and then reported success, so a failed build left every subsequent
# SessionEnd spawning a dist/bin/cc-recall.js that did not exist — 4,897 "Cannot find module"
# stack traces, forward capture dead the whole time, and nothing anywhere saying so. The
# distinction that matters: not-fatal is not the same as not-reported.
#
# Root cause of Incident B (2026-08): this script also used to build once, ever, and never
# rebuild — checking only "does dist/bin/cc-recall.js exist". A fix merged to main
# (c0713ca/f0190fd) never actually reached the running plugin because of that, and because
# Claude Code's plugin cache is keyed by package.json's version string, which was never
# bumped — two independent reasons the same never-deployed bug kept running for six weeks.
# The hash-stamp check below is the first of the two; the version bump is a release-process
# fix, not something this script can address.

set -euo pipefail

PLUGIN_DIR="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
ENTRYPOINT="$PLUGIN_DIR/dist/bin/cc-recall.js"
STAMP_FILE="$PLUGIN_DIR/dist/.build-stamp"
PROCEED='{"continue":true,"suppressOutput":true}'

respond_and_exit() {
  echo "$PROCEED"
  exit 0
}

# Emit {"continue":true} with a systemMessage the user actually sees. jq keeps the message
# correctly escaped; without it a build log containing a quote or newline would produce
# malformed JSON, and a hook whose output cannot be parsed is a second silent failure.
warn_and_proceed() {
  local message="$1"
  if command -v jq &>/dev/null; then
    jq -nc --arg m "$message" '{continue:true, systemMessage:$m}'
  else
    printf '{"continue":true,"systemMessage":"cc-recall: build failed; see %s"}\n' \
      "${LOG_FILE//\"/}"
  fi
  exit 0
}

# Hash of every input that changes what dist/ should contain. Order-independent inputs (lockfile,
# manifest) are hashed as-is; src/**/*.ts is sorted first so file-system iteration order can't
# produce a spurious hash change.
current_hash() {
  {
    cat "$PLUGIN_DIR/package.json" 2>/dev/null
    cat "$PLUGIN_DIR/pnpm-lock.yaml" 2>/dev/null
    find "$PLUGIN_DIR/src" -type f -name '*.ts' -print0 2>/dev/null | sort -z | xargs -0 cat 2>/dev/null
  } | shasum -a 256 | cut -d' ' -f1
}

if [[ -f "$ENTRYPOINT" && -f "$STAMP_FILE" ]]; then
  if [[ "$(cat "$STAMP_FILE" 2>/dev/null)" == "$(current_hash)" ]]; then
    respond_and_exit
  fi
fi

if ! command -v pnpm &>/dev/null; then
  warn_and_proceed "cc-recall: pnpm not found, so the plugin could not be built. Forward capture (SessionEnd indexing) is disabled until it is installed and a new session starts."
fi

cd "$PLUGIN_DIR"
LOG_DIR="${CC_RECALL_BASE_DIR:-$HOME/.claude/cc-recall}/logs"
mkdir -p "$LOG_DIR" 2>/dev/null || true
LOG_FILE="$LOG_DIR/build.log"

# Keep the output rather than discarding it: this log is the only artifact that explains why
# forward capture stopped working, and it is written before the failure is reported.
if ! pnpm install --frozen-lockfile --ignore-scripts >"$LOG_FILE" 2>&1; then
  warn_and_proceed "cc-recall: pnpm install failed, forward capture disabled. Last lines: $(tail -3 "$LOG_FILE" | tr '\n' ' ')"
fi

if ! pnpm build >>"$LOG_FILE" 2>&1; then
  warn_and_proceed "cc-recall: build failed, forward capture disabled. Last lines: $(tail -3 "$LOG_FILE" | tr '\n' ' ')"
fi

# Both commands can succeed and still not produce the entrypoint — a changed build target, an
# output path moved. Verifying the artifact rather than the exit code is what makes this a real
# gate instead of an assumption.
if [[ ! -f "$ENTRYPOINT" ]]; then
  warn_and_proceed "cc-recall: build reported success but $ENTRYPOINT is missing, so forward capture is disabled. Full log: $LOG_FILE"
fi

current_hash > "$STAMP_FILE"

echo "$PROCEED"
