#!/usr/bin/env bash
# cc-recall SessionStart hook: ensures dist/ reflects the current source in the plugin cache.
# Runs pnpm install + build when missing OR stale; an up-to-date cache skips instantly.
#
# Root cause of Incident B (2026-08): this script used to build once, ever, and never rebuild --
# checking only "does dist/bin/cc-recall.js exist". A fix merged to main (c0713ca/f0190fd) never
# actually reached the running plugin because of that, and because Claude Code's plugin cache is
# keyed by package.json's version string, which was never bumped -- two independent reasons the
# same never-deployed bug kept running for six weeks. This hash-stamp check is the first of the
# two; the version bump is a release-process fix, not something this script can address.

set -euo pipefail

PLUGIN_DIR="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PROCEED='{"continue":true,"suppressOutput":true}'
DIST_ENTRY="$PLUGIN_DIR/dist/bin/cc-recall.js"
STAMP_FILE="$PLUGIN_DIR/dist/.build-stamp"

respond_and_exit() {
  echo "$PROCEED"
  exit 0
}

# Hash of every input that changes what dist/ should contain. Order-independent inputs (lockfile,
# manifest) are hashed as-is; the TS sources are sorted first so file-system iteration order
# can't produce a spurious hash change. bin/ is included alongside src/ because tsconfig.json
# compiles both into dist/ — hashing src/ alone means a bin/-only change is invisible here and
# the stale artifact would never be rebuilt.
current_hash() {
  {
    cat "$PLUGIN_DIR/package.json" 2>/dev/null
    cat "$PLUGIN_DIR/pnpm-lock.yaml" 2>/dev/null
    find "$PLUGIN_DIR/src" "$PLUGIN_DIR/bin" -type f -name '*.ts' -print0 2>/dev/null \
      | sort -z | xargs -0 cat 2>/dev/null
  } | shasum -a 256 | cut -d' ' -f1
}

if [[ -f "$DIST_ENTRY" && -f "$STAMP_FILE" ]]; then
  if [[ "$(cat "$STAMP_FILE" 2>/dev/null)" == "$(current_hash)" ]]; then
    respond_and_exit
  fi
fi

if ! command -v pnpm &>/dev/null; then
  respond_and_exit
fi

cd "$PLUGIN_DIR"
pnpm install --frozen-lockfile --ignore-scripts >/dev/null 2>&1 || true

# Stamp only on a build that actually succeeded. A pre-existing dist/ from a prior successful
# build satisfies the -f check below regardless of whether *this* build worked — writing the
# stamp unconditionally would silently lock in that stale artifact forever the next time the
# hash changes and the build fails again, which is the exact bug this script exists to fix.
if pnpm build >/dev/null 2>&1 && [[ -f "$DIST_ENTRY" ]]; then
  current_hash > "$STAMP_FILE"
fi

echo "$PROCEED"
