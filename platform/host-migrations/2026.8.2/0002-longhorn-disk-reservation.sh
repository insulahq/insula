#!/usr/bin/env bash
# idempotent: recomputes the same target from disk size and patches only when the current value differs by more than 1GiB, so a second run is a no-op
# allow-paths: (none — patches the longhorn.io Node CR through the kube API; writes no host files)
set -euo pipefail

# Right-size Longhorn's per-disk storageReserved.
#
# Longhorn reserves 30% of the DEFAULT disk, and our data path is Longhorn's
# default /var/lib/longhorn — i.e. the node's ROOT filesystem, shared with the
# OS, container images, kubelet ephemeral storage and logs. Reserving space
# there is correct: if Longhorn filled the root disk you would not lose
# Longhorn, you would lose the NODE.
#
# But 30% is the wrong SHAPE of number. What it protects — OS, images, logs — is
# roughly constant, while a percentage scales with the disk. On this platform's
# 80 GB reference node 30% is 24 GB and well judged; on a 500 GB root disk the
# same rule reserves 150 GB to protect a need that barely grew.
#
# The size-correct rule, and why each term exists:
#
#   reserved = 10% of capacity   <- MUST track kubelet's eviction floor.
#                                   eviction-hard sets nodefs.available<10%
#                                   (50-memory-protection.yaml). Reserve LESS
#                                   than that and Longhorn schedules replicas
#                                   into space kubelet treats as its own
#                                   reserve; the node then sits in permanent
#                                   DiskPressure that eviction CANNOT clear,
#                                   because evicting pods does not delete
#                                   replica data.
#            + 20 GiB            <- OS + container images + logs. Near constant,
#                                   hence an absolute term rather than a share.
#
# ...then clamped to Longhorn's own 30%, so this can only ever REDUCE:
#
#    disk    today(30%)      new     returned
#    40 GB       12 GiB   12 GiB       0   (clamped — small nodes unchanged)
#    80 GB       24 GiB   24 GiB       0   (clamped — the reference node)
#   200 GB       60 GiB   40 GiB      20 GiB
#   500 GB      150 GiB   70 GiB      80 GiB
#     2 TB      614 GiB  225 GiB     390 GiB

KUBECONFIG_PATH=/etc/rancher/k3s/k3s.yaml
if [ ! -r "$KUBECONFIG_PATH" ]; then
  echo "0002-longhorn-disk-reservation: no kubeconfig at ${KUBECONFIG_PATH} — agent node, skipping."
  exit 0
fi
export KUBECONFIG="$KUBECONFIG_PATH"

if ! command -v kubectl >/dev/null 2>&1; then
  echo "0002-longhorn-disk-reservation: kubectl not found — skipping." >&2
  exit 0
fi

if ! kubectl get crd nodes.longhorn.io >/dev/null 2>&1; then
  echo "0002-longhorn-disk-reservation: Longhorn not installed (--skip-longhorn?) — nothing to do."
  exit 0
fi

TOLERANCE=$((1024 * 1024 * 1024))       # 1 GiB — never churn the CR over rounding
CONSTANT=$((20 * 1024 * 1024 * 1024))   # 20 GiB for OS + images + logs
gib() { echo $(( $1 / 1024 / 1024 / 1024 )); }
changed=0

for node in $(kubectl -n longhorn-system get nodes.longhorn.io -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
  disks=$(kubectl -n longhorn-system get nodes.longhorn.io "$node" \
            -o go-template='{{range $k, $v := .spec.disks}}{{$k}}{{"\n"}}{{end}}' 2>/dev/null || true)
  for disk in $disks; do
    [ -n "$disk" ] || continue
    max=$(kubectl -n longhorn-system get nodes.longhorn.io "$node" \
            -o jsonpath="{.status.diskStatus.${disk}.storageMaximum}" 2>/dev/null || echo "")
    cur=$(kubectl -n longhorn-system get nodes.longhorn.io "$node" \
            -o jsonpath="{.spec.disks.${disk}.storageReserved}" 2>/dev/null || echo "")
    case "$max" in ''|*[!0-9]*) continue ;; esac
    [ "$max" -gt 0 ] || continue
    case "$cur" in ''|*[!0-9]*) cur=0 ;; esac

    target=$(( max / 10 + CONSTANT ))
    # Clamp to Longhorn's own 30% default, so this migration can only ever
    # REDUCE a reservation, never raise one.
    #
    # Without the clamp the 20 GiB constant dominates on small disks and the
    # rule turns against itself: a 40 GB VM-tier root disk would go from 12 GiB
    # reserved to 24 GiB, halving usable storage on exactly the nodes that have
    # least to spare. The constant is calibrated for real nodes; on small ones
    # Longhorn's percentage is already the tighter bound.
    ceiling=$(( max * 30 / 100 ))
    if [ "$target" -gt "$ceiling" ]; then target=$ceiling; fi

    if [ "$cur" -gt "$target" ]; then diff=$(( cur - target )); else diff=$(( target - cur )); fi
    if [ "$diff" -le "$TOLERANCE" ]; then
      echo "0002-longhorn-disk-reservation: ${node}/${disk} already ~$(gib "$target")GiB — no change."
      continue
    fi

    echo "0002-longhorn-disk-reservation: ${node}/${disk} storageReserved $(gib "$cur")GiB -> $(gib "$target")GiB (disk $(gib "$max")GiB)."
    kubectl -n longhorn-system patch nodes.longhorn.io "$node" --type=merge \
      -p "{\"spec\":{\"disks\":{\"${disk}\":{\"storageReserved\":${target}}}}}" >/dev/null
    changed=1
  done
done

if [ "$changed" -eq 0 ]; then
  echo "0002-longhorn-disk-reservation: all disks already right-sized."
fi
exit 0
