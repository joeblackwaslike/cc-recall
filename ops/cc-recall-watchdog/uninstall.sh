#!/usr/bin/env bash
# Remove the cc-recall-watchdog launchd job.
# Leaves ~/.cc-recall-watchdog state (incidents, owner.json) intact unless --purge.
set -euo pipefail

LA="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
LABEL="com.ccrecall.watchdog-light"

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
rm -f "$LA/$LABEL.plist"
echo "removed $LABEL"

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$HOME/.cc-recall-watchdog"
  echo "purged ~/.cc-recall-watchdog"
fi
echo "Done."
