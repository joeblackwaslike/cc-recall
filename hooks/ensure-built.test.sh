#!/usr/bin/env bash
# Regression test for hooks/ensure-built.sh's rebuild decision.
#
# Root cause of Incident B (2026-08): ensure-built.sh only checked "does dist/bin/cc-recall.js
# exist" -- once built, it never rebuilt again, so a source fix merged to main (c0713ca/f0190fd)
# never actually reached the running plugin. This test proves the script rebuilds when the
# build-relevant inputs change, not just when dist/ is missing.
#
# Usage: bash hooks/ensure-built.test.sh
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ensure-built.sh"
FAIL=0

fail() {
  echo "FAIL: $1"
  FAIL=1
}

pass() {
  echo "PASS: $1"
}

setup_fake_plugin_dir() {
  local dir
  dir="$(mktemp -d)"
  mkdir -p "$dir/src" "$dir/dist/bin" "$dir/bin"
  echo '{"name":"cc-recall","version":"0.1.0"}' > "$dir/package.json"
  echo "lockfile: v1" > "$dir/pnpm-lock.yaml"
  echo "export const x = 1;" > "$dir/src/a.ts"
  echo "$dir"
}

# Fake `pnpm` on PATH: records every invocation to $PNPM_CALL_LOG and, on `build`,
# writes a new dist/bin/cc-recall.js so a real rebuild is observable.
setup_fake_pnpm() {
  local dir="$1"
  local bindir="$dir/.fakebin"
  mkdir -p "$bindir"
  cat > "$bindir/pnpm" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$PNPM_CALL_LOG"
if [[ "$1" == "build" ]]; then
  echo "// built $(date +%s%N)" > "$PLUGIN_DIR/dist/bin/cc-recall.js"
fi
exit 0
EOF
  chmod +x "$bindir/pnpm"
  echo "$bindir"
}

run_script() {
  local dir="$1"
  CLAUDE_PLUGIN_ROOT="$dir" PATH="$FAKE_BIN:$PATH" PNPM_CALL_LOG="$CALL_LOG" PLUGIN_DIR="$dir" \
    bash "$SCRIPT" >/dev/null
}

build_count() {
  grep -c '^build' "$CALL_LOG" 2>/dev/null || echo 0
}

# --- Test 1: first run with no dist/ builds once ---
DIR="$(setup_fake_plugin_dir)"
FAKE_BIN="$(setup_fake_pnpm "$DIR")"
CALL_LOG="$DIR/pnpm-calls.log"
touch "$CALL_LOG"
rm -f "$DIR/dist/bin/cc-recall.js"

run_script "$DIR"
if [[ "$(build_count)" == "1" ]]; then
  pass "first run builds once when dist/ is missing"
else
  fail "first run: expected 1 build call, got $(build_count)"
fi

# --- Test 2: second run, unchanged source, does NOT rebuild ---
run_script "$DIR"
if [[ "$(build_count)" == "1" ]]; then
  pass "second run with unchanged source skips rebuild"
else
  fail "second run: expected build count to stay at 1, got $(build_count)"
fi

# --- Test 3: source changes after a successful build -- MUST rebuild ---
# This is the exact failure mode from Incident B: a fix lands in src/ (e.g. c0713ca) but the
# already-built dist/ silently keeps running the pre-fix code forever.
echo "export const x = 2; // changed" > "$DIR/src/a.ts"
run_script "$DIR"
if [[ "$(build_count)" == "2" ]]; then
  pass "run after source change triggers a rebuild"
else
  fail "run after source change: expected 2 build calls total, got $(build_count) -- a source fix would silently never deploy"
fi

rm -rf "$DIR"

if [[ "$FAIL" == "1" ]]; then
  echo "--- ensure-built.test.sh: FAILED ---"
  exit 1
fi
echo "--- ensure-built.test.sh: all tests passed ---"
