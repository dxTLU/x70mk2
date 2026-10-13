#!/usr/bin/env bash
# Start the proxy: the Node.js app on 127.0.0.1:8080 with Varnish in front of it on port 6081.
# Without varnishd (or with NO_VARNISH=1, or TLS_CERT/TLS_KEY set) the app alone serves port 8080
# on all interfaces. Ctrl+C (or scripts/stop.sh) stops everything.
#
#   scripts/start.sh
#   VARNISH_PORT=80 sudo -E scripts/start.sh
#   BASIC_AUTH=me:secret scripts/start.sh
#
# Settings: every variable in src/config.js (see README.md), plus
#   VARNISH_PORT     public Varnish port                 (default 6081)
#   VARNISH_LISTEN   address Varnish listens on          (default: all interfaces)
#   VARNISH_SIZE     cache memory                        (default 256m)
#   VARNISH_WORKDIR  varnishd -n directory               (default /var/lib/varnish/x70mk2-proxy
#                                                         as root, otherwise data/varnish)
#   VARNISH_PROXY_PORT  also accept the PROXY protocol on 127.0.0.1:<port>, for a local TLS
#                    terminator such as hitch or HAProxy (default: off)
#   NO_VARNISH=1     run the app alone
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$ROOT/data/run"
NODE_FLAGS=(--max-http-header-size=65536) # proxied URLs embed whole target URLs

log() { printf '[start] %s\n' "$*"; }
die() { printf '[start] error: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js 18 or newer is required (https://nodejs.org/)."
node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' \
  || die "Node.js 18 or newer is required, found $(node --version)."

mkdir -p "$RUN"
for name in node varnishd; do
  pidfile="$RUN/$name.pid"
  if [[ -s "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    die "already running ($name pid $(cat "$pidfile")); stop it with scripts/stop.sh"
  fi
  rm -f "$pidfile"
done

USE_VARNISH=1
VARNISHD="$(command -v varnishd || true)"
[[ -z "$VARNISHD" && -x /usr/sbin/varnishd ]] && VARNISHD=/usr/sbin/varnishd
if [[ "${NO_VARNISH:-0}" =~ ^(1|true|yes|on)$ ]]; then
  USE_VARNISH=0
elif [[ -n "${TLS_CERT:-}" && -n "${TLS_KEY:-}" ]]; then
  log "TLS_CERT/TLS_KEY set: the app serves HTTPS itself (Varnish cannot terminate TLS)."
  USE_VARNISH=0
elif [[ -z "$VARNISHD" ]]; then
  log "varnishd not found: running the app alone (install the varnish package to add the cache)."
  USE_VARNISH=0
fi

export PORT="${PORT:-8080}"
if [[ $USE_VARNISH == 1 ]]; then
  # Only Varnish is reachable from outside; the app listens on loopback behind it.
  export HOST=127.0.0.1
  VARNISH_PORT="${VARNISH_PORT:-6081}"
  [[ "$VARNISH_PORT" != "$PORT" ]] || die "VARNISH_PORT and PORT are both $PORT"
  PUBLIC_PORT="$VARNISH_PORT"
else
  export HOST="${HOST:-0.0.0.0}"
  PUBLIC_PORT="$PORT"
fi

NODE_PID=""
VARNISH_PID=""
cleanup() {
  trap - INT TERM EXIT
  if [[ -n "$VARNISH_PID" ]]; then kill -TERM "$VARNISH_PID" 2>/dev/null || true; fi
  if [[ -n "$NODE_PID" ]]; then kill -TERM "$NODE_PID" 2>/dev/null || true; fi
  wait 2>/dev/null || true
  if [[ -n "$NODE_PID" ]]; then rm -f "$RUN/node.pid"; fi
  if [[ -n "$VARNISH_PID" ]]; then rm -f "$RUN/varnishd.pid"; fi
}
trap 'log "stopping"; cleanup; exit 0' INT TERM
trap cleanup EXIT

# wait_http PORT PATH SECONDS PID: until http://127.0.0.1:PORT/PATH answers 200, or PID exits.
wait_http() {
  node -e '
    const [port, path, secs, pid] = process.argv.slice(1);
    const deadline = Date.now() + secs * 1000;
    const alive = () => { try { process.kill(+pid, 0); return true; } catch { return false; } };
    function attempt() {
      require("http").get({ host: "127.0.0.1", port, path, timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) process.exit(0);
        retry();
      }).on("error", retry).on("timeout", function () { this.destroy(); });
    }
    function retry() {
      if (!alive()) process.exit(2);
      if (Date.now() > deadline) process.exit(1);
      setTimeout(attempt, 200);
    }
    attempt();
  ' "$1" "$2" "$3" "$4"
}

cd "$ROOT"
log "starting the app on $HOST:$PORT"
node "${NODE_FLAGS[@]}" server.js &
NODE_PID=$!
echo "$NODE_PID" > "$RUN/node.pid"
wait_http "$PORT" /__proxy/health 30 "$NODE_PID" || die "the app did not start (see the output above)"

if [[ $USE_VARNISH == 1 ]]; then
  # The VCL points at 127.0.0.1:8080; use a copy pointing at $PORT.
  if [[ $(id -u) == 0 ]]; then
    WORKDIR="${VARNISH_WORKDIR:-/var/lib/varnish/x70mk2-proxy}"
    # Varnish drops root and compiles the VCL as its own user, which must be able to read it.
    JAIL=(-j none)
    for user in vcache varnish; do
      if id "$user" >/dev/null 2>&1; then JAIL=(-j "unix,user=$user"); break; fi
    done
  else
    WORKDIR="${VARNISH_WORKDIR:-$ROOT/data/varnish}"
    JAIL=(-j none)
  fi
  mkdir -p "$(dirname "$WORKDIR")"
  VCL="$WORKDIR.vcl"
  sed "s/\\.port = \"8080\";/.port = \"$PORT\";/" "$ROOT/varnish/default.vcl" > "$VCL"
  chmod 644 "$VCL"

  PARAMS=()
  while IFS= read -r line; do
    line="${line%%#*}"
    line="${line//[[:space:]]/}"
    [[ -n "$line" ]] && PARAMS+=(-p "$line")
  done < "$ROOT/varnish/varnishd.params"

  LISTEN=(-a "${VARNISH_LISTEN:-}:$VARNISH_PORT")
  [[ -n "${VARNISH_PROXY_PORT:-}" ]] && LISTEN+=(-a "proxy=127.0.0.1:$VARNISH_PROXY_PORT,PROXY")

  log "starting Varnish on ${VARNISH_LISTEN:-*}:$VARNISH_PORT (cache ${VARNISH_SIZE:-256m}, workdir $WORKDIR)"
  "$VARNISHD" -F "${JAIL[@]}" -n "$WORKDIR" -P "$RUN/varnishd.pid" \
    "${LISTEN[@]}" -T 127.0.0.1:0 \
    -f "$VCL" -s "malloc,${VARNISH_SIZE:-256m}" "${PARAMS[@]}" &
  VARNISH_PID=$!
  wait_http "$VARNISH_PORT" /__proxy/health 60 "$VARNISH_PID" \
    || die "Varnish did not start (see the output above; is port $VARNISH_PORT free?)"
fi

SCHEME=http
[[ $USE_VARNISH == 0 && -n "${TLS_CERT:-}" && -n "${TLS_KEY:-}" ]] && SCHEME=https
echo
log "ready:"
node "$ROOT/scripts/urls.js" "$SCHEME" "$PUBLIC_PORT"
[[ -n "${BASIC_AUTH:-}" ]] || log "tip: set BASIC_AUTH=user:password before exposing this to a network."
echo

# Run until either process exits or we are told to stop.
set +e
wait -n
STATUS=$?
log "a process exited (status $STATUS); shutting down"
exit "$STATUS"
