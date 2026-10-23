#!/usr/bin/env bash
# description: Keeps Longhorn's iSCSI disks out of multipathd on every node (/etc/multipath/conf.d/insula-longhorn.conf) and releases any Longhorn disk multipathd already claimed.
# idempotent: the conf file is rewritten only when its content differs (cmp -s) and multipathd reconfigured only then; Longhorn WWIDs are removed from /etc/multipath/wwids only when present; only Longhorn multipath maps are flushed, and a map in use is left. A converged node changes nothing. Runs on EVERY node — Longhorn attaches disks on any node.
# allow-paths: /etc/multipath/conf.d/insula-longhorn.conf, /etc/multipath/wwids
# blocks-on-failure: yes   # ADR-056: the Longhorn 1.13 upgrade (0008) must not roll while this node can still let multipathd take a Longhorn disk.
# phase: before-services    # ADR-064: step 1 runs it on every node; 0008 is after-services (step 3), so the whole cluster is covered before Longhorn 1.13 rolls
set -euo pipefail

# WHY: each Longhorn instance manager numbers its iSCSI targets from 1, and a
# disk's WWID is derived from target + LUN (tgt: 360000000000000000e<target><lun>).
# While a node runs two instance managers — every Longhorn upgrade, until each
# volume has re-attached — two disks can share a WWID. multipathd (on by default
# on Ubuntu) takes them for two paths to one device and claims the new disk,
# which can then be neither formatted nor mounted, and records the WWID in
# /etc/multipath/wwids, so later disks on that target are claimed too. Measured
# on DEV (Ubuntu 24.04) on the 1.12 -> 1.13 upgrade: a new volume's mkfs refused
# with "apparently in use by the system". Blacklisting Longhorn's disks by
# vendor/product is Longhorn's documented prerequisite. scripts/bootstrap.sh
# (configure_longhorn_multipath_blacklist) writes the same file on fresh nodes.
#
# The file is written whether or not multipath-tools is installed, so
# installing it later is covered too. A node without a running multipathd
# needs nothing else.

MIG="longhorn-multipath-blacklist"
CONF="/etc/multipath/conf.d/insula-longhorn.conf"
WWIDS="/etc/multipath/wwids"
WANT='# Written by Insula (scripts/bootstrap.sh, host-migration 2026.10.17/0007):
# keep Longhorn'"'"'s iSCSI disks out of multipathd.
blacklist {
    device {
        vendor "IET"
        product "VIRTUAL-DISK"
    }
}'

mkdir -p "$(dirname "$CONF")"
changed=0
if ! printf '%s\n' "$WANT" | cmp -s - "$CONF" 2>/dev/null; then
  tmp="$(mktemp "${CONF}.XXXXXX")"
  printf '%s\n' "$WANT" > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$CONF"
  changed=1
  echo "${MIG}: wrote ${CONF}."
fi

if ! command -v multipathd >/dev/null 2>&1 || ! systemctl is-active --quiet multipathd 2>/dev/null; then
  echo "${MIG}: multipathd not running here — the blacklist is in place for when it is; nothing else to do."
  exit 0
fi
if [ "$changed" -eq 1 ]; then
  multipathd reconfigure >/dev/null
fi

# Longhorn WWIDs multipathd has recorded (tgt's NAA prefix; only Longhorn runs
# a tgt target on these nodes).
if [ -f "$WWIDS" ] && grep -qE '^/360000000000000000e[0-9a-f]+/$' "$WWIDS"; then
  sed -i -E '/^\/360000000000000000e[0-9a-f]+\/$/d' "$WWIDS"
  multipathd reconfigure >/dev/null
  echo "${MIG}: removed Longhorn WWIDs from ${WWIDS}."
fi

# Release Longhorn disks multipathd already claimed. A map in use (a volume
# mounted through it) is left: it keeps working and goes away when that volume
# next detaches, after which the blacklist stops it coming back.
maps="$(dmsetup ls --target multipath 2>/dev/null | awk 'NF >= 2 && $1 != "No" {print $1}' || true)"
for map in $maps; do
  dm="$(basename "$(readlink -f "/dev/mapper/${map}")")"
  longhorn=1; any=0
  for slave in /sys/block/"${dm}"/slaves/*; do
    [ -e "$slave" ] || continue
    any=1
    vendor="$(tr -d ' ' < "${slave}/device/vendor" 2>/dev/null || true)"
    model="$(tr -d ' ' < "${slave}/device/model" 2>/dev/null || true)"
    [ "$vendor" = "IET" ] && [ "$model" = "VIRTUAL-DISK" ] || longhorn=0
  done
  [ "$any" -eq 1 ] && [ "$longhorn" -eq 1 ] || continue
  if multipath -f "$map" >/dev/null 2>&1; then
    echo "${MIG}: released Longhorn disk ${map} from multipathd."
  else
    echo "${MIG}: Longhorn disk ${map} is in use through multipathd — left as it is; it is released when its volume next detaches."
  fi
done
echo "${MIG}: Longhorn disks are blacklisted from multipathd on this node."
exit 0
