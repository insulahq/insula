#!/usr/bin/env bash
# description: dual-stack clusters — open UDP/51822 and switch Calico's IPv6 pod traffic between nodes to WireGuard (it was dropped)
# idempotent: no-op once /etc/nftables.conf declares the 51822 accept AND the live
#   input chain carries it ahead of the catch-all drop, and (control-plane nodes)
#   FelixConfiguration/default already has wireguardEnabledV6=true on 51822. A
#   node without IPv6 pod networking (no IPv6 pod-CIDR rule in its ruleset and no
#   Calico IPv6 interface) exits 0 untouched.
#   A partially-applied node (file written, live insert failed) redoes the
#   idempotent work rather than passing the guard on the file alone.
# allow-paths: /etc/nftables.conf
# blocks-on-failure: no     # ADR-056: opens a firewall port + a Calico setting; nothing later depends on it
# phase: before-services    # ADR-064: needs nothing from the new release
set -euo pipefail
#
# Cross-node IPv6 between pods never worked on a dual-stack cluster.
#
# bootstrap.sh enabled Calico WireGuard for IPv4 only (wireguardEnabled, UDP/51821).
# With no wireguardEnabledV6, Calico carries IPv6 pod traffic between nodes as
# plain VXLAN over the nodes' IPv6 addresses (vxlan-v6.calico, UDP/4789). Calico
# marks that traffic untracked in the raw table, so `ct state established` never
# matches it, and the host firewall's input chain has no 4789 accept — the catch-all
# drop takes every packet. Measured on production 2026-10-16: pods on one node
# could not reach pods on another over IPv6 at all (CoreDNS's IPv6 service address
# included), while IPv4 — inside WireGuard on 51821 — worked.
#
# The fix is the IPv4 design applied to IPv6: WireGuard on UDP/51822 (51820 is
# NetBird's, 51821 Calico IPv4), with the same exposure as 51821 — public (public-key
# auth) unless the node was bootstrapped --calico-wg-public=false, in which case it
# is scoped to trusted_ranges_v6. NOT an accept for 4789: that would carry pod
# traffic unencrypted between nodes over the internet.
#
# bootstrap.sh renders both for FRESH dual-stack installs (ADR-045 W10c); this is
# the backfill for existing ones. firewall-reconciler owns runtime sets, not the
# static chain shape, so it cannot do the firewall half.
#
# Order across nodes does not matter: until a node has opened 51822, IPv6 pod
# traffic to it is dropped — exactly as it is today — and it starts flowing as each
# node's migration lands.

CONF=/etc/nftables.conf
PORT=51822

if [[ ! -f "$CONF" ]]; then
  echo "host-migration: $CONF absent — node not on the standard nft firewall; skipping."
  exit 0
fi

# ── Dual-stack? ───────────────────────────────────────────────────────────────
# bootstrap.sh renders the IPv6 pod-CIDR control-plane accept only under
# --dual-stack (the same anchor 2026.8.3/0003-pod-cidr-dns-firewall.sh uses).
# awk, not grep|awk: no match must not trip pipefail.
POD_CIDR_V6="$(awk '/ip6 saddr [0-9a-fA-F:]/ && /6443/ { print $3; exit }' "$CONF")"
# A node that joined a dual-stack cluster WITHOUT --dual-stack has no IPv6 pod-CIDR
# rule but still carries IPv6 pod traffic once Calico runs it (vxlan-v6.calico /
# wireguard-v6.cali exist): it needs the port as much as any other node.
calico_v6_iface=""
for i in vxlan-v6.calico wireguard-v6.cali; do
  if ip link show "$i" >/dev/null 2>&1; then calico_v6_iface="$i"; break; fi
done
if [[ -z "$POD_CIDR_V6" && -z "$calico_v6_iface" ]]; then
  echo "host-migration: no IPv6 pod networking on this node (no IPv6 pod CIDR in $CONF, no Calico IPv6 interface) — nothing to do."
  exit 0
fi
if [[ -z "$POD_CIDR_V6" ]]; then
  echo "host-migration: $CONF has no IPv6 pod-CIDR rule but Calico runs IPv6 here (${calico_v6_iface}) —"
  echo "  this node joined a dual-stack cluster without --dual-stack; opening ${PORT} anyway."
fi

# ── The rule, with 51821's exposure ───────────────────────────────────────────
if grep -qE '^[[:space:]]*udp dport 51821 accept' "$CONF"; then
  RULE="udp dport ${PORT} accept"
elif grep -qF 'ip6 saddr @trusted_ranges_v6 udp dport 51821 accept' "$CONF"; then
  RULE="ip6 saddr @trusted_ranges_v6 udp dport ${PORT} accept"
else
  echo "host-migration: no Calico WireGuard (51821) accept in $CONF — refusing to guess" >&2
  echo "  this node's exposure for ${PORT}. Inspect the input chain manually." >&2
  exit 1
fi

# The live input chain with handles — fails LOUDLY: under pipefail a failing `nft`
# inside a command substitution would otherwise end the script without a word.
live_chain_handles() {
  if ! nft -a list chain inet filter input 2>/dev/null; then
    echo "host-migration: cannot list 'inet filter input' — nftables not loaded on this node?" >&2
    return 1
  fi
}

# Trailing catch-all drop, matched in its LIVE rendering (`nft list` adds counters).
drop_handle() {
  local chain
  chain="$(live_chain_handles)" || return 1
  awk '/^[[:space:]]*counter( packets [0-9]+ bytes [0-9]+)? drop[[:space:]]*#[[:space:]]*handle [0-9]+$/ { print $NF; exit }' <<<"$chain"
}

# An accept is only EFFECTIVE before the catch-all drop.
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
  echo "host-migration: removed a dead ${PORT} accept that sat after the catch-all drop"
}

# ── 1. Persist into /etc/nftables.conf ────────────────────────────────────────
if ! grep -qF "$RULE" "$CONF"; then
  # Beside $CONF, so the final mv is an atomic rename on the same filesystem — a
  # crash mid-write never leaves a truncated ruleset for the next boot.
  tmp="$(mktemp "${CONF}.tmp.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  # Beside the 51821 rule(s): after the LAST line mentioning it.
  anchor="$(awk '/udp dport 51821 accept/ { n = NR } END { if (n) print n }' "$CONF")"
  {
    head -n "$anchor" "$CONF"
    echo "    ${RULE}   # Calico WireGuard, IPv6 (host-migration 0001-calico-wireguard-ipv6.sh)"
    tail -n +"$((anchor + 1))" "$CONF"
  } > "$tmp"
  # NEVER install an unvalidated ruleset — a broken nftables.conf locks the node
  # out on next boot.
  if ! nft -c -f "$tmp" >/dev/null 2>&1; then
    echo "host-migration: generated ruleset failed 'nft -c' validation — not applying." >&2
    nft -c -f "$tmp" >&2 || true
    exit 1
  fi
  chmod --reference="$CONF" "$tmp"
  mv -f "$tmp" "$CONF"
  echo "host-migration: added '${RULE}' to $CONF"
fi

# ── 2. Apply to the running kernel ────────────────────────────────────────────
# One rule, not a ruleset reload: a reload flushes the reconciler-owned sets
# (tenant_ports_*, blacklist_v*, cluster_peers_*) until it re-converges.
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
    echo "host-migration: FAILED to place a reachable '${RULE}' in the live ruleset;" >&2
    echo "  $CONF is correct, so a reload/reboot would open it. Refusing to report success." >&2
    exit 1
  fi
  echo "host-migration: opened ${PORT}/udp in the live ruleset"
fi

# ── 3. Calico: WireGuard for IPv6 (control-plane nodes; cluster-wide setting) ──
if [[ ! -r /etc/rancher/k3s/k3s.yaml ]]; then
  echo "host-migration: no admin kubeconfig (worker) — firewall done; Calico is set from a control-plane node."
  echo "host-migration 0001-calico-wireguard-ipv6: done."
  exit 0
fi
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
KUBECTL=""
for k in kubectl /usr/local/bin/kubectl /usr/local/bin/k3s; do
  if command -v "$k" >/dev/null 2>&1; then
    case "$k" in *k3s) KUBECTL="$k kubectl" ;; *) KUBECTL="$k" ;; esac
    break
  fi
done
if [[ -z "$KUBECTL" ]]; then
  echo "host-migration: kubectl not found — cannot enable Calico WireGuard for IPv6 from this node." >&2
  exit 1
fi

# The cluster, not this node's file, decides: an IPv6 IPPool means dual-stack pods.
if ! pools="$($KUBECTL get ippools.projectcalico.org -o jsonpath='{range .items[*]}{.spec.cidr}{"\n"}{end}')"; then
  echo "host-migration: cannot read Calico IPPools — firewall done, Calico NOT changed; re-run when the API answers." >&2
  exit 1
fi
if [[ "$pools" != *:* ]]; then
  echo "host-migration: no IPv6 IPPool in the cluster — leaving Calico as it is."
  echo "host-migration 0001-calico-wireguard-ipv6: done."
  exit 0
fi

if ! cur="$($KUBECTL get felixconfigurations.projectcalico.org default \
  -o jsonpath='{.spec.wireguardEnabledV6}/{.spec.wireguardListeningPortV6}')"; then
  echo "host-migration: cannot read FelixConfiguration/default — firewall done, Calico NOT changed." >&2
  exit 1
fi
if [[ "$cur" == "true/${PORT}" ]]; then
  echo "host-migration: Calico WireGuard for IPv6 already on (port ${PORT})."
else
  $KUBECTL patch felixconfigurations.projectcalico.org default --type merge \
    -p "{\"spec\":{\"wireguardEnabledV6\":true,\"wireguardListeningPortV6\":${PORT}}}"
  echo "host-migration: Calico WireGuard for IPv6 enabled on ${PORT} (was '${cur}')"
fi

echo "host-migration 0001-calico-wireguard-ipv6: done."
