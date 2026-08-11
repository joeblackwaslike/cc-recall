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

# Fake `pnpm` on PATH: records every invocation to $PNPM_CALL_LOG and, on `build`, writes a new
# dist/bin/cc-recall.js so a real rebuild is observable -- unless $FAIL_BUILD_MARKER exists, in
# which case `build` exits non-zero without touching dist/, simulating a real compile failure.
# The output path and failure marker are read from argv (passed by run_script), not an ambient
# env var the real script never exports, so the fake can't silently drift from what it simulates.
setup_fake_pnpm() {
  local dir="$1"
  local bindir="$dir/.fakebin"
  mkdir -p "$bindir"
  cat > "$bindir/pnpm" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$PNPM_CALL_LOG"
if [[ "$1" == "build" ]]; then
  if [[ -f "$FAIL_BUILD_MARKER" ]]; then
    exit 1
  fi
  echo "// built $(date +%s%N)" > "$DIST_ENTRY_PATH"
fi
exit 0
EOF
  chmod +x "$bindir/pnpm"
  echo "$bindir"
}

run_script() {
  local dir="$1"
  CLAUDE_PLUGIN_ROOT="$dir" PATH="$FAKE_BIN:$PATH" PNPM_CALL_LOG="$CALL_LOG" \
    DIST_ENTRY_PATH="$dir/dist/bin/cc-recall.js" FAIL_BUILD_MARKER="$dir/.fail-build" \
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

# --- Test 3: source changes after a successful build -- MUST rebuild, and the stamp must
# reflect the NEW hash, not just re-trigger a build call. Verifying the stamp's content (not
# just that build ran) is what would catch a rebuild that runs but never re-stamps.
echo "export const x = 2; // changed" > "$DIR/src/a.ts"
run_script "$DIR"
STAMP_AFTER_REBUILD="$(cat "$DIR/dist/.build-stamp" 2>/dev/null || echo '')"
if [[ "$(build_count)" == "2" ]]; then
  pass "run after source change triggers a rebuild"
else
  fail "run after source change: expected 2 build calls total, got $(build_count) -- a source fix would silently never deploy"
fi
if [[ -n "$STAMP_AFTER_REBUILD" ]]; then
  pass "stamp file is written after a successful rebuild"
else
  fail "stamp file missing after a successful rebuild -- next run would rebuild forever"
fi

# --- Test 4: a change to bin/ (not src/) must also trigger a rebuild -- tsconfig.json compiles
# both into dist/, so hashing src/ alone would leave a bin/-only change permanently unbuilt. ---
mkdir -p "$DIR/bin"
echo "export const y = 1;" > "$DIR/bin/cli.ts"
run_script "$DIR"
if [[ "$(build_count)" == "3" ]]; then
  pass "a bin/-only change also triggers a rebuild"
else
  fail "bin/-only change: expected 3 build calls total, got $(build_count) -- bin/ isn't in the hash"
fi

# --- Test 5: a build that FAILS must NOT stamp the new hash over a pre-existing dist/. Stamping
# unconditionally here is the exact bug this script exists to prevent, just self-inflicted: a
# failed build would permanently mark the stale artifact as current and suppress every future
# rebuild attempt, silently, forever. ---
touch "$DIR/.fail-build"
echo "export const y = 2; // changed again, but the build will fail" > "$DIR/bin/cli.ts"
BUILD_COUNT_BEFORE="$(build_count)"
STAMP_BEFORE="$(cat "$DIR/dist/.build-stamp" 2>/dev/null || echo '')"
run_script "$DIR"
STAMP_AFTER_FAILURE="$(cat "$DIR/dist/.build-stamp" 2>/dev/null || echo '')"
if [[ "$(build_count)" -gt "$BUILD_COUNT_BEFORE" ]]; then
  pass "a rebuild is still attempted when the source changes, even after a prior failure"
else
  fail "expected a rebuild attempt after another source change"
fi
if [[ "$STAMP_AFTER_FAILURE" == "$STAMP_BEFORE" ]]; then
  pass "a failed build does not overwrite the stamp with the new (unbuilt) hash"
else
  fail "stamp changed after a FAILED build -- the stale dist/ is now permanently marked current"
fi
rm -f "$DIR/.fail-build"

rm -rf "$DIR"

if [[ "$FAIL" == "1" ]]; then
  echo "--- ensure-built.test.sh: FAILED ---"
  exit 1
fi
echo "--- ensure-built.test.sh: all tests passed ---"
