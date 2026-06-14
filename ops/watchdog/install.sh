#!/usr/bin/env bash
# Install claude-mem-watchdog: the launchd auto-fix watchdog (light + audit jobs).
#
# This installs ONLY the self-sufficient watchdog. The Telegram approve/deny
# bridge is PARKED (see ops/watchdog/openclaw/ and beads cc-recall-mfr) — it is
# NOT installed here and this script does NOT touch your OpenClaw gateway.
# Idempotent — safe to re-run after editing scripts/plists.
set -euo pipefail

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LA="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
LABELS=(com.claudemem.watchdog-light com.claudemem.watchdog-audit)

echo "==> scripts executable"
chmod +x "$OPS_DIR"/bin/*.sh "$OPS_DIR"/*.sh

echo "==> state dirs"
mkdir -p "$HOME/.claude-mem-watchdog/"{pending,decisions,logs}

echo "==> (re)load launchd units"
mkdir -p "$LA"
for label in "${LABELS[@]}"; do
  ln -sfn "$OPS_DIR/launchd/$label.plist" "$LA/$label.plist"
  launchctl bootout  "gui/$UID_NUM/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$LA/$label.plist"
  launchctl enable   "gui/$UID_NUM/$label"
  echo "    loaded $label"
done

cat <<EOF

Done. The watchdog auto-fixes (worker restart, orphan reap, CLAUDE_CODE_PATH
repair, VACUUM, queue prune) are now live and need nothing else.

  • Verify:     launchctl list | grep claudemem
  • Force a run: launchctl kickstart -k gui/$UID_NUM/com.claudemem.watchdog-audit
  • Watch:      tail -f ~/.claude-mem-watchdog/incidents.jsonl

Telegram escalations (one-way notify) require ~/.claude-mem-watchdog/owner.json.
That is auto-populated once the approval bridge is revived (cc-recall-mfr); until
then you can create it manually:
  echo '{"channel":"telegram","id":"<your-chat-id>"}' > ~/.claude-mem-watchdog/owner.json
EOF
