#!/usr/bin/env bash
# idempotent: no-op once the tigera-operator Deployment already runs the v3.32.1
#   image. The guard reads the operator image and skips when it already matches;
#   `kubectl apply --server-side` of an unchanged manifest is itself a no-op.
#   Runs on CONTROL-PLANE nodes only (needs the admin kubeconfig; workers hold
#   only the least-privilege host-config kubeconfig and exit 0 without acting).
#   Concurrent CP runs converge (server-side apply is declarative).
# allow-paths: none — operates solely on the cluster via kubectl + the node
#   kubeconfig. Writes no managed host files.
set -euo pipefail

# Backfills the Calico bump onto EXISTING clusters. bootstrap.sh applies the
# v3.32.1 tigera-operator manifest on FRESH clusters (install_calico); this is the
# one-time in-place upgrade for clusters bootstrapped before the bump (ADR-045
# W10c; ci-migration-coverage.sh requires this migration to accompany the
# bootstrap.sh CALICO_VERSION change):
#   - Calico v3.31.6 -> v3.32.1 (tigera-operator). No breaking notes in v3.32.
#
# HOW: apply the new tigera-operator.yaml (server-side, as bootstrap does) — this
# rolls the operator, which then reconciles calico-node/typha/kube-controllers to
# the new version. The Installation/APIServer CRs are unchanged (the operator IMAGE
# determines the Calico version), so we do not touch them.
#
# Blast radius (documented, by design): the operator performs a rolling update of
# the calico-node DaemonSet (one node at a time); per-node dataplane blips briefly
# as felix restarts, but existing flows and the CNI plugin persist across the roll.

# --- resolve an ADMIN kubeconfig (control-plane only) ---
if [ -r /etc/rancher/k3s/k3s.yaml ]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
else
  echo "calico-3-32-bump: no admin kubeconfig on this node (worker/least-priv) — skipping."
  exit 0
fi

# --- resolve kubectl (k3s ships it at /usr/local/bin/kubectl) ---
KUBECTL=""
for k in kubectl /usr/local/bin/kubectl /usr/local/bin/k3s; do
  if command -v "$k" >/dev/null 2>&1; then
    case "$k" in *k3s) KUBECTL="$k kubectl" ;; *) KUBECTL="$k" ;; esac
    break
  fi
done
[ -n "$KUBECTL" ] || { echo "calico-3-32-bump: kubectl not found on PATH — skipping." >&2; exit 0; }

TARGET_VER="v3.32.1"
MANIFEST="https://raw.githubusercontent.com/projectcalico/calico/${TARGET_VER}/manifests/tigera-operator.yaml"

# Skip if the operator Deployment isn't installed here, or already at target.
cur_img=$($KUBECTL -n tigera-operator get deploy tigera-operator \
  -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)
if [ -z "$cur_img" ]; then
  echo "calico-3-32-bump: tigera-operator not installed here — skipping (migration never first-installs Calico)."
  exit 0
fi
case "$cur_img" in
  *"$TARGET_VER")
    echo "calico-3-32-bump: tigera-operator already at ${TARGET_VER} (${cur_img}) — nothing to do."
    exit 0 ;;
esac

echo "calico-3-32-bump: applying tigera-operator ${TARGET_VER} (current operator ${cur_img}) ..."
$KUBECTL apply --server-side --force-conflicts -f "$MANIFEST"
$KUBECTL -n tigera-operator rollout status deploy/tigera-operator --timeout=300s || true

echo "calico-3-32-bump: tigera-operator now at ${TARGET_VER} (operator reconciles calico-node to match)."
exit 0
