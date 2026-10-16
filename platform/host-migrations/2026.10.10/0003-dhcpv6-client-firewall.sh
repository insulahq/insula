#!/usr/bin/env bash
# description: let DHCPv6 replies reach the node — a node that takes its IPv6 by DHCPv6 lost it at the next lease renewal or network restart
# idempotent: no-op once /etc/nftables.conf declares the DHCPv6-reply accept AND the
#   live input chain carries it ahead of the catch-all drop. A partially-applied
#   node (file written, live insert failed) redoes the idempotent work.
# allow-paths: /etc/nftables.conf
# blocks-on-failure: no     # ADR-056: opens a port; nothing later depends on it
# phase: before-services    # ADR-064: needs nothing from the new release
set -euo pipefail
#
# The host firewall's input chain (policy drop) accepts ICMPv6 — Router
# Advertisements, so SLAAC works — but nothing for DHCPv6. A DHCPv6 server's reply
# comes from its link-local address, port 547, to the client's port 546; the
# client's request went to a multicast group, so the reply is never "established".
# The DHCPv4 client reads through a raw socket and never meets this chain; the
# DHCPv6 client does. A node whose IPv6 is DHCPv6-assigned (EC2, many VPS
# providers, the local lab) keeps the address it had before the firewall went up,
# then loses it at the next renewal or network restart — measured: an address gone
# for good after a systemd-networkd restart, back within 2 s once replies passed.
# Single-stack clusters too: the table is `inet`, and a host's own IPv6 is not
# the cluster's to break.
#
# Source fe80::/10 only: servers and relay agents answer on-link from link-local.

CONF=/etc/nftables.conf
RULE="ip6 saddr fe80::/10 udp sport 547 udp dport 546 accept"

if [[ ! -f "$CONF" ]]; then
  echo "host-migration: $CONF absent — node not on the standard nft firewall; skipping."
  exit 0
fi

live_chain_handles() {
  if ! nft -a list chain inet filter input 2>/dev/null; then
    echo "host-migration: cannot list 'inet filter input' — nftables not loaded on this node?" >&2
    return 1
  fi
}
drop_handle() {
  local chain
  chain="$(live_chain_handles)" || return 1
  awk '/^[[:space:]]*counter( packets [0-9]+ bytes [0-9]+)? drop[[:space:]]*#[[:space:]]*handle [0-9]+$/ { print $NF; exit }' <<<"$chain"
}
live_accept_effective() {
  local chain accept_line drop_line
  chain="$(nft list chain inet filter input 2>/dev/null)" || return 1
  accept_line="$(awk -v pat="$RULE" 'index($0, pat) { print NR; exit }' <<<"$chain")"
  drop_line="$(awk '/^[[:space:]]*counter( packets [0-9]+ bytes [0-9]+)? drop[[:space:]]*$/ { print NR; exit }' <<<"$chain")"
  [[ -n "$accept_line" && -n "$drop_line" && "$accept_line" -lt "$drop_line" ]]
}
delete_dead_accept() {
  local h chain
  chain="$(live_chain_handles)" || return 1
  h="$(awk -v pat="$RULE" 'index($0, pat) && /#[[:space:]]*handle [0-9]+$/ { print $NF; exit }' <<<"$chain")"
  [[ -n "$h" ]] || return 0
  nft delete rule inet filter input handle "$h" 2>/dev/null || true
  echo "host-migration: removed a dead DHCPv6 accept that sat after the catch-all drop"
}

if grep -qF "$RULE" "$CONF" && live_accept_effective; then
  echo "host-migration: DHCPv6 replies already accepted in config + kernel; nothing to do."
  exit 0
fi

# ── 1. Persist into /etc/nftables.conf, right after the ICMPv6 accept ─────────
if ! grep -qF "$RULE" "$CONF"; then
  anchor="$(awk '/ip6 nexthdr (icmpv6|ipv6-icmp) accept/ { print NR; exit }' "$CONF")"
  if [[ -z "$anchor" ]]; then
    echo "host-migration: no ICMPv6 accept in $CONF to anchor on — inspect the input chain manually." >&2
    exit 1
  fi
  tmp="$(mktemp "${CONF}.tmp.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  {
    head -n "$anchor" "$CONF"
    echo "    ${RULE}   # DHCPv6 client replies (host-migration 0003-dhcpv6-client-firewall.sh)"
    tail -n +"$((anchor + 1))" "$CONF"
  } > "$tmp"
  if ! nft -c -f "$tmp" >/dev/null 2>&1; then
    echo "host-migration: generated ruleset failed 'nft -c' validation — not applying." >&2
    nft -c -f "$tmp" >&2 || true
    exit 1
  fi
  chmod --reference="$CONF" "$tmp"
  mv -f "$tmp" "$CONF"
  if command -v restorecon >/dev/null 2>&1; then restorecon "$CONF" 2>/dev/null || true; fi
  echo "host-migration: added the DHCPv6-reply accept to $CONF"
fi

# ── 2. Apply to the running kernel (one rule — never a full reload) ───────────
if ! live_accept_effective; then
  delete_dead_accept || exit 1
  handle="$(drop_handle)" || exit 1
  # shellcheck disable=SC2086  # RULE is a rule expression: word splitting intended
  if [[ -n "$handle" ]]; then
    nft insert rule inet filter input handle "$handle" $RULE
  else
    nft add rule inet filter input $RULE
  fi
  if ! live_accept_effective; then
    echo "host-migration: FAILED to place a reachable DHCPv6 accept in the live ruleset;" >&2
    echo "  $CONF is correct, so a reload/reboot would open it. Refusing to report success." >&2
    exit 1
  fi
  echo "host-migration: DHCPv6 replies accepted in the live ruleset"
fi

echo "host-migration 0003-dhcpv6-client-firewall: done."
