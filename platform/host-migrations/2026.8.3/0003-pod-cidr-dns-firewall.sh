#!/usr/bin/env bash
# idempotent: no-op once /etc/nftables.conf declares the pod-CIDR DNS accepts
#   AND the live input chain carries them ahead of the catch-all drop (fresh
#   installs render both via bootstrap.sh). Re-running after success hits the
#   guard. A partially-applied node (file written, live insert failed) re-does
#   the idempotent work rather than passing the guard on the file alone.
# allow-paths: /etc/nftables.conf
# blocks-on-failure: yes    # ADR-056: 'no' iff NOTHING later depends on this script
#
# Opens :53 from the pod CIDR to the node on existing clusters.
#
# CoreDNS runs `dnsPolicy: Default` and forwards whatever it cannot answer to
# the node's /etc/resolv.conf. When a mesh client owns that file the upstream is
# a HOST-LOCAL address: NetBird rewrites resolv.conf to its own interface IP on
# hosts that have neither resolvconf nor systemd-resolved for it to integrate
# with (where either is present it only adds its search domain and leaves the
# real nameservers alone — which is why this stays dormant on most nodes).
# CoreDNS's upstream queries then arrive at the INPUT chain with a POD source IP
# and fall through to the catch-all drop.
#
# The failure is total, not merely slow: pods inherit the mesh search domain, so
# any in-pod getaddrinfo for a name with fewer dots than `ndots` tries
# `<name>.<mesh-domain>` FIRST, that query blackholes, and glibc aborts the whole
# search with EAI_AGAIN (it walks past NXDOMAIN, but not past a timeout).
# platform-api then crashloops in wait-for-db against a healthy Postgres.
#
# Latent by nature: resolv.conf is snapshotted into a pod at CREATION, so
# already-running CoreDNS pods keep the pre-mesh upstream and the cluster looks
# healthy until something recreates them — a k3s restart re-applying its
# packaged coredns.yaml is enough, which is exactly how this first surfaced.
#
# bootstrap.sh renders these accepts for FRESH installs only (ADR-045 W10c), so
# existing clusters need this backfill. firewall-reconciler cannot do it: it
# owns runtime sets (tenant_ports_*, blacklist_v*, cluster_peers_*), not the
# static chain shape.
set -euo pipefail

CONF=/etc/nftables.conf

# Nodes not on the standard nft ruleset (a firewall mode that never wrote the
# file) have nothing to backfill. Not an error.
if [[ ! -f "$CONF" ]]; then
  echo "host-migration: $CONF absent — node not on the standard nft firewall; skipping."
  exit 0
fi

# ── Derive the pod CIDRs from the node's OWN ruleset ──────────────────────────
# NEVER hardcode 10.42.0.0/16: --cluster-cidr is operator-settable, and a
# mismatched literal would write a rule that silently matches nothing. The
# pod-CIDR control-plane exemption bootstrap.sh already rendered is the anchor,
# so whatever CIDR this node actually uses is the CIDR we reuse.
#
# Extracted with awk, NOT `grep … | awk`: on a single-stack node the v6 grep
# matches nothing and exits 1, and under `set -o pipefail` that failure
# propagates out of the command substitution into `set -e`, killing the script
# before the empty-check below can report anything. awk exits 0 on no-match.
#
# The `[0-9]` / `[0-9a-fA-F:]` after `saddr ` is what separates the pod-CIDR
# literal from the `ip saddr @cluster_peers_v4` rule that carries the identical
# port list two lines further down.
POD_CIDR_V4="$(awk '/ip saddr [0-9]/ && /6443/ { print $3; exit }' "$CONF")"
POD_CIDR_V6="$(awk '/ip6 saddr [0-9a-fA-F:]/ && /6443/ { print $3; exit }' "$CONF")"

if [[ -z "$POD_CIDR_V4" ]]; then
  echo "host-migration: could not find the pod-CIDR control-plane accept in $CONF —" >&2
  echo "  refusing to guess this node's pod CIDR. Inspect the input chain manually." >&2
  exit 1
fi

# Handle of the input chain's trailing catch-all drop.
#
# NOTE the rendering gap: bootstrap.sh WRITES `counter drop`, but `nft list`
# RENDERS it with its counters — `counter packets 285788 bytes 17211258 drop`.
# Matching the literal source text finds nothing in the live chain, which is how
# a rule ends up appended AFTER the drop: dead, while the migration reports
# success. Match the LIVE rendering, with the counters optional.
drop_handle() {
  nft -a list chain inet filter input 2>/dev/null \
    | awk '/^[[:space:]]*counter( packets [0-9]+ bytes [0-9]+)? drop[[:space:]]*#[[:space:]]*handle [0-9]+$/ { print $NF; exit }'
}

# An accept is only EFFECTIVE if it precedes the catch-all drop. Existence is not
# enough — an accept after the drop is unreachable.
# Args: <family: ip|ip6> <cidr> <proto: udp|tcp>
live_accept_effective() {
  local fam="$1" cidr="$2" proto="$3" chain accept_line drop_line
  chain="$(nft list chain inet filter input 2>/dev/null)" || return 1
  accept_line="$(awk -v pat="${fam} saddr ${cidr} ${proto} dport 53 accept" \
    'index($0, pat) { print NR; exit }' <<<"$chain")"
  drop_line="$(awk '/^[[:space:]]*counter( packets [0-9]+ bytes [0-9]+)? drop[[:space:]]*$/ { print NR; exit }' <<<"$chain")"
  [[ -n "$accept_line" && -n "$drop_line" && "$accept_line" -lt "$drop_line" ]]
}

conf_has_accept() {
  local fam="$1" cidr="$2" proto="$3"
  grep -qF "${fam} saddr ${cidr} ${proto} dport 53 accept" "$CONF"
}

# Delete an accept that exists but sits after the drop, so it can be re-inserted
# in the right place (self-heals a node left half-fixed by a manual attempt).
delete_dead_accept() {
  local fam="$1" cidr="$2" proto="$3" h
  h="$(nft -a list chain inet filter input 2>/dev/null \
       | awk -v pat="${fam} saddr ${cidr} ${proto} dport 53 accept" \
         'index($0, pat) && /#[[:space:]]*handle [0-9]+$/ { print $NF; exit }')"
  [[ -n "$h" ]] || return 0
  nft delete rule inet filter input handle "$h" 2>/dev/null || true
  echo "host-migration: removed a dead ${fam} ${proto}/53 accept that sat after the catch-all drop"
}

# Families present on this node: v6 only when the ruleset is dual-stack.
# NOTE: written as a full `if`, not `[[ … ]] && families+=(…)`. Under `set -e` a
# trailing test that evaluates false is a failing command at top level and kills
# the script SILENTLY — on a single-stack node (the common case) that exited 1
# before doing any work while printing nothing at all.
families=("ip:$POD_CIDR_V4")
if [[ -n "$POD_CIDR_V6" ]]; then
  families+=("ip6:$POD_CIDR_V6")
fi

all_done=1
for entry in "${families[@]}"; do
  fam="${entry%%:*}" cidr="${entry#*:}"
  for proto in udp tcp; do
    conf_has_accept "$fam" "$cidr" "$proto" \
      && live_accept_effective "$fam" "$cidr" "$proto" || all_done=0
  done
done
if (( all_done )); then
  echo "host-migration: pod-CIDR DNS already open in config + kernel; nothing to do."
  exit 0
fi

# ── 1. Persist into /etc/nftables.conf ────────────────────────────────────────
# Anchor after the pod-CIDR control-plane accept — the rule these belong beside,
# and the same rule the CIDRs were derived from. Anchoring to a rule (not a line
# number) keeps this stable across bootstrap edits.
needs_conf=0
for entry in "${families[@]}"; do
  fam="${entry%%:*}" cidr="${entry#*:}"
  for proto in udp tcp; do
    conf_has_accept "$fam" "$cidr" "$proto" || needs_conf=1
  done
done

if (( needs_conf )); then
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  # Insert after the LAST pod-CIDR control-plane accept (v6 follows v4 on
  # dual-stack), so both families' DNS rules land together in the right block.
  last_cp="$(awk '/6443/ && (/ip saddr [0-9]/ || /ip6 saddr [0-9a-fA-F:]/) { n = NR } END { if (n) print n }' "$CONF")"
  if [[ -z "$last_cp" ]]; then
    echo "host-migration: lost the pod-CIDR anchor while rewriting $CONF — not applying." >&2
    exit 1
  fi
  {
    head -n "$last_cp" "$CONF"
    echo ""
    echo "    # Pod CIDR → the node's own DNS resolver. CoreDNS (dnsPolicy: Default)"
    echo "    # forwards upstream to the node's /etc/resolv.conf; when a mesh client"
    echo "    # owns that file the upstream is a host-local address, so the query"
    echo "    # reaches INPUT with a pod source IP. Backfilled by host-migration"
    echo "    # 0003-pod-cidr-dns-firewall.sh."
    for entry in "${families[@]}"; do
      fam="${entry%%:*}" cidr="${entry#*:}"
      conf_has_accept "$fam" "$cidr" udp || echo "    ${fam} saddr ${cidr} udp dport 53 accept"
      conf_has_accept "$fam" "$cidr" tcp || echo "    ${fam} saddr ${cidr} tcp dport 53 accept"
    done
    tail -n +"$((last_cp + 1))" "$CONF"
  } > "$tmp"

  # NEVER install an unvalidated ruleset — a broken nftables.conf locks the node
  # out on next boot.
  if ! nft -c -f "$tmp" >/dev/null 2>&1; then
    echo "host-migration: generated ruleset failed 'nft -c' validation — not applying." >&2
    nft -c -f "$tmp" >&2 || true
    exit 1
  fi
  cp "$tmp" "$CONF"
  echo "host-migration: added pod-CIDR DNS accepts to $CONF"
fi

# ── 2. Apply to the running kernel ────────────────────────────────────────────
# Add the individual rules rather than reloading the whole ruleset: a full reload
# flushes the runtime-managed sets (tenant_ports_*, blacklist_v*, cluster_peers_*)
# that firewall-reconciler owns, briefly dropping tenant traffic and operator
# bans until it re-converges.
for entry in "${families[@]}"; do
  fam="${entry%%:*}" cidr="${entry#*:}"
  for proto in udp tcp; do
    # Same `set -e` trap as above: `cmd && continue` on the already-satisfied
    # path returns non-zero for the whole AND-list and would abort the loop.
    if live_accept_effective "$fam" "$cidr" "$proto"; then
      continue
    fi

    # An accept may exist but be unreachable (after the drop) — remove it first
    # so the re-insert lands in the right place instead of adding a duplicate.
    delete_dead_accept "$fam" "$cidr" "$proto"

    # Insert BEFORE the trailing catch-all drop so the accept is actually
    # reached. `nft add rule` APPENDS (after the drop) — a dead rule.
    handle="$(drop_handle)"
    if [[ -n "$handle" ]]; then
      nft insert rule inet filter input handle "$handle" "$fam" saddr "$cidr" "$proto" dport 53 accept
    else
      # No catch-all drop (non-standard chain, e.g. policy accept) — append is
      # then correct and reachable.
      nft add rule inet filter input "$fam" saddr "$cidr" "$proto" dport 53 accept
    fi

    # Never report success on a rule that is not actually reachable.
    if live_accept_effective "$fam" "$cidr" "$proto"; then
      echo "host-migration: opened ${fam} ${cidr} ${proto}/53 in the live ruleset"
    else
      echo "host-migration: FAILED to place a reachable ${fam} ${cidr} ${proto}/53 accept." >&2
      echo "  The persisted $CONF is correct, so a reload/reboot would open it;" >&2
      echo "  refusing to report success." >&2
      exit 1
    fi
  done
done

# NOTE: deliberately NOT recorded in /etc/hosting-platform/firewall.conf's
# PUBLIC_TCP_PORTS. That inventory drives the security-hardening posture report
# and means "open to the world"; :53 here is scoped to the pod CIDR, which is
# internal cluster traffic and not routable from outside. Listing it would
# over-report the node's public exposure.

echo "host-migration 0003-pod-cidr-dns-firewall: done."
