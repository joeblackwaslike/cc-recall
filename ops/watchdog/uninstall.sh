#!/usr/bin/env bash
# Remove claude-mem-watchdog launchd jobs + OpenClaw bridge registration.
# Leaves ~/.claude-mem-watchdog state (incidents, owner.json) intact unless --purge.
set -euo pipefail

LA="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
OPENCLAW="${OPENCLAW:-/opt/homebrew/bin/openclaw}"
BRIDGE_REL="./hooks/handlers/claude-mem-decision-bridge.mjs"
BRIDGE_DST="$HOME/.openclaw/workspace/hooks/handlers/claude-mem-decision-bridge.mjs"
LABELS=(com.claudemem.watchdog-light com.claudemem.watchdog-audit)

for label in "${LABELS[@]}"; do
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  rm -f "$LA/$label.plist"
  echo "removed $label"
done

echo "==> de-register OpenClaw bridge"
CUR="$("$OPENCLAW" config get hooks.internal.handlers --json 2>/dev/null || echo '[]')"
NEW="$(printf '%s' "$CUR" | jq -c --arg m "$BRIDGE_REL" 'if type!="array" then [] else map(select(.module != $m)) end')"
"$OPENCLAW" config set hooks.internal.handlers "$NEW" --strict-json >/dev/null 2>&1 || true
rm -f "$BRIDGE_DST"
"$OPENCLAW" gateway restart >/dev/null 2>&1 || true

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$HOME/.claude-mem-watchdog"
  echo "purged ~/.claude-mem-watchdog"
fi
echo "Done."
