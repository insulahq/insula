#!/usr/bin/env bash
# idempotent: swapoff/fstab-comment only act when swap is actually present;
#   the k3s drop-in is content-compared and k3s(-agent) restarts ONLY when
#   the file changed. A re-run after success touches nothing and restarts
#   nothing.
# allow-paths: /etc/rancher/k3s/config.yaml.d/50-memory-protection.yaml /etc/fstab
#
# Node memory-pressure protection for EXISTING clusters (operator decision
# 2026-07-25; fresh installs get the identical config from bootstrap.sh
# configure_memory_protection):
#
#   1. Swap OFF. Etcd + CNPG Postgres + Longhorn share every node; paging
#      turns a fast, alertable pod OOM-kill into un-alertable node-wide
#      thrash — and with the default NoSwap kubelet behavior pods get no
#      swap anyway, so a swapfile only masks pressure from the eviction
#      manager. `platform-ops cluster doctor` flags swap-on as drift.
#
#   2. Earlier, tenant-first kubelet eviction: a k3s config.yaml.d drop-in
#      (read by BOTH k3s servers and k3s-agent workers; `kubelet-arg+:`
#      APPENDS to CLI-provided args) sets
#        eviction-hard=memory.available<256Mi,... (disk defaults restated —
#          eviction-hard REPLACES the kubelet default map and the platform
#          relies on DiskPressure eviction)
#        system-reserved=cpu=500m,memory=1Gi (shrinks Node Allocatable;
#          default enforceNodeAllocatable=pods, so no cgroup pressure on
#          host daemons)
#      Eviction ORDER (tenants first) comes from the platform-critical
#      PriorityClass Flux applies to system workloads — kubelet evicts
#      exceeds-requests pods by ascending priority; tenant pods run at 0.
#
# The k3s service restart (only when the drop-in changed) is a brief local
# kubelet/apiserver blip on the node being converged — pods keep running;
# same class of disruption as a k3s patch upgrade, applied per-node by the
# converger.
set -euo pipefail

DROPIN_DIR=/etc/rancher/k3s/config.yaml.d
DROPIN="$DROPIN_DIR/50-memory-protection.yaml"

# ── 1. Swap off ──────────────────────────────────────────────────────────
if [[ $(wc -l < /proc/swaps) -gt 1 ]]; then
  echo "host-migration: active swap detected — disabling (k8s nodes run swap-less)."
  swapoff -a
fi
if grep -qE '^[^#].*\bswap\b' /etc/fstab 2>/dev/null; then
  sed -i.platform-bak -E 's|^([^#].*\bswap\b.*)$|# disabled by insula host-migration 2026.7.2/0001 (k8s nodes run swap-less): \1|' /etc/fstab
  echo "host-migration: fstab swap entries commented (backup: /etc/fstab.platform-bak)."
fi

# ── 2. kubelet eviction + reservations drop-in ───────────────────────────
# Nodes without a k3s install dir have nothing to configure (not an error —
# the converger can run on hosts being decommissioned).
if [[ ! -d /etc/rancher/k3s ]]; then
  echo "host-migration: /etc/rancher/k3s absent — no k3s on this node; skipping."
  exit 0
fi

want=$(cat <<'EOF'
# Written by bootstrap.sh (configure_memory_protection) and converged on
# existing clusters by host-migration 2026.7.2/0001-node-memory-protection.
# kubelet-arg+ APPENDS to CLI-provided kubelet args.
# eviction-hard replaces the kubelet default map — disk-pressure
# defaults are deliberately restated.
kubelet-arg+:
  - eviction-hard=memory.available<256Mi,nodefs.available<10%,imagefs.available<15%,nodefs.inodesFree<5%
  - system-reserved=cpu=500m,memory=1Gi
EOF
)

if [[ -f "$DROPIN" ]] && [[ "$(cat "$DROPIN")" == "$want" ]]; then
  echo "host-migration: $DROPIN already current — nothing to do."
  exit 0
fi

install -d -m 0755 "$DROPIN_DIR"
printf '%s\n' "$want" > "$DROPIN"
echo "host-migration: wrote $DROPIN."

# Restart whichever k3s unit this node runs so the kubelet picks up the
# args. Only reached when the drop-in changed (see the guard above).
if systemctl is-active --quiet k3s 2>/dev/null; then
  echo "host-migration: restarting k3s (server) — brief local API blip, pods keep running."
  systemctl restart k3s
elif systemctl is-active --quiet k3s-agent 2>/dev/null; then
  echo "host-migration: restarting k3s-agent (worker)."
  systemctl restart k3s-agent
else
  echo "host-migration: no active k3s/k3s-agent unit — drop-in applies on next start."
fi

echo "host-migration: node memory protection converged (eviction-hard memory.available<256Mi, system-reserved 1Gi, swap off)."
