#!/usr/bin/env bash
# description: record the public Calico WireGuard ports (51821; 51822 on dual-stack) in the node's firewall.conf port inventory
# idempotent: appends only a port the node's own /etc/nftables.conf accepts publicly
#   and the inventory does not list yet; a re-run finds every port listed and
#   writes nothing. A node without the inventory file, or without PUBLIC_UDP_PORTS,
#   exits 0 untouched.
# allow-paths: /etc/hosting-platform/firewall/firewall.conf
# blocks-on-failure: no     # ADR-056: an inventory line; nothing later depends on it
# phase: before-services    # ADR-064: needs nothing from the new release
set -euo pipefail
#
# firewall.conf's PUBLIC_UDP_PORTS feeds the security probe, and the posture
# page's "Calico WireGuard (UDP/51821)" card counts the nodes whose list carries
# 51821. bootstrap.sh wrote `PUBLIC_UDP_PORTS=51820 29899` — never 51821, though
# the firewall accepts it from anywhere by default — so the card read "0 of N
# nodes" on every cluster. 51822 (Calico WireGuard for IPv6, host-migration
# 0001-calico-wireguard-ipv6) is the same kind of port.
#
# The firewall is the source of truth: a port is recorded only when the node's
# /etc/nftables.conf accepts it from any source (`udp dport N accept`, no saddr).
# Under --calico-wg-public=false the accept is scoped to trusted_ranges and the
# port is, correctly, NOT public — nothing is recorded.

CONF=/etc/nftables.conf
# The real file: /etc/hosting-platform/firewall.conf is a relative symlink to it,
# and `sed -i` on the link would replace the link with a plain file the probe
# (which mounts the firewall/ directory) never reads.
FWCONF=/etc/hosting-platform/firewall/firewall.conf
[[ -f "$FWCONF" ]] || FWCONF=/etc/hosting-platform/firewall.conf
FWCONF="$(readlink -f "$FWCONF" 2>/dev/null || echo "$FWCONF")"

if [[ ! -f "$FWCONF" ]] || ! grep -q '^PUBLIC_UDP_PORTS=' "$FWCONF"; then
  echo "host-migration: no PUBLIC_UDP_PORTS inventory on this node — nothing to record."
  exit 0
fi
if [[ ! -f "$CONF" ]]; then
  echo "host-migration: $CONF absent — node not on the standard nft firewall; nothing to record."
  exit 0
fi

current="$(sed -n 's/^PUBLIC_UDP_PORTS=//p' "$FWCONF" | head -n1)"
add=()
for port in 51821 51822; do
  # Public = an accept with no source restriction, as bootstrap.sh renders it.
  if grep -qE "^[[:space:]]*udp dport ${port} accept" "$CONF" \
     && ! grep -qE "(^| )${port}( |$)" <<<"$current"; then
    add+=("$port")
  fi
done

if (( ${#add[@]} == 0 )); then
  echo "host-migration: PUBLIC_UDP_PORTS already lists every public Calico WireGuard port (${current})."
  exit 0
fi

tmp="$(mktemp "${FWCONF}.tmp.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
sed "s/^PUBLIC_UDP_PORTS=.*$/PUBLIC_UDP_PORTS=${current} ${add[*]}/" "$FWCONF" > "$tmp"
chmod --reference="$FWCONF" "$tmp"
mv -f "$tmp" "$FWCONF"
echo "host-migration: PUBLIC_UDP_PORTS ${current} → ${current} ${add[*]} (${FWCONF})"
