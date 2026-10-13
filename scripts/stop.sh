#!/usr/bin/env bash
# Stop what scripts/start.sh started (the app and Varnish), using the pid files in data/run.
set -euo pipefail

RUN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/data/run"
stopped=0

# stop NAME PATTERN: TERM the process in data/run/NAME.pid if its command line matches PATTERN
# (a stale pid file may name an unrelated process by now), then KILL it after 10 seconds.
stop() {
  local pidfile="$RUN/$1.pid" pid
  [[ -s "$pidfile" ]] || return 0
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q -- "$2"; then
    echo "[stop] stopping $1 (pid $pid)"
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 100); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "[stop] $1 did not exit, killing it"
      kill -KILL "$pid" 2>/dev/null || true
    fi
    stopped=1
  fi
  rm -f "$pidfile"
}

stop varnishd varnishd
stop node server.js
[[ $stopped == 1 ]] || echo "[stop] nothing was running"
