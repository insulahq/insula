#!/usr/bin/env bash
# idempotent: installs logrotate only when absent, then content-compares the logrotate fragment and both systemd units (cmp -s) and rewrites only what differs; a converged node writes nothing, reloads nothing and exits 0.
# allow-paths: /etc/logrotate.d/insula-traefik-access /etc/systemd/system/insula-traefik-logrotate.service /etc/systemd/system/insula-traefik-logrotate.timer (plus the logrotate package when absent)
# blocks-on-failure: no    # ADR-056: retention policy only — the previous fragment keeps rotating; nothing later depends on this script.
set -euo pipefail

# Keep the Traefik access log for 30 days, and reap it after that.
#
# 2026.9.9/0002 rotated /var/log/traefik/access.log HOURLY and kept 7 files —
# about seven hours of history on a busy node — which is too little to look back
# at an incident or for the CrowdSec console to correlate with. The policy is now
# daily rotation (earlier once the file passes 200M, checked by the existing
# hourly timer), 30 rotations, `maxage 30` so nothing older survives, gzip after
# a day. Worst case on disk: one uncompressed file ≤ 200M plus 29 compressed.
#
# bootstrap.sh installs the identical fragment and units on fresh nodes
# (configure_traefik_access_log_rotation); scripts/test-traefik-access-log-values.sh
# diffs the two copies. Runs on every node — the Traefik DaemonSet writes this
# file on workers too.

MIG="traefik-access-log-retention"

# Minimal cloud images ship without logrotate; the rotation unit would then fail
# every hour and nothing would ever be reaped. Install it when absent.
if ! command -v logrotate >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq logrotate >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q logrotate >/dev/null
  else
    echo "${MIG}: logrotate is missing and neither apt-get nor dnf is available." >&2
    exit 1
  fi
  command -v logrotate >/dev/null 2>&1 || { echo "${MIG}: logrotate install failed." >&2; exit 1; }
  echo "${MIG}: installed logrotate."
fi
FRAG=/etc/logrotate.d/insula-traefik-access
SVC=/etc/systemd/system/insula-traefik-logrotate.service
TMR=/etc/systemd/system/insula-traefik-logrotate.timer

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/frag" <<'FRAGMENT'
/var/log/traefik/access.log {
    daily
    rotate 30
    maxage 30
    maxsize 200M
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
    su root root
}
FRAGMENT

cat > "$TMP/svc" <<'SERVICE'
[Unit]
Description=Rotate the Traefik access log (Insula)
Documentation=https://github.com/insulahq/insula

[Service]
Type=oneshot
ExecStart=/usr/sbin/logrotate -s /var/lib/logrotate/insula-traefik.status /etc/logrotate.d/insula-traefik-access
SERVICE

cat > "$TMP/tmr" <<'TIMER'
[Unit]
Description=Hourly Traefik access-log rotation check (Insula)

[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
TIMER

changed=0
converge() { # <src> <dst>
  if [ -f "$2" ] && cmp -s "$1" "$2"; then return 0; fi
  install -D -m 0644 "$1" "$2"
  echo "${MIG}: wrote $2"
  changed=1
}
converge "$TMP/frag" "$FRAG"
converge "$TMP/svc" "$SVC"
converge "$TMP/tmr" "$TMR"
install -d -m 0755 /var/lib/logrotate

if [ "$changed" -eq 0 ] && systemctl is-enabled --quiet insula-traefik-logrotate.timer 2>/dev/null; then
  echo "${MIG}: already converged — no change."
  exit 0
fi
systemctl daemon-reload
systemctl enable --now insula-traefik-logrotate.timer >/dev/null 2>&1 \
  || { echo "${MIG}: could not enable insula-traefik-logrotate.timer" >&2; exit 1; }
echo "${MIG}: access log now rotated daily (200M cap, hourly check) and kept 30 days."
