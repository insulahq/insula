#!/usr/bin/env bash
# description: Publish the node's own public address as its ExternalIP where none is set (public-underlay nodes without a global IPv6), so it serves ingress; restarts k3s once
# idempotent: acts only when neither the k3s unit nor its config sets node-external-ip; once the drop-in exists that no longer holds, so a re-run writes nothing and restarts nothing
# allow-paths: /etc/rancher/k3s/config.yaml.d/60-node-external-ip.yaml
# blocks-on-failure: no     # nothing later depends on it, and a failure rolls the drop-in back
# phase: before-services    # independent of the release's containers
#
# bootstrap.sh installed public-underlay nodes (no --cluster-network-cidr) with --node-external-ip
# only when the host had a global IPv6. An IPv4-only node, or one whose v6 is a ULA, registered
# with an InternalIP and no ExternalIP. The platform reads ExternalIP as "this node serves the
# public": ingress-nodes/discovery.ts builds the ingress addresses (and so the tenant apex records)
# from it, and the ingress-external-ips CronJob builds the Traefik Service's externalIPs from it.
# Those nodes therefore never served ingress; on lab staging the two servers that joined after
# the first had none. bootstrap.sh now writes this drop-in on every public-underlay node
# (write_node_external_ip_dropin); this gives existing nodes the same file.
#
# The address published is the node's own pinned --node-ip v4, and only when that is the address
# the host reaches the internet from (what bootstrap's detect_public_ipv4 picks), plus any GLOBAL
# v6 in --node-ip, never a ULA. A node whose --node-ip is a private or mesh address is left alone:
# publishing that address would send clients somewhere unreachable.
#
# k3s reads /etc/rancher/k3s/config.yaml.d/*.yaml on start, so the drop-in needs one k3s restart.
# Pods keep running through it (the unit is KillMode=process): a brief local kubelet/apiserver
# blip on the node being converged, the same class as the 2026.7.2/0001 memory-protection drop-in.
set -euo pipefail

# Test seams (scripts/test-host-migration-node-external-ip.sh); the runner sets none of them.
K3S_DIR=${HM_K3S_DIR:-/etc/rancher/k3s}
UNIT_DIR=${HM_UNIT_DIR:-/etc/systemd/system}
SYSTEMCTL=${HM_SYSTEMCTL:-systemctl}
IP=${HM_IP:-ip}
STEP=${HM_WAIT_STEP:-5}
read -ra KUBECTL <<<"${HM_KUBECTL:-k3s kubectl}"
# The runner gives a migration 10 minutes: 90 + 240 + 180 s leaves room for the polling steps.
QUORUM_WAIT=${HM_QUORUM_WAIT:-90}
RESTART_WAIT=${HM_RESTART_WAIT:-240}
ROLLBACK_WAIT=${HM_ROLLBACK_WAIT:-180}
DROPIN_DIR="$K3S_DIR/config.yaml.d"
DROPIN="$DROPIN_DIR/60-node-external-ip.yaml"
log() { echo "host-migration 0001-node-external-ip: $*"; }

if [[ ! -d "$K3S_DIR" ]]; then
  log "no k3s on this node — nothing to do."
  exit 0
fi

unit=""
for u in k3s k3s-agent; do
  if [[ -f "$UNIT_DIR/$u.service" ]]; then unit=$u; break; fi
done
if [[ -z "$unit" ]]; then
  log "no k3s or k3s-agent unit — nothing to do."
  exit 0
fi

unit_text=$(cat "$UNIT_DIR/$unit.service" "$UNIT_DIR/$unit.service.env" 2>/dev/null || true)
cfg_text=$(cat "$K3S_DIR/config.yaml" "$DROPIN_DIR"/*.yaml 2>/dev/null || true)

if grep -qE -- '--node-external-ip|K3S_NODE_EXTERNAL_IP' <<<"$unit_text" \
   || grep -qE '^[[:space:]]*node-external-ip[[:space:]]*:' <<<"$cfg_text"; then
  log "$unit already sets node-external-ip — nothing to do."
  exit 0
fi

# The pinned --node-ip, from the unit (k3s install.sh writes '--node-ip=<a>[,<b>]') or the config.
node_ip=$(grep -oE -- "--node-ip[= ]+['\"]?[0-9A-Fa-f.:,]+" <<<"$unit_text" | head -1 | sed -E "s/^--node-ip[= ]+['\"]?//" || true)
if [[ -z "$node_ip" ]]; then
  node_ip=$(grep -E '^[[:space:]]*node-ip[[:space:]]*:' <<<"$cfg_text" | head -1 | sed -E "s/^[^:]*:[[:space:]]*['\"]?//; s/['\"]?[[:space:]]*$//" || true)
fi
if [[ -z "$node_ip" ]]; then
  log "$unit pins no --node-ip, so the node's public address is not known here — left unchanged."
  exit 0
fi

v4="" v6=""
IFS=',' read -ra addrs <<<"$node_ip"
for a in "${addrs[@]}"; do
  a=${a// /}
  if [[ -z "$v4" && "$a" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
    v4=$a
  elif [[ -z "$v6" && "$a" == *:* ]]; then
    case "${a,,}" in
      fc*|fd*|fe8*|fe9*|fea*|feb*) ;;  # ULA / link-local: never published
      *) v6=$a ;;
    esac
  fi
done
if [[ -z "$v4" ]]; then
  log "--node-ip=${node_ip} has no IPv4 — left unchanged."
  exit 0
fi

# Public-underlay check: the pinned v4 must be the source address the host uses towards the
# internet, on a non-VPN interface (bootstrap's detect_public_ipv4, path A).
vpn_re='^(wt[0-9]*|tailscale[0-9]*|wg[0-9]*|tun[0-9]*|tap[0-9]*|ipsec[0-9]*|ppp[0-9]*|gre[0-9]*|cali[0-9a-f]+|vxlan\.calico|wireguard\.calico|wireguard\.cali)$'
egress_src="" egress_vpn=""
for probe in 1.1.1.1 8.8.8.8 9.9.9.9; do
  route=$("$IP" -4 -o route get "$probe" 2>/dev/null | head -1 || true)
  [[ -z "$route" ]] && continue
  dev=$(awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i+1); exit }}' <<<"$route")
  src=$(awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i+1); exit }}' <<<"$route")
  [[ -z "$dev" || -z "$src" ]] && continue
  if [[ "$dev" =~ $vpn_re ]]; then egress_vpn=$dev; continue; fi
  egress_src=$src
  break
done
if [[ -z "$egress_src" && -n "$egress_vpn" ]]; then
  log "this host reaches the internet through ${egress_vpn}, a VPN interface — not a public underlay; left unchanged."
  exit 0
fi
if [[ -z "$egress_src" ]]; then
  # No route at all: most likely the network is briefly down. Exiting 0 would mark the migration
  # done and never look again, so fail and let the next run retry (nothing later waits on it).
  log "no route towards the internet right now — cannot tell whether ${v4} is the public underlay; will retry."
  exit 1
fi
if [[ "$egress_src" != "$v4" ]]; then
  log "--node-ip ${v4} is not the address this host reaches the internet from (${egress_src}) — a private or mesh underlay; left unchanged."
  exit 0
fi
case "$v4" in
  10.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|192.168.*|100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*)
    # Published as is: on a LAN or lab install this IS the address clients use. Behind NAT it is
    # not, and no node can see its NAT address; the operator's ingress address override
    # (ingress_default_ipv4) always wins over the discovered one.
    log "note: ${v4} is a private address. If clients reach this node through NAT, set the ingress address in the admin panel (Cluster → Ingress & TLS); it overrides the discovered one." ;;
esac

# A k3s server's restart takes its etcd member away for a moment. Restart only while every other
# server is Ready, so two servers converging at once never cost the cluster its quorum.
others_not_ready() {
  "${KUBECTL[@]}" get nodes -l node-role.kubernetes.io/control-plane -o \
    jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.addresses[?(@.type=="InternalIP")].address}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' \
    2>/dev/null | awk -F'\t' -v me="$v4" '{ split($2, a, " "); if (a[1] != me && $3 != "True") print $1 }'
}
if [[ "$unit" == k3s ]]; then
  deadline=$((SECONDS + QUORUM_WAIT))
  while :; do
    if ! "${KUBECTL[@]}" get --raw /readyz >/dev/null 2>&1; then
      waiting="the API (not answering)"
    else
      waiting=$(others_not_ready | tr '\n' ' ')
    fi
    [[ -z "${waiting// /}" ]] && break
    if (( SECONDS >= deadline )); then
      log "waited ${QUORUM_WAIT} s for ${waiting% } — not restarting a server now; will retry."
      exit 1
    fi
    sleep "$STEP"
  done
fi

# Byte for byte what bootstrap.sh's write_node_external_ip_dropin writes on a fresh install.
want="# Written by bootstrap.sh and by host-migration 2026.11.2/0001-node-external-ip: the
# node's public-underlay address, published as its ExternalIP.
node-external-ip:
  - \"${v4}\"${v6:+
  - \"${v6}\"}"

install -d -m 0755 "$DROPIN_DIR"
printf '%s\n' "$want" > "$DROPIN.new"
mv -f "$DROPIN.new" "$DROPIN"
log "wrote $DROPIN (ExternalIP ${v4}${v6:+, ${v6}})."

if ! "$SYSTEMCTL" is-active --quiet "$unit"; then
  log "$unit is not running — the drop-in applies on its next start."
  exit 0
fi

# k3s's unit has no start timeout, so a blocking restart could outlive the runner's 10 minutes if
# the node cannot come back: restart without blocking and wait a bounded time instead. "active"
# only counts once the unit has re-entered it: right after a queued restart, is-active can still
# report the old run.
entered() { "$SYSTEMCTL" show -p ActiveEnterTimestampMonotonic --value "$unit" 2>/dev/null || true; }
wait_restarted() {  # <seconds> <entered-before>
  local deadline=$((SECONDS + $1)) state
  while (( SECONDS < deadline )); do
    state=$("$SYSTEMCTL" is-active "$unit" 2>/dev/null || true)
    [[ "$state" == active && "$(entered)" != "$2" ]] && return 0
    [[ "$state" == failed ]] && return 1
    sleep "$STEP"
  done
  return 1
}

log "restarting $unit — brief local kubelet/API blip, pods keep running."
before=$(entered)
"$SYSTEMCTL" restart --no-block "$unit"
if wait_restarted "$RESTART_WAIT" "$before"; then
  log "$unit is active again with ExternalIP ${v4}${v6:+, ${v6}}."
  exit 0
fi

log "$unit did not come back within ${RESTART_WAIT} s — removing the drop-in and restarting it as it was."
rm -f "$DROPIN"
before=$(entered)
"$SYSTEMCTL" restart --no-block "$unit"
if wait_restarted "$ROLLBACK_WAIT" "$before"; then
  log "rolled back: $unit is active again without the drop-in."
else
  log "rolled back the drop-in, but $unit is still not active — check 'journalctl -u $unit'."
fi
exit 1
