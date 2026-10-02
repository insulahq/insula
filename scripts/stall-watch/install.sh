#!/usr/bin/env bash
# Install (or re-arm) insula-stall-watch on THIS node — a temporary recorder of
# storage / vCPU stalls. See stall-watch.py for what it records and README.md
# for how to read it.
#
#   ./install.sh [--days N] [--backfill DAYS]
#
# --days N         record for N days from now (default 14); re-running re-arms
#                  the deadline and keeps the logs already recorded
# --backfill DAYS  also write journal-only daily lines for the past DAYS days
#
# Run as root from the directory holding stall-watch.py. Idempotent.
set -euo pipefail

DAYS=14
BACKFILL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --days) DAYS="${2:?--days needs a number}"; shift 2 ;;
    --backfill) BACKFILL="${2:?--backfill needs a number}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$DAYS$BACKFILL" in *[!0-9]*) echo "--days/--backfill take whole numbers" >&2; exit 2 ;; esac
[ "$DAYS" -ge 1 ] || { echo "--days must be at least 1" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB=/usr/local/lib/insula-stall-watch
UNIT=/etc/systemd/system/insula-stall-watch.service

python3 "$HERE/stall-watch.py" selftest >/dev/null

install -d -m 0755 "$LIB" /var/lib/insula-stall-watch /var/log/insula-stall-watch
install -m 0755 "$HERE/stall-watch.py" "$LIB/stall-watch.py"
STOP_AT="$(date -u -d "+${DAYS} days" +%Y-%m-%dT%H:%M:%SZ)"
printf 'STOP_AT=%s\n' "$STOP_AT" > /etc/insula-stall-watch.conf

cat > "$UNIT" <<'UNIT'
[Unit]
Description=Insula stall watch (temporary storage/vCPU stall evidence recorder)
After=local-fs.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /usr/local/lib/insula-stall-watch/stall-watch.py run
# Exits 0 on its own at STOP_AT; only a crash restarts it.
Restart=on-failure
RestartSec=10
Nice=-5
MemoryMax=128M
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/insula-stall-watch /var/log/insula-stall-watch

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable insula-stall-watch.service >/dev/null 2>&1
systemctl restart insula-stall-watch.service

if [ "$BACKFILL" -gt 0 ]; then
  python3 "$LIB/stall-watch.py" backfill "$BACKFILL" >/dev/null
fi

sleep 2
systemctl is-active --quiet insula-stall-watch.service \
  || { journalctl -u insula-stall-watch --no-pager -n 20 >&2; echo "stall-watch did not start" >&2; exit 1; }
echo "stall-watch: recording on $(hostname) until ${STOP_AT}"
echo "  read:   python3 $LIB/stall-watch.py report"
echo "  remove: $HERE/uninstall.sh  (or systemctl disable --now insula-stall-watch)"
