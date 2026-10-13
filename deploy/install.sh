#!/usr/bin/env bash
# Install the proxy as systemd services on a Linux VM: the app in /opt/x70mk2 on 127.0.0.1:8080
# and, when Varnish is installed, Varnish on port 6081 in front of it. Re-run to update.
#
#   sudo deploy/install.sh
#   sudo PREFIX=/srv/x70mk2 deploy/install.sh      # another location (edit the units to match)
#
# Install the prerequisites first, e.g. on Debian/Ubuntu:
#   sudo apt install nodejs varnish        # Node.js 18 or newer (NodeSource has current releases)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${PREFIX:-/opt/x70mk2}"
ENV_FILE=/etc/default/x70mk2-proxy

say() { printf '[install] %s\n' "$*"; }
die() { printf '[install] error: %s\n' "$*" >&2; exit 1; }

[[ $(id -u) == 0 ]] || die "run as root (sudo $0)"
command -v systemctl >/dev/null 2>&1 || die "systemd is required; use scripts/start.sh instead"
NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || die "Node.js 18 or newer is required (https://nodejs.org/ or NodeSource packages)"
"$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' \
  || die "Node.js 18 or newer is required, found $("$NODE" --version)"
VARNISHD="$(command -v varnishd || true)"
[[ -z "$VARNISHD" && -x /usr/sbin/varnishd ]] && VARNISHD=/usr/sbin/varnishd

say "copying the app to $PREFIX"
mkdir -p "$PREFIX"
if [[ "$SRC" != "$PREFIX" ]]; then
  for item in src public varnish scripts deploy; do
    rm -rf "${PREFIX:?}/$item"
    cp -a "$SRC/$item" "$PREFIX/$item"
  done
  for item in server.js package.json README.md; do
    [[ -e "$SRC/$item" ]] && cp -a "$SRC/$item" "$PREFIX/$item"
  done
fi
chmod -R u=rwX,go=rX "$PREFIX"

unit=/etc/systemd/system/x70mk2-proxy.service
sed "s#/opt/x70mk2#$PREFIX#g" "$SRC/deploy/x70mk2-proxy.service" > "$unit"
if [[ ! -e "$ENV_FILE" ]]; then
  install -m 600 "$SRC/deploy/x70mk2-proxy.env" "$ENV_FILE"
  # Without Varnish the app itself must be reachable from the network.
  [[ -n "$VARNISHD" ]] || printf '\nHOST=0.0.0.0\n' >> "$ENV_FILE"
  say "settings: $ENV_FILE (set BASIC_AUTH there to keep the proxy private)"
fi

if [[ -n "$VARNISHD" ]]; then
  dropin=/etc/systemd/system/varnish.service.d
  mkdir -p "$dropin"
  sed "s#/opt/x70mk2#$PREFIX#g" "$SRC/deploy/varnish.service.d/override.conf" > "$dropin/override.conf"
  if ! id vcache >/dev/null 2>&1 && id varnish >/dev/null 2>&1; then
    sed -i 's/user=vcache/user=varnish/' "$dropin/override.conf"
  fi
  [[ -s /etc/varnish/secret ]] || { mkdir -p /etc/varnish; head -c 32 /dev/urandom | base64 > /etc/varnish/secret; chmod 600 /etc/varnish/secret; }
fi

systemctl daemon-reload
systemctl enable x70mk2-proxy.service >/dev/null
systemctl restart x70mk2-proxy.service
if [[ -n "$VARNISHD" ]]; then
  systemctl enable varnish.service >/dev/null
  systemctl restart varnish.service
  PUBLIC_PORT=6081
else
  say "varnishd not found: the app serves port 8080 directly (install varnish and re-run to add the cache)"
  PUBLIC_PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -1)"
  PUBLIC_PORT="${PUBLIC_PORT:-8080}"
fi

# Wait for the public port to answer.
for _ in $(seq 1 50); do
  "$NODE" -e 'require("http").get({host:"127.0.0.1",port:+process.argv[1],path:"/__proxy/health",timeout:1000},r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))' "$PUBLIC_PORT" && break
  sleep 0.2
done || true

say "done. Open:"
"$NODE" "$PREFIX/scripts/urls.js" http "$PUBLIC_PORT"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  say "ufw is active: allow the port with  sudo ufw allow $PUBLIC_PORT/tcp"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  say "firewalld is active: sudo firewall-cmd --permanent --add-port=$PUBLIC_PORT/tcp && sudo firewall-cmd --reload"
fi
say "logs: journalctl -u x70mk2-proxy -u varnish -f"
