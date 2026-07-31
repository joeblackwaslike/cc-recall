#!/usr/bin/env bash
# cc-recall SessionStart hook: ensures dist/ and node_modules/ exist in the plugin cache.
# Runs pnpm install + build on first use; subsequent sessions skip instantly.
#
# A SessionStart hook must never block the session, so a build failure cannot be fatal here.
# It must still be *visible*: the previous version discarded stdout, stderr and the exit code
# of both commands and then reported success, so a failed build left every subsequent
# SessionEnd spawning a dist/bin/cc-recall.js that did not exist — 4,897 "Cannot find module"
# stack traces, forward capture dead the whole time, and nothing anywhere saying so.
#
# The distinction that matters: not-fatal is not the same as not-reported.

set -euo pipefail

PLUGIN_DIR="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
ENTRYPOINT="$PLUGIN_DIR/dist/bin/cc-recall.js"
PROCEED='{"continue":true,"suppressOutput":true}'

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

if [[ -f "$ENTRYPOINT" ]]; then
  echo "$PROCEED"
  exit 0
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

echo "$PROCEED"
