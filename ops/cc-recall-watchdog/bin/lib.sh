#!/usr/bin/env bash
# cc-recall-watchdog — shared library. Sourced by watchdog-light.sh.
#
# Logging / incident-log / circuit-breaker / notify / approval-lifecycle primitives are ported
# byte-for-byte in behavior from ops/watchdog/bin/lib.sh (claude-mem-watchdog) per spec Phase 3:
# "reuses ops/watchdog, do not build a new circuit breaker from scratch." Only the
# claude-mem-specific pieces (worker health, DB PRAGMA, CLAUDE_CODE_PATH repair, orphan reaping)
# are dropped — cc-recall has no long-lived worker process and its sidecar is a plain SQLite
# file, not a service to health-check.
#
# Pure shell + jq. No long-lived state beyond STATE_DIR; safe to run repeatedly.

set -uo pipefail

# Resolve repo dir and load config -------------------------------------------
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$LIB_DIR/.." && pwd)"
# shellcheck source=/dev/null
. "$REPO_DIR/etc/watchdog.conf"

mkdir -p "$STATE_DIR/pending" "$STATE_DIR/decisions" "$STATE_DIR/logs" 2>/dev/null || true

SCRIPT_NAME="${SCRIPT_NAME:-watchdog}"
LOG_FILE="$STATE_DIR/logs/${SCRIPT_NAME}-$(date +%Y-%m-%d).log"
INCIDENTS="$STATE_DIR/incidents.jsonl"
STATE_JSON="$STATE_DIR/state.json"

# --- Logging -----------------------------------------------------------------
log() { printf '[%s] [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${1}" "${2}" >>"$LOG_FILE"; }
info() { log INFO "$1"; }
warn() { log WARN "$1"; }
err()  { log ERROR "$1"; }

# incident <kind> <message> [extra-json]  → append a structured audit record
incident() {
  local kind="$1" msg="$2" extra="${3:-}"; [ -n "$extra" ] || extra='{}'
  "$JQ" -cn --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg k "$kind" --arg m "$msg" \
     --argjson x "$extra" '{t:$t, kind:$k, msg:$m} + $x' >>"$INCIDENTS" 2>/dev/null || true
  info "[$kind] $msg"
}

# --- State (jq-backed key store) --------------------------------------------
state_get() { [ -f "$STATE_JSON" ] && "$JQ" -r --arg k "$1" '.[$k] // empty' "$STATE_JSON" 2>/dev/null || true; }
state_set() {
  local k="$1" v="$2" tmp; tmp="$(mktemp)"
  [ -f "$STATE_JSON" ] || echo '{}' >"$STATE_JSON"
  "$JQ" --arg k "$k" --arg v "$v" '.[$k]=$v' "$STATE_JSON" >"$tmp" 2>/dev/null && mv "$tmp" "$STATE_JSON" || rm -f "$tmp"
}

# circuit breaker: count consecutive elevated ticks per condition key
cb_fails() { state_get "cb_${1}"; }
cb_bump()  { local k="$1" n; n=$(( $(cb_fails "$k" 2>/dev/null || echo 0) + 1 )); state_set "cb_${k}" "$n"; echo "$n"; }
cb_reset() { state_set "cb_$1" "0"; }

# --- Notification (one-way send via OpenClaw) -------------------------------
owner_target() { [ -f "$OWNER_FILE" ] && "$JQ" -r '.id // empty' "$OWNER_FILE" 2>/dev/null | sed 's/^telegram://' || true; }
gateway_up() { "$OPENCLAW" gateway status --json --require-rpc 2>/dev/null | "$JQ" -e '.service.runtime.status=="running" or .rpc.ok==true' >/dev/null 2>&1; }

notify() {
  local text="$1" tgt; tgt="$(owner_target)"
  [ -n "$tgt" ] || { warn "notify skipped: no owner id (owner.json not set — see README)"; return 1; }
  gateway_up || { warn "notify skipped: OpenClaw gateway not ready"; return 1; }
  "$OPENCLAW" message send --channel "$TELEGRAM_CHANNEL" --target "$tgt" \
     --message "$NOTIFY_PREFIX: $text" --json 2>/dev/null | "$JQ" -e '.payload.ok==true' >/dev/null 2>&1
}

# --- Approval request lifecycle (escalation is notify-only; no approval bridge here yet) -----
# Short, typo-resistant id for typing on mobile: 4 chars from an unambiguous
# lowercase alphabet (no 0/o/1/l/i). ~32^4 ≈ 1M space; unique among open requests.
new_id() {
  local alphabet='abcdefghjkmnpqrstuvwxyz23456789' n id i
  n=${#alphabet}
  while :; do
    id=''
    for i in 1 2 3 4; do id+="${alphabet:RANDOM%n:1}"; done
    [ -e "$STATE_DIR/pending/$id.json" ] || { printf '%s\n' "$id"; return; }
  done
}

# request_create <condition> <action> [params-json] → prints id, notifies owner
request_create() {
  local cond="$1" action="$2" params="${3:-}" id; [ -n "$params" ] || params='{}'; id="$(new_id)"
  local exp; exp="$(date -u -v+"${APPROVAL_EXPIRY_HOURS}"H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  "$JQ" -cn --arg id "$id" --arg c "$cond" --arg a "$action" --argjson p "$params" \
     --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg exp "$exp" \
     '{id:$id, condition:$c, action:$a, params:$p, created_at:$created, expires_at:$exp, status:"awaiting-approval"}' \
     >"$STATE_DIR/pending/$id.json"
  incident escalation "$cond" "$("$JQ" -cn --arg id "$id" --arg a "$action" '{requestId:$id, action:$a}')"
  notify "⚠️ $cond
(req $id, notify-only — no auto-fix, see incidents.jsonl and cc-recall's own logs)" || warn "request $id created but notify failed"
  printf '%s\n' "$id"
}
