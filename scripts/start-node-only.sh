#!/usr/bin/env bash
# Start only the Node.js app, on all interfaces port 8080 (no Varnish cache in front).
# Takes the same settings as scripts/start.sh; stop it with Ctrl+C or scripts/stop.sh.
set -euo pipefail
NO_VARNISH=1 exec "$(dirname "${BASH_SOURCE[0]}")/start.sh" "$@"
