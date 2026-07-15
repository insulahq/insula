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
live_has_accept() { nft list chain inet filter input 2>/dev/null | grep -qE "dport ${SFTP_PORT}.*accept"; }

if conf_has_accept && live_has_accept; then
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
if ! live_has_accept; then
  # Insert BEFORE the trailing `counter drop` so the accept is actually reached.
  # `nft add rule` appends after it, which would make the rule dead.
  handle="$(nft -a list chain inet filter input 2>/dev/null | awk '/counter drop/ { print $NF; exit }')"
  if [[ -n "$handle" ]]; then
    nft insert rule inet filter input handle "$handle" tcp dport "$SFTP_PORT" accept
  else
    # No trailing drop found (non-standard chain) — append is then correct.
    nft add rule inet filter input tcp dport "$SFTP_PORT" accept
  fi
  echo "host-migration: opened ${SFTP_PORT}/tcp in the live ruleset"
fi

# ── 3. Keep the operator-facing port inventory truthful ───────────────────────
# firewall.conf is bootstrap-written and feeds the security-hardening posture
# reporting; a stale list would under-report the node's open ports.
if [[ -f "$FWCONF" ]] && grep -q '^PUBLIC_TCP_PORTS=' "$FWCONF" && ! grep -qE "^PUBLIC_TCP_PORTS=.*(^| )${SFTP_PORT}( |$)" "$FWCONF"; then
  sed -i "s/^\(PUBLIC_TCP_PORTS=.*\)$/\1 ${SFTP_PORT}/" "$FWCONF"
  echo "host-migration: recorded ${SFTP_PORT} in $FWCONF"
fi

echo "host-migration 0002-sftp-gateway-firewall-port: done."
