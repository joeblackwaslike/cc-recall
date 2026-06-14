#!/usr/bin/env bash
# Install claude-mem-watchdog: launchd jobs + OpenClaw decision bridge.
# Idempotent — safe to re-run after editing scripts/plists/handler.
set -euo pipefail

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LA="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
OPENCLAW="${OPENCLAW:-/opt/homebrew/bin/openclaw}"
WS_HOOKS="$HOME/.openclaw/workspace/hooks/handlers"
BRIDGE_SRC="$OPS_DIR/openclaw/decision-bridge/handler.mjs"
BRIDGE_DST="$WS_HOOKS/claude-mem-decision-bridge.mjs"
BRIDGE_REL="./hooks/handlers/claude-mem-decision-bridge.mjs"
LABELS=(com.claudemem.watchdog-light com.claudemem.watchdog-audit)

echo "==> scripts executable"
chmod +x "$OPS_DIR"/bin/*.sh "$OPS_DIR"/*.sh

echo "==> state dirs"
mkdir -p "$HOME/.claude-mem-watchdog/"{pending,decisions,logs}

echo "==> install OpenClaw decision bridge (the inbound-message listener)"
mkdir -p "$WS_HOOKS"
cp "$BRIDGE_SRC" "$BRIDGE_DST"
# enable internal hooks + register our handler for event 'message' (merge, don't clobber)
"$OPENCLAW" config set hooks.internal.enabled true --strict-json >/dev/null
CUR="$("$OPENCLAW" config get hooks.internal.handlers --json 2>/dev/null || echo '[]')"
NEW="$(printf '%s' "$CUR" | jq -c --arg m "$BRIDGE_REL" \
  'if type!="array" then [] else . end | map(select(.module != $m)) + [{event:"message", module:$m}]')"
"$OPENCLAW" config set hooks.internal.handlers "$NEW" --strict-json >/dev/null
echo "    registered $BRIDGE_REL ; restarting gateway to load it"
"$OPENCLAW" gateway restart >/dev/null 2>&1 || echo "    (gateway restart failed — restart manually)"

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

Done. Next:
  • DM your OpenClaw Telegram bot once (any text) so the bridge bootstraps your
    chat id into ~/.claude-mem-watchdog/owner.json (required for notifications).
  • Verify:   launchctl list | grep claudemem
  • Force a run:  launchctl kickstart -k gui/$UID_NUM/com.claudemem.watchdog-audit
  • Watch:    tail -f ~/.claude-mem-watchdog/incidents.jsonl
EOF
