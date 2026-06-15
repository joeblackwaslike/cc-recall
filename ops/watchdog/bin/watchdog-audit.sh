#!/usr/bin/env bash
# claude-mem-watchdog — AUDIT tick (~6 h). Heavy checks: DB bloat, queue, disk.
# Auto-fixes (no approval): VACUUM when bloated + safe, prune failed/stale pending rows.
# Escalates (Telegram approval): deleting large bloat backups, critically low disk,
# DB still huge after VACUUM (would need destructive observation pruning).

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
SCRIPT_NAME="watchdog-audit"
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

disk_free_mb() {
  local val
  val=$(df -m "$CLAUDE_MEM_DIR" 2>/dev/null | awk 'NR==2{print $4}')
  if ! [[ "$val" =~ ^[0-9]+$ ]]; then
    echo "WARN: cannot determine disk free space" >&2
    echo 999999
    return
  fi
  echo "$val"
}

prune_pending() {
  local cutoff_ms changed
  cutoff_ms=$(( ( $(date +%s) - PENDING_STALE_HOURS*3600 ) * 1000 ))
  changed="$("$SQLITE3" "$CLAUDE_MEM_DB" \
    "DELETE FROM pending_messages WHERE status='failed' OR (status='pending' AND created_at_epoch < $cutoff_ms); SELECT changes();" 2>/dev/null | tail -1)"
  [ -n "${changed:-}" ] && [ "$changed" -gt 0 ] 2>/dev/null && incident fixed "pruned stale/failed pending rows" "$(jq -cn --argjson n "$changed" '{rows:$n}')"
}

vacuum_db() {
  worker_stop; sleep 2
  if "$SQLITE3" "$CLAUDE_MEM_DB" "PRAGMA wal_checkpoint(TRUNCATE); VACUUM;" >>"$LOG_FILE" 2>&1; then
    incident fixed "vacuumed bloated DB"
  else
    err "VACUUM failed"; cb_bump vacuum >/dev/null
  fi
  worker_start
}

main() {
  info "audit tick start"
  [ -f "$CLAUDE_MEM_DB" ] || { warn "no DB at $CLAUDE_MEM_DB"; exit 0; }

  local size_mb ratio free_mb
  size_mb="$(db_size_mb)"; ratio="$(db_freelist_ratio)"; free_mb="$(disk_free_mb)"
  incident audit "db=${size_mb}MB freelist=${ratio} disk_free=${free_mb}MB" \
    "$(jq -cn --argjson s "${size_mb:-0}" --arg r "${ratio:-0}" --argjson d "${free_mb:-0}" '{db_mb:$s, freelist:$r, disk_free_mb:$d}')"

  # 1) Queue hygiene (always safe)
  prune_pending

  # 2) Auto-VACUUM when bloated AND large AND ample disk headroom
  local over_ratio over_size headroom_ok
  over_ratio="$(awk -v r="$ratio" -v m="$FREELIST_RATIO_MAX" 'BEGIN{print (r>=m)?1:0}')"
  over_size=$(( size_mb >= DB_SIZE_VACUUM_MIN_MB ? 1 : 0 ))
  headroom_ok=$(( free_mb > DISK_HEADROOM_FACTOR * size_mb ? 1 : 0 ))
  if [ "$over_ratio" = 1 ] && [ "$over_size" = 1 ]; then
    if [ "$headroom_ok" = 1 ]; then
      warn "DB bloated (${size_mb}MB, freelist ${ratio}) — auto-VACUUM"
      vacuum_db
    else
      warn "DB bloated but insufficient disk headroom for safe VACUUM — escalating"
      request_create "DB bloated (${size_mb}MB, freelist ${ratio}) but only ${free_mb}MB free — unsafe to VACUUM" \
        "free-disk-then-vacuum" >/dev/null
    fi
  fi

  # 3) Escalate: large bloat-backup files (destructive delete needs approval)
  local f sz
  for f in "$CLAUDE_MEM_DIR"/claude-mem.db.bloated-* "$CLAUDE_MEM_DIR"/backups/*; do
    [ -e "$f" ] || continue
    sz=$(( $(stat -f%z "$f" 2>/dev/null || echo 0) / 1048576 ))
    [ "$sz" -ge "$DB_SIZE_VACUUM_MIN_MB" ] || continue
    # only escalate once per path (skip if an awaiting/handled request already references it)
    if ! grep -ql "$f" "$STATE_DIR"/pending/*.json 2>/dev/null; then
      request_create "stale bloat backup using ${sz}MB: $(basename "$f")" "delete-file" \
        "$(jq -cn --arg p "$f" '{path:$p}')" >/dev/null
    fi
  done

  # 4) Escalate: critically low disk
  if [ -n "${free_mb:-}" ] && [ "$free_mb" -lt $(( DISK_FREE_MIN_GB * 1024 )) ]; then
    if ! grep -ql '"action":"free-disk"' "$STATE_DIR"/pending/*.json 2>/dev/null; then
      request_create "low disk: ${free_mb}MB free (< ${DISK_FREE_MIN_GB}GB)" "free-disk" >/dev/null
    fi
  fi

  # 5) Escalate: DB still huge after vacuum (would need destructive observation pruning)
  size_mb="$(db_size_mb)"
  if [ "${size_mb:-0}" -ge "$DB_SIZE_ALERT_MB" ]; then
    if ! grep -ql '"action":"prune-observations"' "$STATE_DIR"/pending/*.json 2>/dev/null; then
      request_create "DB still ${size_mb}MB after maintenance — may need observation pruning (destructive)" \
        "prune-observations" >/dev/null
    fi
  fi

  info "audit tick done"
}
main "$@"
