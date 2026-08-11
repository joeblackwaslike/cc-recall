#!/usr/bin/env bash
# cc-recall-watchdog — LIGHT tick (~5 min). Independent observation, notify-only escalation.
#
# Does NOT trust cc-recall's own in-process spawn-rate ceiling (src/metrics/spawn-ceiling.ts) to
# always be running — that gate shipping to GitHub but never reaching the deployed plugin cache
# is exactly how Incident B stayed live for six weeks. This watchdog reads the same on-disk
# signals independently and escalates if they look wrong regardless of what the app-side gate
# thinks it's doing.
#
# Checks: enrichment session-spawn rate (adoption.jsonl), sidecar (index.db) growth since the
# last tick. No auto-fix exists for either — a real spike needs a human look, so both escalate
# straight to a notify-only request after CIRCUIT_BREAKER_FAILS consecutive elevated ticks.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
SCRIPT_NAME="watchdog-light"
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

# Count `enrichment_spawn` events in adoption.jsonl within the trailing SPAWN_RATE_WINDOW_SECS.
spawn_rate_count() {
  [ -f "$CC_RECALL_ADOPTION_FILE" ] || { echo 0; return; }
  local since; since="$(date -u -v-"${SPAWN_RATE_WINDOW_SECS}"S +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "-${SPAWN_RATE_WINDOW_SECS} seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"
  [ -n "${since:-}" ] || { echo 0; return; }
  "$JQ" -cs --arg since "$since" \
    '[.[] | select(.kind=="enrichment_spawn" and .ts >= $since)] | length' \
    "$CC_RECALL_ADOPTION_FILE" 2>/dev/null || echo 0
}

sidecar_size_mb() {
  [ -f "$CC_RECALL_SIDECAR_DB" ] || { echo 0; return; }
  local bytes; bytes="$(stat -f%z "$CC_RECALL_SIDECAR_DB" 2>/dev/null || stat -c%s "$CC_RECALL_SIDECAR_DB" 2>/dev/null || echo 0)"
  echo $(( bytes / 1048576 ))
}

check_spawn_rate() {
  local count; count="$(spawn_rate_count)"
  if ! [[ "${count:-}" =~ ^[0-9]+$ ]]; then warn "spawn-rate check: could not read $CC_RECALL_ADOPTION_FILE"; return; fi

  if [ "$count" -gt "$SPAWN_RATE_ALERT_MAX" ]; then
    local fails; fails="$(cb_bump spawn_rate)"
    warn "enrichment spawn rate elevated: ${count} in ${SPAWN_RATE_WINDOW_SECS}s (> ${SPAWN_RATE_ALERT_MAX}) — tick ${fails}/${CIRCUIT_BREAKER_FAILS}"
    if [ "$fails" -ge "$CIRCUIT_BREAKER_FAILS" ]; then
      request_create "enrichment spawn rate ${count}/${SPAWN_RATE_WINDOW_SECS}s exceeds ${SPAWN_RATE_ALERT_MAX} for ${fails} consecutive ticks — the in-process spawn-rate ceiling may be missing, stale, or bypassed" \
        "manual-investigation" "$("$JQ" -cn --argjson c "$count" --argjson m "$SPAWN_RATE_ALERT_MAX" '{count:$c, max:$m}')" >/dev/null
      cb_reset spawn_rate
    fi
  else
    cb_reset spawn_rate
  fi
}

check_sidecar_growth() {
  local current previous delta
  current="$(sidecar_size_mb)"
  previous="$(state_get sidecar_size_mb)"
  state_set sidecar_size_mb "$current"
  [[ "${previous:-}" =~ ^[0-9]+$ ]] || return # first tick since install/reboot: no baseline yet

  delta=$(( current - previous ))
  if [ "$delta" -gt "$SIDECAR_GROWTH_ALERT_MB" ]; then
    local fails; fails="$(cb_bump sidecar_growth)"
    warn "sidecar grew ${delta}MB this tick (${previous}MB -> ${current}MB, > ${SIDECAR_GROWTH_ALERT_MB}MB) — tick ${fails}/${CIRCUIT_BREAKER_FAILS}"
    if [ "$fails" -ge "$CIRCUIT_BREAKER_FAILS" ]; then
      request_create "sidecar grew ${delta}MB/tick for ${fails} consecutive ticks (now ${current}MB) — check for a runaway indexing loop" \
        "manual-investigation" "$("$JQ" -cn --argjson d "$delta" --argjson c "$current" '{delta_mb:$d, current_mb:$c}')" >/dev/null
      cb_reset sidecar_growth
    fi
  else
    cb_reset sidecar_growth
  fi
}

main() {
  info "light tick start"
  check_spawn_rate
  check_sidecar_growth
  info "light tick done"
}
main "$@"
