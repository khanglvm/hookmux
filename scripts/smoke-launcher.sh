#!/bin/sh
# Smoke test for the installed launcher. Builds a throwaway HOOKMUX_HOME the
# way `hookmux init` lays it out (engine/<version>, a `current` symlink and the
# launcher with the Node path and root filled in), then pipes host payloads
# through it. Every case must exit 0, and stdout must be empty or one JSON
# object, because that is all an agent client accepts from a hook. Fake
# engines cover a crash after partial output and a hang, and the launcher must
# leave no temp file behind. Each case runs under sh, and under dash too when
# it is installed.
#
# Usage: pnpm build && sh scripts/smoke-launcher.sh
# POSIX sh on purpose: Ubuntu's /bin/sh is dash.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
NODE_BIN=$(command -v node)
PROMPT_EVENT="--host claude-code --event prompt.submit"
FIRING_PROMPT="redesign the pricing page so it feels more premium"
# The launcher's watchdog sends TERM at 5 s and KILL one second later.
HANG_LIMIT_MS=8000
# A launcher with nothing to run must not wait for stdin to close.
NO_ENGINE_LIMIT_MS=2000
failures=0

fail() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}

# Prints a UserPromptSubmit payload for the given prompt. Each suite has its own
# session, because the example plugin fires once per session.
payload() {
  printf '{"session_id":"smoke-%s","transcript_path":"","cwd":"/tmp","hook_event_name":"UserPromptSubmit","prompt":"%s"}' "$SESSION" "$1"
}

now_ms() {
  "$NODE_BIN" -e 'process.stdout.write(String(Date.now()))'
}

# Lays out engine, launcher, one auto-trusted example plugin and its config.
setup_home() {
  version=$(cd "$REPO" && "$NODE_BIN" -p 'require("./package.json").version')
  mkdir -p "$HOME_DIR/engine/$version" "$HOME_DIR/bin" "$HOME_DIR/plugins" "$HOME_DIR/tmp"
  cp -R "$REPO/dist/." "$HOME_DIR/engine/$version/"
  ln -s "$version" "$HOME_DIR/engine/current"
  sed -e "s|@NODE@|$NODE_BIN|" -e "s|@ROOT@|$HOME_DIR|g" "$REPO/launcher/hookmux-hook.sh" >"$HOME_DIR/bin/hookmux-hook"
  chmod 755 "$HOME_DIR/bin/hookmux-hook"
  # auto_trust_declarative lets an inject-only plugin run without `promote`,
  # so the positive case proves the engine really ran.
  cp -R "$REPO/examples/moodboard" "$HOME_DIR/plugins/moodboard"
  chmod -R go-w "$HOME_DIR/plugins"
  printf '[settings]\nauto_trust_declarative = true\n' >"$HOME_DIR/config.toml"
}

# Points engine/current at a one-file fake engine with the given source.
fake_engine() {
  mkdir -p "$HOME_DIR/engine/$1"
  printf '%s\n' "$2" >"$HOME_DIR/engine/$1/hook.mjs"
  rm -f "$HOME_DIR/engine/current"
  ln -s "$1" "$HOME_DIR/engine/current"
}

# run_case SHELL LAUNCHER NAME EXPECT STDIN [LIMIT_MS]: EXPECT is "empty", "json" or "context".
run_case() {
  shell=$1
  launcher=$2
  name="$3 ($shell)"
  expect=$4
  limit=${6:-}
  before=$failures
  started=$(now_ms)
  set +e
  # $PROMPT_EVENT is unquoted on purpose: it holds four separate arguments.
  out=$(printf '%s' "$5" | "$shell" "$launcher" $PROMPT_EVENT)
  code=$?
  set -e
  check_result "$name" "$expect" "$code" "$out" "$started" "$limit"
  [ "$failures" -ne "$before" ] || echo "ok: $name"
}

check_result() {
  [ "$3" -eq 0 ] || fail "$1: exit $3"
  case $2 in
    empty) [ -z "$4" ] || fail "$1: expected empty stdout, got: $4" ;;
    json) [ -z "$4" ] || is_json "$4" || fail "$1: stdout is neither empty nor JSON: $4" ;;
    context) has_context "$4" || fail "$1: expected additionalContext, got: $4" ;;
  esac
  if [ -n "$6" ]; then
    took=$(($(now_ms) - $5))
    [ "$took" -le "$6" ] || fail "$1: took $took ms, limit $6 ms"
  fi
}

# The launcher must return while the client still holds stdin open.
run_open_stdin_case() {
  shell=$1
  name="engine missing, stdin left open ($shell)"
  before=$failures
  fifo="$HOME_DIR/stdin.fifo"
  rm -f "$fifo"
  mkfifo "$fifo"
  sleep 30 >"$fifo" &
  writer=$!
  started=$(now_ms)
  set +e
  out=$("$shell" "$HOME_DIR/bin/hookmux-hook" $PROMPT_EVENT <"$fifo")
  code=$?
  set -e
  kill "$writer" 2>/dev/null || true
  wait "$writer" 2>/dev/null || true
  check_result "$name" empty "$code" "$out" "$started" "$NO_ENGINE_LIMIT_MS"
  [ "$failures" -ne "$before" ] || echo "ok: $name"
}

# With stdin closed the launcher cannot keep a copy of it on fd 5 and gives up
# after mktemp; it must still exit 0 quietly and remove the temp file it made.
run_closed_stdin_case() {
  shell=$1
  name="stdin closed ($shell)"
  before=$failures
  started=$(now_ms)
  set +e
  out=$("$shell" "$HOME_DIR/bin/hookmux-hook" $PROMPT_EVENT <&-)
  code=$?
  set -e
  check_result "$name" empty "$code" "$out" "$started" ""
  leftover=$(cd "$TMPDIR" && find . -name 'hookmux-out.*')
  [ -z "$leftover" ] || fail "$name: temp file left behind: $leftover"
  [ "$failures" -ne "$before" ] || echo "ok: $name"
}

is_json() {
  printf '%s' "$1" | "$NODE_BIN" -e 'JSON.parse(require("fs").readFileSync(0, "utf8"))' 2>/dev/null
}

has_context() {
  printf '%s' "$1" | "$NODE_BIN" -e '
    const out = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (!/moodboard/.test(out.hookSpecificOutput?.additionalContext ?? "")) process.exit(1);
  ' 2>/dev/null
}

run_suite() {
  sh_bin=$1
  SESSION=$sh_bin
  launcher="$HOME_DIR/bin/hookmux-hook"
  ln -sfn "$version" "$HOME_DIR/engine/current"
  run_case "$sh_bin" "$launcher" "neutral prompt" json "$(payload "list the files in this folder")"
  run_case "$sh_bin" "$launcher" "firing prompt" context "$(payload "$FIRING_PROMPT")"
  run_case "$sh_bin" "$launcher" "stdin is not JSON" empty "not json"
  run_case "$sh_bin" "$launcher" "empty stdin" empty ""
  run_closed_stdin_case "$sh_bin"

  sed -e "s|^NODE=.*|NODE='$HOME_DIR/no-such-node'|" "$launcher" >"$HOME_DIR/bin/no-node-hook"
  run_case "$sh_bin" "$HOME_DIR/bin/no-node-hook" "node missing" empty "$(payload "$FIRING_PROMPT")"

  fake_engine partial 'process.stdout.write("{\"hookSpecificOutput\":"); process.exit(1);'
  run_case "$sh_bin" "$launcher" "engine prints partial JSON, then exits 1" empty "$(payload "$FIRING_PROMPT")"

  fake_engine hang 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'
  run_case "$sh_bin" "$launcher" "engine hangs and ignores TERM" empty "$(payload "$FIRING_PROMPT")" "$HANG_LIMIT_MS"

  rm -f "$HOME_DIR/engine/current"
  run_case "$sh_bin" "$launcher" "engine missing" empty "$(payload "$FIRING_PROMPT")"
  run_open_stdin_case "$sh_bin"
}

main() {
  [ -f "$REPO/dist/hook.mjs" ] || {
    echo "dist/hook.mjs is missing; run pnpm build first" >&2
    exit 1
  }
  HOME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/hookmux-smoke.XXXXXX")
  trap 'rm -rf "$HOME_DIR"' EXIT
  setup_home
  # A private TMPDIR shows whether the launcher leaves its temp files behind.
  TMPDIR="$HOME_DIR/tmp"
  export TMPDIR

  run_suite sh
  if command -v dash >/dev/null 2>&1; then run_suite dash; else echo "skip: dash is not installed"; fi

  leftover=$(ls -A "$HOME_DIR/tmp")
  [ -z "$leftover" ] || fail "temp files left behind: $leftover"
  if [ "$failures" -gt 0 ]; then
    echo "$failures smoke case(s) failed" >&2
    exit 1
  fi
  echo "launcher smoke test passed"
}

main "$@"
