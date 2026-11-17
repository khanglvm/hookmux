#!/bin/sh
# hookmux launcher. Agent clients run this on every hook event, so it must
# never fail them: if Node or the engine is missing, or the engine exits
# abnormally, it prints nothing and exits 0, which every client treats as
# "no opinion". stderr is discarded because Gemini CLI parses stderr as output
# when stdout is empty. `hookmux init` fills in the two paths below.
NODE='@NODE@'
ENGINE='@ROOT@/engine/current/hook.mjs'
if [ ! -x "$NODE" ] || [ ! -f "$ENGINE" ]; then
  cat >/dev/null 2>&1
  exit 0
fi
HOOKMUX_HOME='@ROOT@' NODE_OPTIONS= NODE_NO_WARNINGS=1 "$NODE" "$ENGINE" "$@" 2>/dev/null
exit 0
