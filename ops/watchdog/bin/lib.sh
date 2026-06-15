#!/usr/bin/env bash
# claude-mem-watchdog — shared library. Sourced by watchdog-light.sh / watchdog-audit.sh.
# Pure shell + jq + sqlite3 + curl + openclaw. No long-lived state; safe to run repeatedly.

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
  jq -cn --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg k "$kind" --arg m "$msg" \
     --argjson x "$extra" '{t:$t, kind:$k, msg:$m} + $x' >>"$INCIDENTS" 2>/dev/null || true
  info "[$kind] $msg"
}

# --- State (jq-backed key store) --------------------------------------------
state_get() { [ -f "$STATE_JSON" ] && jq -r --arg k "$1" '.[$k] // empty' "$STATE_JSON" 2>/dev/null || true; }
state_set() {
  local k="$1" v="$2" tmp; tmp="$(mktemp)"
  [ -f "$STATE_JSON" ] || echo '{}' >"$STATE_JSON"
  jq --arg k "$k" --arg v "$v" '.[$k]=$v' "$STATE_JSON" >"$tmp" 2>/dev/null && mv "$tmp" "$STATE_JSON" || rm -f "$tmp"
}

# circuit breaker: count consecutive failures per fix key
cb_fails() { state_get "cb_${1}"; }
cb_bump()  { local k="$1" n; n=$(( $(cb_fails "$k" 2>/dev/null || echo 0) + 1 )); state_set "cb_${k}" "$n"; echo "$n"; }
cb_reset() { state_set "cb_$1" "0"; }

# --- claude-mem worker -------------------------------------------------------
plugin_dir() {
  # newest version dir that actually contains the worker scripts
  local d
  for d in $(ls -dt "$PLUGIN_GLOB"/[0-9]*/ 2>/dev/null); do
    d="${d%/}"
    [ -f "$d/scripts/bun-runner.js" ] && [ -f "$d/scripts/worker-service.cjs" ] && { printf '%s\n' "$d"; return 0; }
  done
  return 1
}

worker_healthy() { curl -sf -m "$WORKER_HEALTH_TIMEOUT_SECS" "http://${WORKER_HOST}:${WORKER_PORT}/health" >/dev/null 2>&1; }

worker_start() {
  local p; p="$(plugin_dir)" || { err "plugin dir not found under $PLUGIN_GLOB"; return 1; }
  "$NODE_BIN" "$p/scripts/bun-runner.js" "$p/scripts/worker-service.cjs" start </dev/null >>"$LOG_FILE" 2>&1
}

worker_stop() {
  local p; p="$(plugin_dir)" || return 1
  "$NODE_BIN" "$p/scripts/bun-runner.js" "$p/scripts/worker-service.cjs" stop </dev/null >>"$LOG_FILE" 2>&1 || true
}

# --- Database (PRAGMA only via CLI; never touches FTS tables) ---------------
# echoes: "<page_count> <freelist_count> <page_size>"
db_pragma() {
  [ -f "$CLAUDE_MEM_DB" ] || return 1
  "$SQLITE3" "$CLAUDE_MEM_DB" "PRAGMA page_count; PRAGMA freelist_count; PRAGMA page_size;" 2>/dev/null | paste -sd' ' -
}
db_size_mb() {
  local val pc ps
  val=$(db_pragma) || return 1
  read -r pc _ ps <<<"$val"
  if ! [[ "${pc:-}" =~ ^[0-9]+$ ]] || ! [[ "${ps:-}" =~ ^[0-9]+$ ]]; then return 1; fi
  echo $(( pc * ps / 1048576 ))
}
db_freelist_ratio() { # prints e.g. 0.50 (2 dp) via awk
  local val pc fl _
  val=$(db_pragma) || return 1
  read -r pc fl _ <<<"$val"
  if ! [[ "${pc:-}" =~ ^[0-9]+$ ]] || ! [[ "${fl:-}" =~ ^[0-9]+$ ]]; then return 1; fi
  [ "$pc" -gt 0 ] 2>/dev/null && awk -v f="$fl" -v p="$pc" 'BEGIN{printf "%.2f", f/p}' || echo 0
}

# --- CLAUDE_CODE_PATH validity / repair -------------------------------------
claude_code_path() { jq -r '.CLAUDE_CODE_PATH // empty' "$CLAUDE_MEM_SETTINGS" 2>/dev/null; }
resolve_valid_claude() { local c; for c in "${CLAUDE_CANDIDATES[@]}"; do [ -x "$c" ] && { printf '%s\n' "$c"; return 0; }; done; return 1; }
patch_claude_code_path() {
  local newp="$1" tmp; tmp="$(mktemp)"
  jq --arg p "$newp" '.CLAUDE_CODE_PATH=$p' "$CLAUDE_MEM_SETTINGS" >"$tmp" 2>/dev/null \
    && cp -p "$CLAUDE_MEM_SETTINGS" "$CLAUDE_MEM_SETTINGS.bak-watchdog" && mv "$tmp" "$CLAUDE_MEM_SETTINGS" \
    || { rm -f "$tmp"; return 1; }
}

# --- Orphan reaping ----------------------------------------------------------
orphan_count() { pgrep -fc "$PLUGIN_GLOB/.*/scripts/mcp-server.cjs" 2>/dev/null || echo 0; }
reap_orphans() { pkill -f "$PLUGIN_GLOB/.*/scripts/mcp-server.cjs" 2>/dev/null || true; }

# --- Notification (one-way send via OpenClaw) -------------------------------
owner_target() { [ -f "$OWNER_FILE" ] && jq -r '.id // empty' "$OWNER_FILE" 2>/dev/null | sed 's/^telegram://' || true; }
gateway_up() { "$OPENCLAW" gateway status --json --require-rpc 2>/dev/null | jq -e '.service.runtime.status=="running" or .rpc.ok==true' >/dev/null 2>&1; }

notify() {
  local text="$1" tgt; tgt="$(owner_target)"
  [ -n "$tgt" ] || { warn "notify skipped: no owner id (owner.json not bootstrapped — DM the bot once)"; return 1; }
  gateway_up || { warn "notify skipped: OpenClaw gateway not ready"; return 1; }
  "$OPENCLAW" message send --channel "$TELEGRAM_CHANNEL" --target "$tgt" \
     --message "$NOTIFY_PREFIX: $text" --json 2>/dev/null | jq -e '.payload.ok==true' >/dev/null 2>&1
}

# --- Approval request lifecycle ---------------------------------------------
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
  jq -cn --arg id "$id" --arg c "$cond" --arg a "$action" --argjson p "$params" \
     --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg exp "$exp" \
     '{id:$id, condition:$c, action:$a, params:$p, created_at:$created, expires_at:$exp, status:"awaiting-approval"}' \
     >"$STATE_DIR/pending/$id.json"
  incident escalation "$cond" "$(jq -cn --arg id "$id" --arg a "$action" '{requestId:$id, action:$a}')"
  notify "⚠️ $cond
Proposed: $action
Reply: approve $id   |   deny $id   (expires ${APPROVAL_EXPIRY_HOURS}h)" || warn "request $id created but notify failed"
  printf '%s\n' "$id"
}

# is the ISO8601 in $1 in the past?
_expired() { local exp="$1" now; now="$(date -u +%s)"; local e; e="$(date -u -j -f %Y-%m-%dT%H:%M:%SZ "$exp" +%s 2>/dev/null || echo 0)"; [ "$e" -gt 0 ] && [ "$now" -ge "$e" ]; }

# process_decisions <dispatch_fn>  — poll pending vs decisions, run approved actions
# dispatch_fn is called as: dispatch_fn <action> <params-json> ; must return 0 on success
process_decisions() {
  local dispatch="$1" pf id status verdict action params dfile
  for pf in "$STATE_DIR"/pending/*.json; do
    [ -e "$pf" ] || continue
    status="$(jq -r '.status' "$pf")"; [ "$status" = "awaiting-approval" ] || continue
    id="$(jq -r '.id' "$pf")"; action="$(jq -r '.action' "$pf")"; params="$(jq -c '.params' "$pf")"
    dfile="$STATE_DIR/decisions/$id.json"
    if [ -f "$dfile" ]; then
      verdict="$(jq -r '.verdict' "$dfile")"
      if [ "$verdict" = "approve" ]; then
        if _expired "$(jq -r '.expires_at' "$pf")"; then
          _mark "$pf" expired; notify "🕗 request $id approved too late (expired) — not acting"; continue
        fi
        if "$dispatch" "$action" "$params"; then
          _mark "$pf" executed; incident executed "approved action ran: $action" "$(jq -cn --arg id "$id" '{requestId:$id}')"
          notify "✅ done: $action (req $id)"
        else
          _mark "$pf" failed; notify "❌ approved action FAILED: $action (req $id) — see logs"
        fi
      elif [ "$verdict" = "deny" ]; then
        _mark "$pf" denied; incident denied "owner denied: $action" "$(jq -cn --arg id "$id" '{requestId:$id}')"
        notify "🛑 skipped (denied): $action (req $id)"
      fi
    elif _expired "$(jq -r '.expires_at' "$pf")"; then
      _mark "$pf" expired; incident expired "no response: $action" "$(jq -cn --arg id "$id" '{requestId:$id}')"
    fi
  done
}
_mark() { local pf="$1" s="$2" tmp; tmp="$(mktemp)"; jq --arg s "$s" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.status=$s | .resolved_at=$t' "$pf" >"$tmp" && mv "$tmp" "$pf" || rm -f "$tmp"; }
