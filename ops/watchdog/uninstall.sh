#!/usr/bin/env bash
# Remove the claude-mem-watchdog launchd jobs.
# Leaves ~/.claude-mem-watchdog state (incidents, owner.json) intact unless --purge.
# Does NOT touch OpenClaw (the approval bridge is parked and not installed by install.sh).
set -euo pipefail

LA="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
LABELS=(com.claudemem.watchdog-light com.claudemem.watchdog-audit)

for label in "${LABELS[@]}"; do
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  rm -f "$LA/$label.plist"
  echo "removed $label"
done

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$HOME/.claude-mem-watchdog"
  echo "purged ~/.claude-mem-watchdog"
fi
echo "Done."
