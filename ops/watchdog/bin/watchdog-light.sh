#!/usr/bin/env bash
# claude-mem-watchdog — LIGHT tick (~5 min). Cheap checks + auto-fixes + approval polling.
# Auto-fixes (no approval): restart dead worker, reap orphan procs, repair CLAUDE_CODE_PATH.
# Also polls the decisions/ dir and executes any owner-approved destructive actions.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
SCRIPT_NAME="watchdog-light"
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

# Dispatcher for owner-approved destructive actions (called by process_decisions).
dispatch_action() {
  local action="$1" params="$2"
  case "$action" in
    delete-file)
      local p; p="$(jq -r '.path // empty' <<<"$params")"
      # safety: canonicalize to block ".." traversal, then prefix-check
      local resolved resolved_base
      resolved=$(realpath -- "$p" 2>/dev/null) || { err "Cannot resolve path: $p"; return 1; }
      resolved_base=$(realpath -- "$CLAUDE_MEM_DIR" 2>/dev/null) || return 1
      case "$resolved" in
        "$resolved_base"/*) ;; # safe
        *) err "Path escapes $CLAUDE_MEM_DIR: $p"; return 1 ;;
      esac
      [ "$p" = "$CLAUDE_MEM_DB" ] || [ "$p" = "$CLAUDE_MEM_SETTINGS" ] && { err "refusing to delete live file: $p"; return 1; }
      [ -e "$p" ] && rm -rf "$p" && info "deleted $p" && return 0
      warn "approved delete-file but path gone: $p"; return 0 ;;
    *)
      err "unknown action: $action"; return 1 ;;
  esac
}

main() {
  info "light tick start"

  # 1) Worker health → restart (circuit-broken)
  if ! worker_healthy; then
    local fails; fails="$(cb_bump worker_restart)"
    if [ "$fails" -gt "$CIRCUIT_BREAKER_FAILS" ]; then
      warn "worker unhealthy and restart failed ${fails}× — escalating, not auto-retrying"
      request_create "claude-mem worker won't stay up (${fails} consecutive restart failures)" \
        "manual-investigation" >/dev/null
    else
      warn "worker unhealthy — restarting (attempt $fails)"
      worker_start; sleep "$WORKER_RESTART_SETTLE_SECS"
      if worker_healthy; then cb_reset worker_restart; incident fixed "restarted dead worker"; \
        else warn "restart attempt $fails did not bring worker healthy yet"; fi
    fi
  else
    cb_reset worker_restart
  fi

  # 2) Orphan mcp-server.cjs procs → reap
  local oc; oc="$(orphan_count)"
  if [ "${oc:-0}" -gt "$ORPHAN_PROC_MAX" ]; then
    warn "orphan mcp-server procs: $oc > $ORPHAN_PROC_MAX — reaping"
    reap_orphans; incident fixed "reaped orphan procs" "$(jq -cn --argjson n "$oc" '{count:$n}')"
  fi

  # 3) CLAUDE_CODE_PATH validity → repair (the root cause of the 2026-06 incident)
  local ccp; ccp="$(claude_code_path)"
  if [ -n "$ccp" ] && [ ! -x "$ccp" ]; then
    local good; if good="$(resolve_valid_claude)"; then
      warn "CLAUDE_CODE_PATH invalid ($ccp) — repointing to $good"
      if patch_claude_code_path "$good"; then
        incident fixed "repaired CLAUDE_CODE_PATH" "$(jq -cn --arg o "$ccp" --arg n "$good" '{old:$o, new:$n}')"
        worker_stop; sleep "$WORKER_RESTART_AFTER_PATCH_SECS"; worker_start
        notify "🔧 repaired CLAUDE_CODE_PATH: $ccp → $good (was the 2026-06 bloat trigger)" || true
      fi
    else
      request_create "CLAUDE_CODE_PATH invalid ($ccp) and no valid claude binary found" "manual-fix-claude-path" >/dev/null
    fi
  fi

  # 4) Poll owner decisions and execute approved destructive actions
  process_decisions dispatch_action

  info "light tick done"
}
main "$@"
