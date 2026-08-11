#!/usr/bin/env bash
# cc-recall SessionStart hook: ensures dist/ reflects the current source in the plugin cache.
# Runs pnpm install + build when missing OR stale; an up-to-date cache skips instantly.
#
# A SessionStart hook must never block the session, so a build failure cannot be fatal here.
# It must still be *visible*: an earlier version discarded stdout, stderr and the exit code of
# both commands and then reported success, so a failed build left every subsequent SessionEnd
# spawning a dist/bin/cc-recall.js that did not exist — 4,897 "Cannot find module" stack traces,
# forward capture dead the whole time, and nothing anywhere saying so. The distinction that
# matters: not-fatal is not the same as not-reported.
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

# Set up before any warn_and_proceed call can reference it -- an earlier version referenced
# LOG_FILE in the missing-pnpm path before this assignment existed, which crashed under `set -u`
# instead of emitting the intended message. Order this ahead of every caller, not just the first.
LOG_DIR="${CC_RECALL_BASE_DIR:-$HOME/.claude/cc-recall}/logs"
mkdir -p "$LOG_DIR" 2>/dev/null || true
LOG_FILE="$LOG_DIR/build.log"

respond_and_exit() {
  echo "$PROCEED"
  exit 0
}

# Emit {"continue":true} with a systemMessage the user actually sees. jq keeps the message
# correctly escaped; without it a build log containing a quote or newline would produce
# malformed JSON, and a hook whose output cannot be parsed is a second silent failure. The
# non-jq fallback still carries the message text (not just a pointer to the log file) so the
# signal survives even on a machine without jq installed.
warn_and_proceed() {
  local message="$1"
  if command -v jq &>/dev/null; then
    jq -nc --arg m "$message" '{continue:true, systemMessage:$m}'
  else
    local escaped="${message//\\/\\\\}"
    escaped="${escaped//\"/\\\"}"
    printf '{"continue":true,"systemMessage":"%s"}\n' "$escaped"
  fi
  exit 0
}

# Hash of every input that changes what dist/ should contain. Order-independent inputs (lockfile,
# manifest) are hashed as-is; the TS sources are sorted first so file-system iteration order
# can't produce a spurious hash change. bin/ is included alongside src/ because tsconfig.json
# compiles both into dist/ — hashing src/ alone means a bin/-only change is invisible here and
# the stale artifact would never be rebuilt.
#
# Each TS file's path is written as a NUL-delimited boundary before and after its content
# (rather than concatenating raw bytes back to back). Path + boundaries means two different
# file sets whose contents happen to concatenate identically can't collide into the same hash,
# and a file that moves without changing gets a different hash, as it should.
#
# shasum is standard on macOS and is a Perl core-module wrapper present on effectively every
# Linux distro with Perl installed (verified directly against this repo's own ubuntu-latest CI
# runner: the rebuild/skip assertions below only pass if it produces real, distinct hashes).
# Still, if it's ever absent, fail loud rather than silently hashing to "" -- an empty hash would
# make the stamp comparison trivially true forever, which is the exact bug this script exists to
# prevent, self-inflicted.
current_hash() {
  if ! command -v shasum &>/dev/null; then
    echo "cc-recall ensure-built: shasum not found, cannot compute a build hash" >&2
    return 1
  fi
  {
    cat "$PLUGIN_DIR/package.json" 2>/dev/null
    cat "$PLUGIN_DIR/pnpm-lock.yaml" 2>/dev/null
    find "$PLUGIN_DIR/src" "$PLUGIN_DIR/bin" -type f -name '*.ts' -print0 2>/dev/null | sort -z \
      | while IFS= read -r -d '' file; do
          printf '\0%s\0' "$file"
          cat "$file" 2>/dev/null
        done
  } 2>/dev/null | shasum -a 256 | cut -d' ' -f1
}

if [[ -f "$ENTRYPOINT" && -f "$STAMP_FILE" ]]; then
  if [[ "$(cat "$STAMP_FILE" 2>/dev/null)" == "$(current_hash 2>/dev/null)" ]]; then
    respond_and_exit
  fi
fi

if ! command -v pnpm &>/dev/null; then
  warn_and_proceed "cc-recall: pnpm not found, so the plugin could not be built. Forward capture (SessionEnd indexing) is disabled until it is installed and a new session starts."
fi

cd "$PLUGIN_DIR"

# Keep the output rather than discarding it: this log is the only artifact that explains why
# forward capture stopped working, and it is written before any failure is reported. install
# failure is deliberately tolerated (`|| true`): node_modules from a prior install may still be
# usable, and the build step below is the one that's actually gated -- an install failure that
# leaves the tree unbuildable just surfaces as a build failure there.
if ! pnpm install --frozen-lockfile --ignore-scripts >"$LOG_FILE" 2>&1; then
  warn_and_proceed "cc-recall: pnpm install failed, forward capture disabled. Last lines: $(tail -3 "$LOG_FILE" | tr '\n' ' ')"
fi

# Stamp only on a build that actually succeeded. A pre-existing dist/ from a prior successful
# build satisfies the -f check below regardless of whether *this* build worked — writing the
# stamp unconditionally would silently lock in that stale artifact forever the next time the
# hash changes and the build fails again, which is the exact bug this script exists to fix.
if ! pnpm build >>"$LOG_FILE" 2>&1; then
  warn_and_proceed "cc-recall: build failed, forward capture disabled. Last lines: $(tail -3 "$LOG_FILE" | tr '\n' ' ')"
fi

# Both commands can succeed and still not produce the entrypoint — a changed build target, an
# output path moved. Verifying the artifact rather than the exit code is what makes this a real
# gate instead of an assumption.
if [[ ! -f "$ENTRYPOINT" ]]; then
  warn_and_proceed "cc-recall: build reported success but $ENTRYPOINT is missing, so forward capture is disabled. Full log: $LOG_FILE"
fi

# `|| true`: a hash failure here (e.g. shasum genuinely absent) must not crash the hook after a
# successful build. Leaving the stamp unwritten fails toward *more* rebuilding on the next run,
# not less -- the safe direction for a script whose whole job is not silently skipping a rebuild.
current_hash > "$STAMP_FILE" || true

echo "$PROCEED"
