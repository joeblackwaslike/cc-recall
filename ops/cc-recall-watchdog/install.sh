#!/usr/bin/env bash
# Install cc-recall-watchdog: the launchd light-tick watchdog.
#
# Notify-only: on an elevated signal it writes an incident + a pending request and, if
# ~/.cc-recall-watchdog/owner.json is set up, DMs you. There is no auto-fix and no approval
# bridge (see README) — a human reads the incident and decides.
# Idempotent — safe to re-run after editing scripts/plists.
set -euo pipefail

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LA="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
LABEL="com.ccrecall.watchdog-light"

echo "==> scripts executable"
chmod +x "$OPS_DIR"/bin/*.sh "$OPS_DIR"/*.sh

echo "==> state dirs"
mkdir -p "$HOME/.cc-recall-watchdog/"{pending,decisions,logs}

echo "==> (re)load launchd unit"
mkdir -p "$LA"
# Render, not symlink: the checked-in plist is a template (__OPS_DIR__/__HOME__ placeholders) so
# it stays portable across machines and clone locations instead of baking in this one's paths.
sed -e "s|__OPS_DIR__|$OPS_DIR|g" -e "s|__HOME__|$HOME|g" \
  "$OPS_DIR/launchd/$LABEL.plist" >"$LA/$LABEL.plist"
launchctl bootout  "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$LA/$LABEL.plist"
launchctl enable   "gui/$UID_NUM/$LABEL"
echo "    loaded $LABEL"

cat <<EOF

Done. The watchdog is now ticking every 5 min — notify-only, no auto-fix.

  • Verify:     launchctl list | grep ccrecall
  • Force a run: launchctl kickstart -k gui/$UID_NUM/$LABEL
  • Watch:      tail -f ~/.cc-recall-watchdog/incidents.jsonl

Telegram escalations require ~/.cc-recall-watchdog/owner.json (there is no approval bridge
here to self-bootstrap it — see cc-recall-mfr for claude-mem's parked one). Set it manually:
  echo '{"channel":"telegram","id":"<your-chat-id>"}' > ~/.cc-recall-watchdog/owner.json

Without it, escalations still land in incidents.jsonl and pending/ — you just won't get a DM.
EOF
