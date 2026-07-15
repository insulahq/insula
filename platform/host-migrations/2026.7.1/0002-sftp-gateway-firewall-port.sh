#!/usr/bin/env bash
# idempotent: no-op once /etc/nftables.conf declares the SFTP accept AND the
#   live input chain carries it (fresh installs render both via bootstrap.sh).
#   Re-running after success hits the guard. A partially-applied node (file
#   written, live add failed) re-does the idempotent work rather than passing
#   the guard on the file alone.
# allow-paths: /etc/nftables.conf /etc/hosting-platform/firewall.conf
#
# Opens the tenant SFTP gateway port on existing clusters.
#
# The gateway moved from a `type: LoadBalancer` Service to a hostPort DaemonSet
# on the control-plane servers (k8s/base/sftp-gateway.yaml): bootstrap runs k3s
# with `--disable=servicelb` and self-managed VPS nodes have no cloud LB, so the
# LoadBalancer sat at `EXTERNAL-IP <pending>` forever and nothing ever bound the
# port — tenant SFTP was unreachable on every deployment.
#
# bootstrap.sh renders the accept for FRESH installs only (ADR-045 W10c), so
# existing clusters need this backfill. firewall-reconciler cannot do it: it
# only opens hostPorts for TENANT namespaces (client-*), and the gateway runs in
# platform-system.
#
# Port 23022 is deliberate — see k8s/base/sftp-gateway.yaml: it must stay below
# 32768 (the ephemeral range, where a hostPort can collide with outbound source
# ports) and outside 30000-32767 (the NodePort range).
set -euo pipefail

CONF=/etc/nftables.conf
FWCONF=/etc/hosting-platform/firewall.conf
SFTP_PORT=23022

# Nodes not on the standard nft ruleset (a firewall mode that never wrote the
# file) have nothing to backfill. Not an error.
if [[ ! -f "$CONF" ]]; then
  echo "host-migration: $CONF absent — node not on the standard nft firewall; skipping."
  exit 0
fi

conf_has_accept() { grep -qE "^[[:space:]]*tcp dport ${SFTP_PORT} accept" "$CONF"; }

# Handle of the input chain's trailing catch-all drop.
#
# NOTE the rendering gap: bootstrap.sh WRITES `counter drop`, but `nft list`
# RENDERS it with its counters — `counter packets 1303181 bytes 196133577 drop`.
# Matching the literal source text finds nothing in the live chain, which is
# exactly how the first cut of this migration appended the accept AFTER the drop
# (a dead rule: the port stayed closed while the migration reported success, and
# a naive "does an accept exist" guard then said "already open" forever). Match
# the LIVE rendering, with the counters optional.
drop_handle() {
  nft -a list chain inet filter input 2>/dev/null \
    | awk '/^[[:space:]]*counter( packets [0-9]+ bytes [0-9]+)? drop[[:space:]]*#[[:space:]]*handle [0-9]+$/ { print $NF; exit }'
}

# The accept is only EFFECTIVE if it precedes that catch-all drop. Existence is
# not enough — an accept after the drop is unreachable.
live_accept_effective() {
  local chain accept_line drop_line
  chain="$(nft list chain inet filter input 2>/dev/null)" || return 1
  accept_line="$(awk "/tcp dport ${SFTP_PORT} accept/ { print NR; exit }" <<<"$chain")"
  drop_line="$(awk '/^[[:space:]]*counter( packets [0-9]+ bytes [0-9]+)? drop[[:space:]]*$/ { print NR; exit }' <<<"$chain")"
  [[ -n "$accept_line" && -n "$drop_line" && "$accept_line" -lt "$drop_line" ]]
}

# Delete an accept that exists but sits after the drop, so we can re-insert it
# in the right place (self-heals a node that ran the first cut of this script).
delete_dead_accept() {
  local h
  h="$(nft -a list chain inet filter input 2>/dev/null \
       | awk "/tcp dport ${SFTP_PORT} accept[[:space:]]*#[[:space:]]*handle [0-9]+$/ { print \$NF; exit }")"
  [[ -n "$h" ]] || return 0
  nft delete rule inet filter input handle "$h" 2>/dev/null || true
  echo "host-migration: removed a dead ${SFTP_PORT}/tcp accept that sat after the catch-all drop"
}

if conf_has_accept && live_accept_effective; then
  echo "host-migration: SFTP port ${SFTP_PORT} already open in config + kernel; nothing to do."
  exit 0
fi

# ── 1. Persist into /etc/nftables.conf ────────────────────────────────────────
# Anchor after the ManageSieve accept — the last of the mail port accepts, which
# bootstrap renders in the same block. Anchoring to a rule (not a line number)
# keeps this stable across bootstrap edits.
if ! conf_has_accept; then
  if ! grep -qE '^[[:space:]]*tcp dport 4190 accept' "$CONF"; then
    echo "host-migration: could not find the 'tcp dport 4190 accept' anchor in $CONF — refusing to guess placement." >&2
    exit 1
  fi
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  awk -v port="$SFTP_PORT" '
    { print }
    /^[[:space:]]*tcp dport 4190 accept/ && !done {
      print ""
      print "    # Tenant SFTP/SCP/rsync gateway (files.<apex>) — hostPort DaemonSet"
      print "    # on the control-plane servers. Backfilled by host-migration"
      print "    # 0002-sftp-gateway-firewall-port.sh."
      print "    tcp dport " port " accept   # SFTP gateway"
      done = 1
    }
  ' "$CONF" > "$tmp"

  # NEVER install an unvalidated ruleset — a broken nftables.conf locks the node
  # out on next boot.
  if ! nft -c -f "$tmp" >/dev/null 2>&1; then
    echo "host-migration: generated ruleset failed 'nft -c' validation — not applying." >&2
    nft -c -f "$tmp" >&2 || true
    exit 1
  fi
  cp "$tmp" "$CONF"
  echo "host-migration: added 'tcp dport ${SFTP_PORT} accept' to $CONF"
fi

# ── 2. Apply to the running kernel ────────────────────────────────────────────
# Add the single rule rather than reloading the whole ruleset: a full reload
# flushes the runtime-managed sets (tenant_ports_*, blacklist_v*, cluster_peers_*)
# that firewall-reconciler owns, briefly dropping tenant traffic and operator
# bans until it re-converges.
if ! live_accept_effective; then
  # An accept may exist but be unreachable (after the drop) — drop it first so
  # the re-insert below lands in the right place instead of adding a duplicate.
  delete_dead_accept

  # Insert BEFORE the trailing catch-all drop so the accept is actually reached.
  # `nft add rule` APPENDS (after the drop) — that is what made the rule dead.
  handle="$(drop_handle)"
  if [[ -n "$handle" ]]; then
    nft insert rule inet filter input handle "$handle" tcp dport "$SFTP_PORT" accept
  else
    # No catch-all drop found (non-standard chain, e.g. policy accept) — append
    # is then correct and reachable.
    nft add rule inet filter input tcp dport "$SFTP_PORT" accept
  fi

  # Never report success on a rule that is not actually reachable.
  if live_accept_effective; then
    echo "host-migration: opened ${SFTP_PORT}/tcp in the live ruleset"
  else
    echo "host-migration: FAILED to place a reachable ${SFTP_PORT}/tcp accept in the live input chain." >&2
    echo "  The persisted $CONF is correct, so a reload/reboot would open it; refusing to report success." >&2
    exit 1
  fi
fi

# ── 3. Keep the operator-facing port inventory truthful ───────────────────────
# firewall.conf is bootstrap-written and feeds the security-hardening posture
# reporting; a stale list would under-report the node's open ports.
if [[ -f "$FWCONF" ]] && grep -q '^PUBLIC_TCP_PORTS=' "$FWCONF" && ! grep -qE "^PUBLIC_TCP_PORTS=.*(^| )${SFTP_PORT}( |$)" "$FWCONF"; then
  sed -i "s/^\(PUBLIC_TCP_PORTS=.*\)$/\1 ${SFTP_PORT}/" "$FWCONF"
  echo "host-migration: recorded ${SFTP_PORT} in $FWCONF"
fi

echo "host-migration 0002-sftp-gateway-firewall-port: done."
