#!/bin/sh
# Smoke test for the installed launcher. Builds a throwaway HOOKMUX_HOME the
# way `hookmux init` lays it out (engine/<version>, a `current` symlink and the
# launcher with the Node path and root filled in), then pipes host payloads
# through it. Every case must exit 0, and stdout must be empty or one JSON
# object, because that is all an agent client accepts from a hook.
#
# Usage: pnpm build && sh scripts/smoke-launcher.sh
# POSIX sh on purpose: Ubuntu's /bin/sh is dash.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
NODE_BIN=$(command -v node)
PROMPT_EVENT="--host claude-code --event prompt.submit"
FIRING_PROMPT="redesign the pricing page so it feels more premium"
failures=0

fail() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}

# Prints a UserPromptSubmit payload for the given prompt.
payload() {
  printf '{"session_id":"smoke","transcript_path":"","cwd":"/tmp","hook_event_name":"UserPromptSubmit","prompt":"%s"}' "$1"
}

# Lays out engine, launcher, one auto-trusted example plugin and its config.
setup_home() {
  version=$(cd "$REPO" && "$NODE_BIN" -p 'require("./package.json").version')
  mkdir -p "$HOME_DIR/engine/$version" "$HOME_DIR/bin" "$HOME_DIR/plugins"
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

# run_case LAUNCHER NAME EXPECT STDIN: EXPECT is "empty", "json" or "context".
run_case() {
  launcher=$1
  name=$2
  expect=$3
  before=$failures
  set +e
  # $PROMPT_EVENT is unquoted on purpose: it holds four separate arguments.
  out=$(printf '%s' "$4" | "$launcher" $PROMPT_EVENT)
  code=$?
  set -e
  [ "$code" -eq 0 ] || fail "$name: exit $code"
  case $expect in
    empty) [ -z "$out" ] || fail "$name: expected empty stdout, got: $out" ;;
    json) [ -z "$out" ] || is_json "$out" || fail "$name: stdout is neither empty nor JSON: $out" ;;
    context) has_context "$out" || fail "$name: expected additionalContext, got: $out" ;;
  esac
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

main() {
  [ -f "$REPO/dist/hook.mjs" ] || {
    echo "dist/hook.mjs is missing; run pnpm build first" >&2
    exit 1
  }
  HOME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/hookmux-smoke.XXXXXX")
  trap 'rm -rf "$HOME_DIR"' EXIT
  setup_home

  launcher="$HOME_DIR/bin/hookmux-hook"
  run_case "$launcher" "neutral prompt" json "$(payload "list the files in this folder")"
  run_case "$launcher" "firing prompt" context "$(payload "$FIRING_PROMPT")"
  run_case "$launcher" "stdin is not JSON" empty "not json"
  run_case "$launcher" "empty stdin" empty ""

  sed -e "s|^NODE=.*|NODE='$HOME_DIR/no-such-node'|" "$launcher" >"$HOME_DIR/bin/no-node-hook"
  chmod 755 "$HOME_DIR/bin/no-node-hook"
  run_case "$HOME_DIR/bin/no-node-hook" "node missing" empty "$(payload "$FIRING_PROMPT")"

  rm "$HOME_DIR/engine/current"
  run_case "$launcher" "engine missing" empty "$(payload "$FIRING_PROMPT")"

  if [ "$failures" -gt 0 ]; then
    echo "$failures smoke case(s) failed" >&2
    exit 1
  fi
  echo "launcher smoke test passed"
}

main "$@"
