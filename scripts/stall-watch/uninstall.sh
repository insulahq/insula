#!/usr/bin/env bash
# Remove insula-stall-watch from THIS node. Keeps the recorded logs in
# /var/log/insula-stall-watch unless --purge is given.
set -euo pipefail

PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

systemctl disable --now insula-stall-watch.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/insula-stall-watch.service /etc/insula-stall-watch.conf
systemctl daemon-reload
rm -rf /usr/local/lib/insula-stall-watch /var/lib/insula-stall-watch
if [ "$PURGE" = 1 ]; then
  rm -rf /var/log/insula-stall-watch
  echo "stall-watch removed, logs purged"
else
  echo "stall-watch removed; logs kept in /var/log/insula-stall-watch"
fi
