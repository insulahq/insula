#!/usr/bin/env bash
# description: Calico moves to v3.33.0 (tigera-operator v1.44.0): its CRDs, then the operator, which rolls calico-node, typha and kube-controllers node by node; the cluster keeps the Calico API mode it already uses.
# idempotent: the guard exits 0 when the tigera-operator Deployment runs v1.44.0 (the operator Calico 3.33.0 ships), every calico-node pod runs v3.33.0 and tigerastatus/calico is Available; `kubectl apply --server-side` of unchanged manifests is itself a no-op, and a run that finds the operator already upgraded only waits for the roll. Runs on CONTROL-PLANE nodes only (needs the admin kubeconfig; workers exit 0 without acting).
# allow-paths: none — operates solely on the cluster via kubectl + the node kubeconfig; the two manifests are downloaded to a private mktemp -d removed on EXIT.
# blocks-on-failure: yes   # ADR-056: a CNI mid-roll is no moment for the Longhorn upgrade (0008) to start rolling the storage data plane; later migrations wait until this one converges.
# phase: before-services    # ADR-064: the CNI upgrade needs nothing from the new release's manifests
set -euo pipefail

# Backfills the Calico bump onto EXISTING clusters. scripts/bootstrap.sh applies
# the v3.33.0 v1 CRDs + tigera-operator manifest on fresh clusters
# (install_calico); ci-migration-coverage.sh requires this migration to
# accompany the CALICO_VERSION change.
#
# HOW (Calico's documented operator upgrade): apply the projectcalico.org CRDs,
# then tigera-operator.yaml, both `--server-side --force-conflicts`. The new
# operator rolls calico-node, typha and kube-controllers itself; the
# Installation/APIServer CRs are unchanged.
#
# Mode: Calico serves projectcalico.org/v3 either through the aggregation API
# server over v1 CRDs (crd.projectcalico.org — every cluster installed before
# 3.33, and fresh installs too, which bootstrap keeps in that mode) or through
# native v3 CRDs. An upgrade never switches modes, and the CRD manifest must
# match the mode the cluster is in, so it is chosen from the CRDs present.
#
# 3.33's upgrade notes touch nothing here: no FIPS mode, no per-component image
# pins, VXLAN with BGP disabled. Kubernetes 1.35–1.37 is supported (k3s 1.36).
#
# Guard history: 2026.7.1/0006 compared the OPERATOR image with the Calico
# version (v3.32.1), which never matched (the operator is versioned apart —
# 3.32.1 ships operator v1.42.3); this one checks the operator's own version.
#
# Blast radius (by design): calico-node rolls one node at a time; each node's
# pod networking blips while its calico-node restarts (established connections
# usually survive — the dataplane stays programmed). Budget: operator 120s,
# image switch 90s, calico-node roll 240s, status 60s — inside the runner's
# 10 minutes; a run cut short re-waits on the next converge.

MIG="calico-3-33-bump"
TARGET_VER="v3.33.0"
TARGET_OPERATOR="v1.44.0"
BASE="https://raw.githubusercontent.com/projectcalico/calico/${TARGET_VER}/manifests"

if [ -r /etc/rancher/k3s/k3s.yaml ]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
else
  echo "${MIG}: no admin kubeconfig on this node (worker/least-priv) — skipping."
  exit 0
fi

KUBECTL=""
for k in kubectl /usr/local/bin/kubectl /usr/local/bin/k3s; do
  if command -v "$k" >/dev/null 2>&1; then
    case "$k" in *k3s) KUBECTL="$k kubectl" ;; *) KUBECTL="$k" ;; esac
    break
  fi
done
[ -n "$KUBECTL" ] || { echo "${MIG}: kubectl not found on PATH — skipping." >&2; exit 0; }

op_img="$($KUBECTL -n tigera-operator get deploy tigera-operator \
  -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
if [ -z "$op_img" ]; then
  echo "${MIG}: tigera-operator not installed here — skipping (migration never first-installs Calico)."
  exit 0
fi

node_img() {
  $KUBECTL -n calico-system get ds calico-node \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true
}
node_rolled() { # every calico-node pod updated and available
  local want updated avail
  want="$($KUBECTL -n calico-system get ds calico-node -o jsonpath='{.status.desiredNumberScheduled}' 2>/dev/null || echo x)"
  updated="$($KUBECTL -n calico-system get ds calico-node -o jsonpath='{.status.updatedNumberScheduled}' 2>/dev/null || echo y)"
  avail="$($KUBECTL -n calico-system get ds calico-node -o jsonpath='{.status.numberAvailable}' 2>/dev/null || echo z)"
  [ "$want" = "$updated" ] && [ "$want" = "$avail" ]
}
calico_available() {
  [ "$($KUBECTL get tigerastatus calico \
    -o jsonpath='{.status.conditions[?(@.type=="Available")].status}' 2>/dev/null || true)" = "True" ]
}

case "$op_img" in
  *":${TARGET_OPERATOR}")
    case "$(node_img)" in
      *":${TARGET_VER}")
        if node_rolled && calico_available; then
          echo "${MIG}: Calico already at ${TARGET_VER} (operator ${TARGET_OPERATOR}, calico-node rolled, Available) — nothing to do."
          exit 0
        fi ;;
    esac
    echo "${MIG}: operator already ${TARGET_OPERATOR}; waiting for Calico to finish rolling …"
    ;;
  *)
    # The CRD manifest must match the mode the cluster runs in.
    has_v1=0; has_v3=0
    $KUBECTL get crd ippools.crd.projectcalico.org >/dev/null 2>&1 && has_v1=1
    $KUBECTL get crd ippools.projectcalico.org >/dev/null 2>&1 && has_v3=1
    case "${has_v1}${has_v3}" in
      10) crd_file="v1_crd_projectcalico_org.yaml" ;;
      01) crd_file="v3_projectcalico_org.yaml" ;;
      11)
        echo "${MIG}: both ippools.crd.projectcalico.org (API-server mode) and ippools.projectcalico.org (native v3 CRDs) exist — a half-finished mode migration? Refusing to guess which CRDs to apply." >&2
        exit 1 ;;
      *)
        echo "${MIG}: neither ippools.crd.projectcalico.org nor ippools.projectcalico.org exists — cannot tell Calico's API mode; refusing to guess." >&2
        exit 1 ;;
    esac

    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    for f in "$crd_file" tigera-operator.yaml; do
      if ! curl --retry 3 --retry-delay 2 --retry-connrefused --connect-timeout 10 --max-time 90 -fsSL -o "$TMP/$f" "${BASE}/${f}"; then
        echo "${MIG}: could not download ${BASE}/${f} — will retry on the next converge." >&2
        exit 1
      fi
      [ -s "$TMP/$f" ] || { echo "${MIG}: ${f} downloaded empty — will retry on the next converge." >&2; exit 1; }
    done

    echo "${MIG}: applying Calico ${TARGET_VER} CRDs (${crd_file}) and tigera-operator (current operator ${op_img}) …"
    $KUBECTL apply --server-side --force-conflicts -f "$TMP/$crd_file" >/dev/null
    $KUBECTL apply --server-side --force-conflicts -f "$TMP/tigera-operator.yaml" >/dev/null
    if ! $KUBECTL -n tigera-operator rollout status deploy/tigera-operator --timeout=120s >/dev/null; then
      echo "${MIG}: tigera-operator did not become ready within 120s — the next converge re-checks." >&2
      exit 1
    fi
    ;;
esac

# --- wait for the operator to roll Calico onto the new version ---------------
deadline=$(( $(date +%s) + 90 ))
until case "$(node_img)" in *":${TARGET_VER}") true ;; *) false ;; esac; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "${MIG}: calico-node still runs $(node_img) — the operator has not switched it to ${TARGET_VER} yet; the next converge re-checks." >&2
    exit 1
  fi
  sleep 5
done
if ! $KUBECTL -n calico-system rollout status ds/calico-node --timeout=240s >/dev/null; then
  echo "${MIG}: calico-node has not finished rolling to ${TARGET_VER} within 240s — the next converge re-checks." >&2
  exit 1
fi
deadline=$(( $(date +%s) + 60 ))
until calico_available; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "${MIG}: tigerastatus/calico is not Available after the roll: $($KUBECTL get tigerastatus calico -o jsonpath='{.status.conditions}' 2>/dev/null) — the next converge re-checks." >&2
    exit 1
  fi
  sleep 5
done
echo "${MIG}: Calico now at ${TARGET_VER} (operator ${TARGET_OPERATOR}); calico-node rolled on every node, Available."
exit 0
