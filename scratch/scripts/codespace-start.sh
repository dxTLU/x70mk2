#!/usr/bin/env bash
# Bring the x70 Scratch pipeline up in a Codespace with no manual steps:
#   - install dependencies (first run only)
#   - run setup (folders, token, starter project)
#   - start a local Redis if one is installed (optional; falls back to in-memory otherwise)
#   - start the bridge daemon in the background on port 7070
# Safe to run more than once.
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_FLAGS="--disable-warning=ExperimentalWarning"

if [ ! -d node_modules/@turbowarp ]; then
  echo "[x70] installing dependencies ..."
  npm install --no-audit --no-fund
fi

node $NODE_FLAGS tools/setup.js || true

# Optional Redis for shared/persistent fast cache. The bridge works without it.
if command -v redis-server >/dev/null 2>&1; then
  if ! redis-cli ping >/dev/null 2>&1; then
    echo "[x70] starting local Redis ..."
    redis-server --port 6379 --daemonize yes --save '' --appendonly no --maxmemory 256mb --maxmemory-policy allkeys-lru >/dev/null 2>&1 || true
    sleep 0.3
  fi
  if redis-cli ping >/dev/null 2>&1; then export X70_REDIS_URL="${X70_REDIS_URL:-redis://127.0.0.1:6379/0}"; fi
fi

# Already running?
if curl -sf "http://127.0.0.1:7070/health" >/dev/null 2>&1; then
  echo "[x70] bridge already running on port 7070"
else
  echo "[x70] starting bridge daemon on port 7070 ..."
  mkdir -p data
  nohup node $NODE_FLAGS bridge/server.js >data/bridge.log 2>&1 &
  for i in $(seq 1 20); do
    curl -sf "http://127.0.0.1:7070/health" >/dev/null 2>&1 && break
    sleep 0.25
  done
fi

TOKEN="$(cat data/bridge.token 2>/dev/null || echo '<run: npm run setup>')"
echo
echo "========================================================================"
echo " x70 Scratch pipeline is up."
echo "   Bridge health : http://127.0.0.1:7070/health"
echo "   Bridge token  : $TOKEN"
if [ -n "${CODESPACE_NAME:-}" ] && [ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
  echo "   Public URL    : https://${CODESPACE_NAME}-7070.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
  echo "   -> In the PORTS tab, set port 7070 visibility to Public, then load the"
  echo "      extension in TurboWarp from  <Public URL>/extension.js"
fi
echo "   Build a game  : npm run build      (output in scratch/dist/*.html)"
echo "   Auto-rebuild  : npm run watch"
echo "========================================================================"
