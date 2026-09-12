#!/usr/bin/env bash
# idempotent: creates /etc/nftables.d if absent and appends the include line to
#   /etc/nftables.conf only when grep does not already find it; re-running finds
#   both in place and writes nothing.
# allow-paths: /etc/nftables.conf /etc/nftables.d
# blocks-on-failure: yes    # ADR-056: 'no' iff NOTHING later depends on this script
set -euo pipefail

# Let a rebooted control-plane node rejoin the cluster.
#
# nftables restores /etc/nftables.conf at boot, but that file carries only the
# set DECLARATIONS -- set members are runtime state and a reboot discards them.
# `cluster_peers_v{4,6}` gates inbound etcd/apiserver/kubelet traffic under a
# `policy drop` chain, so an empty set after a reboot means no peer can reach
# the node: etcd logs "failed to publish local member to cluster through raft"
# and the node never rejoins.
#
# It deadlocks, because the only component that fills the set --
# images/firewall-reconciler -- is a DaemonSet running INSIDE the cluster the
# node can no longer join. Measured on staging 2026-09-12: a rebooted server sat
# NotReady for 19 minutes, untouched by the hourly host-config converger (which
# does not manage these sets), and rejoined 21 seconds after the members were
# restored by hand.
#
# The reconciler now writes its members to /etc/nftables.d/10-cluster-peers.conf
# on every successful apply. This migration adds the include that replays them,
# because a bootstrap.sh change reaches FRESH installs only -- without this, no
# existing cluster is fixed.

CONF=/etc/nftables.conf
DROPIN_DIR=/etc/nftables.d

mkdir -p "$DROPIN_DIR"

# A glob matching nothing is tolerated by modern nft, but an explicit
# placeholder keeps the include meaningful before the first reconcile pass.
if [ ! -e "$DROPIN_DIR/00-placeholder.conf" ]; then
  printf '# populated by firewall-reconciler\n' > "$DROPIN_DIR/00-placeholder.conf"
fi

if [ ! -f "$CONF" ]; then
  echo "0001-nftables-peer-set-boot-restore: $CONF absent; nothing to patch" >&2
  exit 0
fi

if grep -qF 'nftables.d/*.conf' "$CONF"; then
  echo "0001-nftables-peer-set-boot-restore: include already present; no change"
  exit 0
fi

# Append rather than splice: the include must land AFTER the table block that
# declares the sets, and end-of-file is the only position guaranteed to be after
# it regardless of how this host's config was generated.
cat >> "$CONF" <<'NFTINC'

# Last-known-good dynamic set members, re-applied on boot.
# Written by firewall-reconciler; see platform/host-migrations/2026.9.18/
# 0001-nftables-peer-set-boot-restore.sh for why this exists.
include "/etc/nftables.d/*.conf"
NFTINC

# Validate before trusting it. A config that fails to parse would leave the node
# firewall-less on its next boot, which is far worse than the bug being fixed.
if ! nft -c -f "$CONF" >/dev/null 2>&1; then
  echo "0001-nftables-peer-set-boot-restore: patched $CONF fails 'nft -c'; reverting" >&2
  # Strip exactly what was appended above.
  sed -i '/^# Last-known-good dynamic set members, re-applied on boot\.$/,/^include "\/etc\/nftables\.d\/\*\.conf"$/d' "$CONF"
  exit 1
fi

echo "0001-nftables-peer-set-boot-restore: include added to $CONF"
