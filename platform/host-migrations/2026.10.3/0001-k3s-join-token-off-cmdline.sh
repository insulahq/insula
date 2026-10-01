#!/usr/bin/env bash
# idempotent: acts only while the k3s unit still carries a '--token=' argument; once moved, the grep finds nothing and the script exits 0 without touching any file
# allow-paths: /etc/systemd/system/k3s.service /etc/systemd/system/k3s.service.env
# blocks-on-failure: no    # ADR-056: nothing later depends on where the token lives
set -euo pipefail

# Take the cluster join token off the k3s server's command line.
#
# A server that JOINED a cluster through bootstrap.sh before this release was
# installed with `--token=<token>` as a k3s argument. The installer renders it
# into /etc/systemd/system/k3s.service (mode 0644, world-readable) and it shows
# in every `ps` listing. The node token is a cluster credential: it lets a host
# join the cluster as a server. bootstrap.sh now passes it as K3S_TOKEN, which
# the installer writes to the root-only k3s.service.env; this backfills nodes
# joined the old way. First servers (--cluster-init) and workers never had it.
#
# NO RESTART, deliberately. On a 2-member control plane a k3s restart stalls
# etcd for the length of the restart (observed: 13 s). The edit takes effect at
# the node's next natural k3s restart (reboot, k3s upgrade); until then the
# running process keeps the argument it started with. k3s reads K3S_TOKEN from
# the env file the unit already loads (EnvironmentFile=-…/k3s.service.env).

# Overridable ONLY for the test harness — the runner gives scripts a clean
# environment (PATH + HOME), so these are inert in production.
UNIT_DIR="${HM_UNIT_DIR:-/etc/systemd/system}"
SYSTEMCTL="${HM_SYSTEMCTL:-systemctl}"
UNIT="${UNIT_DIR}/k3s.service"
ENVF="${UNIT_DIR}/k3s.service.env"
MIG="0001-k3s-join-token-off-cmdline"

if [[ ! -f "$UNIT" ]]; then
  echo "${MIG}: no k3s server unit on this node (worker or not installed) — nothing to do."
  exit 0
fi

# The installer renders each argument on its own line:  <indent>'--token=<value>' \
token_line="$(grep -E "^[[:space:]]*'--token=[^']*'" "$UNIT" || true)"
if [[ -z "$token_line" ]]; then
  # A previous run that rewrote the unit but died before daemon-reload would
  # otherwise never reload: finish that step if systemd still holds the old unit.
  if [[ "$("$SYSTEMCTL" show -p NeedDaemonReload --value k3s 2>/dev/null || true)" == "yes" ]]; then
    "$SYSTEMCTL" daemon-reload
    echo "${MIG}: unit already rewritten; completed the pending daemon-reload."
    exit 0
  fi
  echo "${MIG}: the k3s unit carries no --token argument — nothing to do."
  exit 0
fi
if [[ "$(grep -cE "^[[:space:]]*'--token=" "$UNIT")" -ne 1 ]]; then
  echo "${MIG}: more than one --token argument in ${UNIT} — refusing to guess which is live." >&2
  exit 1
fi
token="$(sed -E "s/^[[:space:]]*'--token=([^']*)'.*/\1/" <<<"$token_line")"
if [[ -z "$token" ]]; then
  echo "${MIG}: could not parse the --token argument in ${UNIT}." >&2
  exit 1
fi

# Record it in the root-only env file (or confirm it is already there).
umask 077
touch "$ENVF"
chmod 600 "$ENVF"
if grep -q '^K3S_TOKEN=' "$ENVF"; then
  have="$(sed -n 's/^K3S_TOKEN=//p' "$ENVF" | head -1)"
  have="${have#\"}"; have="${have%\"}"; have="${have#\'}"; have="${have%\'}"
  if [[ "$have" != "$token" ]]; then
    echo "${MIG}: K3S_TOKEN in ${ENVF} differs from the unit's --token — refusing to guess which is live." >&2
    exit 1
  fi
else
  printf 'K3S_TOKEN=%s\n' "$token" >> "$ENVF"
fi

# Drop the argument line. When it was the LAST argument (no trailing
# backslash), the previous line's continuation backslash must go too, or
# ExecStart would swallow whatever line follows.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
awk '
  /^[[:space:]]*'"'"'--token=/ {
    if ($0 !~ /\\[[:space:]]*$/ && have_prev) sub(/[[:space:]]*\\[[:space:]]*$/, "", prev)
    next
  }
  { if (have_prev) print prev; prev = $0; have_prev = 1 }
  END { if (have_prev) print prev }
' "$UNIT" > "$TMP"
if grep -qE "^[[:space:]]*'--token=" "$TMP"; then
  echo "${MIG}: --token still present after the rewrite — leaving ${UNIT} untouched." >&2
  exit 1
fi
chmod --reference="$UNIT" "$TMP"
cat "$TMP" > "$UNIT"
"$SYSTEMCTL" daemon-reload
echo "${MIG}: moved the join token from ${UNIT} to ${ENVF} (0600). Takes effect at the next k3s restart — NOT restarting now."
