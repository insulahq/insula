#!/usr/bin/env bash
# idempotent: no-op once kube-system/snapshot-controller carries the v8 pod
#   selector (app.kubernetes.io/name) — the guard below exits 0. The CRD / RBAC
#   / controller applies are declarative and the pre-v7 Deployment delete is
#   guarded to the old selector, so re-runs AND concurrent control-plane runs
#   converge on the same v8 state. Worker nodes hold only the least-privilege
#   host-config kubeconfig (get on 5 ConfigMaps), so reading the Deployment is
#   forbidden there and the script exits 0 without acting — the upgrade is driven
#   from the control-plane node(s) only.
# allow-paths: none — operates solely on the cluster via the node kubeconfig;
#   writes no host files.
set -euo pipefail

# Backfills external-snapshotter v6.x -> v8.6.0 onto EXISTING clusters. bootstrap.sh
# installs v8.6.0 on FRESH clusters (install_longhorn snapshot step); this is the
# one-time upgrade for nodes bootstrapped before the bump. Why it is safe:
#   - v8 requires k8s >= 1.25 (CRD CEL validation); all supported clusters run >= 1.33.
#   - The VolumeSnapshot storage version has been v1 since external-snapshotter v4.1
#     and no v1beta1 objects exist (CRDs already serve v1 only) — the CRD apply is
#     purely additive.
#   - VolumeGroupSnapshot CRDs are intentionally omitted (the controller is Ready on
#     the v1 VolumeSnapshot CRD set alone; group snapshots stay disabled).
# Mirrors scripts/bootstrap.sh install_longhorn. Underpins CNPG snapshot-PITR + the
# Longhorn VolumeSnapshotClass.

SNAP_VER="v8.6.0"
BASE="https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/${SNAP_VER}"

# Resolve a kubeconfig: control-plane admin first, then the worker least-privilege
# one written by the host-config-kubeconfig DaemonSet. (The runner gives us a clean
# env — PATH + HOME only — so we resolve our own KUBECONFIG, never inherit one.)
KCFG=""
for c in /etc/rancher/k3s/k3s.yaml /etc/platform/host-config/kubeconfig; do
  [ -r "$c" ] && { KCFG="$c"; break; }
done
[ -n "$KCFG" ] || { echo "snapshotter-v8: no readable kubeconfig on this node — skipping."; exit 0; }
export KUBECONFIG="$KCFG"

# Prefer k3s' bundled kubectl. Array form keeps the multi-word command shellcheck-safe.
if command -v k3s >/dev/null 2>&1; then
  KUBECTL=(k3s kubectl)
else
  KUBECTL=(kubectl)
fi

# Scope + idempotency guard: can this node read the controller, and is it already v8?
# A read failure means a worker (least-priv, forbidden) or an unreachable API — either
# way this node must not act. The v8 selector means a prior run / another CP node
# already upgraded it.
if ! sel=$("${KUBECTL[@]}" -n kube-system get deploy snapshot-controller \
             -o jsonpath='{.spec.selector.matchLabels.app\.kubernetes\.io/name}' 2>/dev/null); then
  echo "snapshotter-v8: cannot read kube-system/snapshot-controller here (worker/least-priv or API unreachable) — skipping."
  exit 0
fi
if [ "$sel" = "snapshot-controller" ]; then
  echo "snapshotter-v8: snapshot-controller already on the v8 selector — nothing to do."
  exit 0
fi

echo "snapshotter-v8: upgrading external-snapshotter to ${SNAP_VER} ..."

# external-snapshotter v7+ renamed the controller's pod selector
# (app -> app.kubernetes.io/name). spec.selector is IMMUTABLE, so a plain apply
# over the pre-v7 Deployment fails ("field is immutable"). Delete it first so the
# apply recreates it — safe: snapshot-controller is a stateless, leader-elected
# control loop and the VolumeSnapshot* CRD objects it reconciles persist
# independently.
if "${KUBECTL[@]}" -n kube-system get deploy snapshot-controller >/dev/null 2>&1; then
  "${KUBECTL[@]}" -n kube-system delete deploy snapshot-controller --ignore-not-found
fi

for f in \
  client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml \
  client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml \
  client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml \
  deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml \
  deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml; do
  if ! "${KUBECTL[@]}" apply -f "${BASE}/${f}"; then
    echo "snapshotter-v8: failed to apply ${f} (check outbound HTTPS to raw.githubusercontent.com)." >&2
    exit 1
  fi
done

"${KUBECTL[@]}" -n kube-system rollout status deploy/snapshot-controller --timeout=120s
img=$("${KUBECTL[@]}" -n kube-system get deploy snapshot-controller \
        -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)
echo "snapshotter-v8: external-snapshotter upgraded to ${SNAP_VER} (controller image ${img})."
exit 0
