#!/usr/bin/env bash
# idempotent: writes the logrotate fragment only when absent or when its content
#             differs from the intended policy (compared with cmp, not a grep
#             for one line). Re-runs on a converged node write nothing.
# allow-paths: /etc/logrotate.d/insula-traefik-access
#              /etc/systemd/system/insula-traefik-logrotate.service
#              /etc/systemd/system/insula-traefik-logrotate.timer
# blocks-on-failure: no    # ADR-056: without rotation the access log grows
#                          # ~7MB/day. Degraded, not immediate — but it IS the
#                          # kind of degradation that ends in a full disk, so
#                          # the converger re-runs it every pass.
set -euo pipefail

# 2026.9.9 — rotate the Traefik access log enabled by 0001.
#
# Traefik writes accessLog.filePath itself and does NOT rotate. The kubelet's
# rotation only covers container stdout, which this deliberately is not (the
# CRI envelope would break the CrowdSec parser — see 0001). So rotation is the
# host's job, and skipping it trades a detection blind spot for a disk-full
# outage, which is a worse deal.
#
# copytruncate rather than SIGUSR1: Traefik reopens on SIGUSR1, but signalling
# a specific container from a logrotate postrotate hook means knowing the
# container runtime and PID from outside the pod. copytruncate has a small
# race (lines written between copy and truncate are lost) which is acceptable
# for an access log used as a rate signal.
#
# BOUNDING THE SIZE — the reason this runs HOURLY, not daily.
#
# `maxsize` is only evaluated when logrotate actually runs. On the distro
# default (logrotate.timer, once a day) a `maxsize 200M` is not a 200M cap: it
# is "200M checked once a day", so a scan burst can grow the file unbounded
# until the next run. That is precisely the traffic this feature exists to
# detect, so the failure mode correlates with the event.
#
# Hourly + maxsize 200M gives a real worst case:
#     live file   ≤ 200M + one hour of writes
#     archives    ≤ 7 compressed generations (~10:1 on JSON) ≈ 140M
#     total       ≈ 400M on a node whose disk is sized in tens of GB
# Steady state is far below that: production writes ~7MB/day.

FRAG=/etc/logrotate.d/insula-traefik-access
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

cat > "$TMP" <<'FRAGMENT'
/var/log/traefik/access.log {
    hourly
    rotate 7
    maxsize 200M
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
    su root root
}
FRAGMENT

if [ -f "$FRAG" ] && cmp -s "$TMP" "$FRAG"; then
  echo "traefik-access-log-rotate: already converged — no change"
  exit 0
fi

install -D -m 0644 "$TMP" "$FRAG"

# Hourly timer for THIS fragment only — the distro's daily logrotate.timer is
# left untouched so nothing else changes cadence.
install -D -m 0644 /dev/stdin /etc/systemd/system/insula-traefik-logrotate.service <<'UNIT'
[Unit]
Description=Rotate the Traefik access log (Insula)
Documentation=https://github.com/insulahq/insula

[Service]
Type=oneshot
# Only this fragment; -s keeps its own state file so it never races the
# distro-wide logrotate run.
ExecStart=/usr/sbin/logrotate -s /var/lib/logrotate/insula-traefik.status /etc/logrotate.d/insula-traefik-access
UNIT

install -D -m 0644 /dev/stdin /etc/systemd/system/insula-traefik-logrotate.timer <<'UNIT'
[Unit]
Description=Hourly Traefik access-log rotation (Insula)

[Timer]
OnCalendar=hourly
# Survive a node that was powered off across the scheduled run.
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
UNIT

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable --now insula-traefik-logrotate.timer >/dev/null 2>&1 \
    || echo "traefik-access-log-rotate: timer enable failed — rotation falls back to the distro daily run"
fi

echo "traefik-access-log-rotate: installed $FRAG + hourly timer (keep 7, cap 200M, ~400M worst case)"
