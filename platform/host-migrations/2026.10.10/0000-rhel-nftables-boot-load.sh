#!/usr/bin/env bash
# description: RHEL-family nodes — load the platform firewall at boot (it was gone after every reboot) and restore it now where it is missing
# idempotent: appends the include to /etc/sysconfig/nftables.conf only when absent,
#   and loads the platform table only when the live ruleset lacks `inet filter`; a
#   re-run finds both in place and writes nothing. Nodes whose nftables.service
#   loads /etc/nftables.conf directly (Debian, Ubuntu) exit 0 untouched.
# allow-paths: /etc/sysconfig/nftables.conf
# blocks-on-failure: yes    # ADR-056: runs first (0000) because the later firewall migrations insert into `inet filter` live
# phase: before-services    # ADR-064: needs nothing from the new release
set -euo pipefail
#
# bootstrap.sh writes the platform firewall to /etc/nftables.conf and runs
# `systemctl enable nftables`. On Debian and Ubuntu that unit loads
# /etc/nftables.conf. On the RHEL family (RHEL, Rocky, Alma, CentOS Stream,
# Amazon Linux) it loads /etc/sysconfig/nftables.conf — empty by default — so after
# the first reboot the node ran with NO platform firewall: no `inet filter` table,
# no tenant-port rules, no operator blacklist, no CrowdSec drops (measured on a
# Rocky 9.8 staging node after a VM restart).
#
# Restoring a missing table here loads /etc/nftables.conf WITHOUT its
# `flush ruleset` line: the node is running, and a full flush would also wipe
# Calico's and kube-proxy's tables until they resync. firewall-reconciler then
# repopulates the runtime sets (cluster_peers_*, tenant_ports_*) within seconds.

CONF=/etc/nftables.conf
SYSCONF=/etc/sysconfig/nftables.conf
INCLUDE='include "/etc/nftables.conf"'

if ! systemctl cat nftables.service 2>/dev/null | grep -q '^ExecStart=.*/etc/sysconfig/nftables\.conf'; then
  echo "host-migration: nftables.service does not load ${SYSCONF} here — it loads ${CONF} directly; nothing to do."
  exit 0
fi
if [[ ! -f "$CONF" ]] || ! grep -q '^table inet filter' "$CONF"; then
  echo "host-migration: ${CONF} is not the platform firewall on this node — nothing to wire up."
  exit 0
fi

# ── 1. Load it at every boot ──────────────────────────────────────────────────
if grep -qxF "$INCLUDE" "$SYSCONF" 2>/dev/null; then
  echo "host-migration: ${SYSCONF} already includes ${CONF}."
else
  printf '\n# Insula platform firewall (host-migration 0000-rhel-nftables-boot-load) — loaded at boot.\n%s\n' "$INCLUDE" >> "$SYSCONF"
  echo "host-migration: ${SYSCONF} now includes ${CONF} — the platform firewall loads at boot."
fi

# ── 2. Restore it now if this node already rebooted without it ────────────────
if nft list table inet filter >/dev/null 2>&1; then
  echo "host-migration: the platform firewall is loaded."
else
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  sed '/^[[:space:]]*flush ruleset[[:space:]]*$/d' "$CONF" > "$tmp"
  if ! nft -c -f "$tmp" >/dev/null 2>&1; then
    echo "host-migration: ${CONF} (without its flush) failed 'nft -c' — NOT loaded; the node still has no platform firewall." >&2
    nft -c -f "$tmp" >&2 || true
    exit 1
  fi
  nft -f "$tmp"
  if ! nft list table inet filter >/dev/null 2>&1; then
    echo "host-migration: loaded ${CONF} but 'inet filter' is still absent — refusing to report success." >&2
    exit 1
  fi
  echo "host-migration: the platform firewall was MISSING (the node had rebooted) — restored from ${CONF}."
fi

echo "host-migration 0000-rhel-nftables-boot-load: done."
