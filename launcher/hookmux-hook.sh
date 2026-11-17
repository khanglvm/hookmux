#!/bin/sh
# hookmux launcher. Agent clients run this on every hook event, so it must
# never fail or stall them: whatever happens it exits 0, and it prints the
# engine's stdout only when the engine finished cleanly, which every client
# reads as "no opinion" when empty. A watchdog kills an engine that hangs (for
# example on a regex that backtracks), so the client always gets an answer.
# `hookmux init` fills in the two paths below. POSIX sh: Ubuntu's /bin/sh is dash.

# Gemini CLI parses stderr as output when stdout is empty, so nothing may reach it.
exec 2>/dev/null

NODE='@NODE@'
ENGINE='@ROOT@/engine/current/hook.mjs'
# Seconds before the watchdog stops the engine. It bounds a run that cannot
# reach its own deadline (2 s by default). deadline_ms may be set higher, up to
# 20 s, but a run past this limit still ends here with no output.
WATCHDOG_SEC=5

# Nothing to run: return at once and leave stdin unread, so a client that keeps
# the pipe open is not held up.
if [ ! -x "$NODE" ] || [ ! -f "$ENGINE" ]; then
  exit 0
fi

# The engine writes to a private temp file, so a half-written answer from an
# engine that crashes or is killed never reaches the client. Both ends are
# opened here and the name is removed while the engine starts, so nothing is
# left in TMPDIR even if this script is killed; fd 3 reads the answer back.
# fd 5 keeps the client's stdin for the engine (see below). `command` keeps a
# failed redirection from ending the shell with status 2, which Claude Code
# would read as a block; the temp file is removed before leaving. The fd 5 copy
# fails when the client started the hook with stdin closed.
out=$(mktemp "${TMPDIR:-/tmp}/hookmux-out.XXXXXX") || exit 0
command exec 3<"$out" 4>"$out" 5<&0 || {
  rm -f "$out"
  exit 0
}

# NODE_OPTIONS could load code into the engine, and NODE_USE_ENV_PROXY would
# send a local model provider's traffic (the prompt) through an HTTP proxy.
unset NODE_OPTIONS NODE_USE_ENV_PROXY

# A background job's stdin is /dev/null before its own redirections apply
# (POSIX, and what dash does), so `<&0` would only copy /dev/null; the
# client's stdin comes from the copy saved on fd 5 instead.
HOOKMUX_HOME='@ROOT@' NODE_NO_WARNINGS=1 "$NODE" "$ENGINE" "$@" <&5 >&4 3<&- 4>&- 5<&- &
pid=$!
exec 4>&- 5<&-
rm -f "$out"

# The watchdog's own fds point at /dev/null, so it never holds the client's
# stdout pipe open after this script exits. TERM first lets a responsive engine
# kill the scripts it started; KILL follows for one that is stuck. When the
# engine finishes first, the watchdog is stopped together with its sleep, so
# no process is left behind after a normal run.
(
  exec 3<&-
  nap=
  trap 'kill "$nap"; exit 0' TERM
  sleep "$WATCHDOG_SEC" &
  nap=$!
  wait "$nap"
  kill -TERM "$pid"
  sleep 1
  kill -KILL "$pid"
) </dev/null >/dev/null 2>&1 &
watchdog=$!

stop_watchdog() {
  kill -TERM "$watchdog"
}

# A client that gives up on the hook signals this script; pass it on so the
# engine stops its scripts, then leave quietly.
trap 'kill -TERM "$pid"; wait "$pid"; stop_watchdog; exit 0' TERM HUP INT

wait "$pid"
code=$?
stop_watchdog
if [ "$code" -eq 0 ]; then
  cat <&3
fi
exit 0
