#!/usr/bin/env bash
# cc-recall SessionStart hook: ensures dist/ and node_modules/ exist in the plugin cache.
# Runs pnpm install + build on first use; subsequent sessions skip instantly.

set -euo pipefail

PLUGIN_DIR="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PROCEED='{"continue":true,"suppressOutput":true}'

if [[ -f "$PLUGIN_DIR/dist/bin/cc-recall.js" ]]; then
  echo "$PROCEED"
  exit 0
fi

if ! command -v pnpm &>/dev/null; then
  echo "$PROCEED"
  exit 0
fi

cd "$PLUGIN_DIR"
pnpm install --frozen-lockfile --ignore-scripts >/dev/null 2>&1 || true
pnpm build >/dev/null 2>&1 || true

echo "$PROCEED"
