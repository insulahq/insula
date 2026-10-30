#!/usr/bin/env bash
# description: The snapshot-controller moves to v8.7.0 (from the v8.5.0 image the v8.6.0 manifest shipped, which carries a critical gRPC CVE) and gains the volume-group-snapshot CRDs; the controller rolls.
# idempotent: the guard reads kube-system/snapshot-controller and exits 0 when its image is already snapshot-controller:v8.7.0 and the three VolumeGroupSnapshot CRDs exist. The CRD, RBAC and Deployment applies are declarative, so a re-run or a second control-plane node converges on the same state. Worker nodes cannot read the Deployment (least-privilege kubeconfig) and exit 0 without acting.
# allow-paths: none — operates solely on the cluster via the node kubeconfig; the fetched manifests live in a private mktemp -d (PrivateTmp) removed on EXIT.
# blocks-on-failure: no    # ADR-056: on failure the previous snapshot-controller keeps running and the next converge retries; no later migration depends on this one.
# phase: before-services    # ADR-064: a controller and CRD upgrade; needs nothing from the new release's manifests
set -euo pipefail

# Backfills external-snapshotter v8.6.0 -> v8.7.0 onto EXISTING clusters.
# scripts/bootstrap.sh installs v8.7.0 on fresh clusters (install_longhorn,
# snap_ver); ci-migration-coverage.sh requires this migration with that change.
#
# WHY: upstream's setup-snapshot-controller.yaml at a tag deploys the previous
# release's image, so clusters on the v8.6.0 pin run snapshot-controller
# v8.5.0, whose grpc-go carries CVE-2026-33186 (critical). The image is
# rewritten to v8.7.0 here, as bootstrap.sh now does. v8.7.0's CRDs and RBAC
# are byte-identical to v8.6.0's.
#
# From v8.7.0 the VolumeGroupSnapshot feature is GA and on by default: without
# its CRDs the controller logs list errors for up to 30s at every start and then
# runs without the feature. The three CRDs are upstream's standard set; nothing
# here creates group snapshots.
#
# HOW: client-side `kubectl apply`, as 2026.6.19/0001 and bootstrap.sh do, so
# the tolerations and topology spread later migrations patched onto the
# Deployment (they are not in the applied manifest) are kept. The manifest's
# `replicas: 2` is replaced with the live count first: platform-storage-policy
# scales this Deployment with the server count, and an apply at 2 would scale a
# one-server cluster up until its next tick.
#
# Blast radius (by design): snapshot-controller (stateless, leader-elected)
# rolls; VolumeSnapshot reconciliation pauses for the seconds of the roll.

MIG="external-snapshotter-v8-7-bump"
SNAP_VER="v8.7.0"
IMAGE="registry.k8s.io/sig-storage/snapshot-controller:${SNAP_VER}"
BASE="https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/${SNAP_VER}"

if [ -r /etc/rancher/k3s/k3s.yaml ]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
else
  echo "${MIG}: no admin kubeconfig on this node (worker/least-priv) — skipping."
  exit 0
fi
if command -v k3s >/dev/null 2>&1; then
  KUBECTL=(k3s kubectl)
else
  KUBECTL=(kubectl)
fi

if ! live_img=$("${KUBECTL[@]}" -n kube-system get deploy snapshot-controller \
                  -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null); then
  echo "${MIG}: no readable kube-system/snapshot-controller here — skipping (this migration never first-installs it)."
  exit 0
fi
group_crds=0
for c in volumegroupsnapshotclasses volumegroupsnapshotcontents volumegroupsnapshots; do
  "${KUBECTL[@]}" get crd "${c}.groupsnapshot.storage.k8s.io" >/dev/null 2>&1 && group_crds=$((group_crds + 1))
done
if [ "$live_img" = "$IMAGE" ] && [ "$group_crds" -eq 3 ]; then
  echo "${MIG}: snapshot-controller already runs ${SNAP_VER} with the group-snapshot CRDs — nothing to do."
  exit 0
fi
replicas=$("${KUBECTL[@]}" -n kube-system get deploy snapshot-controller -o jsonpath='{.spec.replicas}')
case "$replicas" in ''|*[!0-9]*) replicas=2 ;; esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "${MIG}: ${live_img} -> ${IMAGE} (replicas ${replicas} kept), ${group_crds}/3 group-snapshot CRDs present ..."
for f in \
  client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml \
  client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml \
  client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml \
  client/config/crd/groupsnapshot.storage.k8s.io_volumegroupsnapshotclasses.yaml \
  client/config/crd/groupsnapshot.storage.k8s.io_volumegroupsnapshotcontents.yaml \
  client/config/crd/groupsnapshot.storage.k8s.io_volumegroupsnapshots.yaml \
  deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml \
  deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml; do
  out="${WORK}/$(basename "$f")"
  if ! curl --retry 3 --retry-delay 5 -fsSL --max-time 60 -o "$out" "${BASE}/${f}"; then
    echo "${MIG}: could not fetch ${f} (outbound HTTPS to raw.githubusercontent.com) — the next converge retries." >&2
    exit 1
  fi
done
setup="${WORK}/setup-snapshot-controller.yaml"
sed -i -E "s#(registry\.k8s\.io/sig-storage/snapshot-controller:)v[0-9.]+#\1${SNAP_VER}#; s#^(  replicas:) [0-9]+#\1 ${replicas}#" "$setup"
grep -q "image: ${IMAGE}" "$setup" || { echo "${MIG}: the upstream manifest no longer names the snapshot-controller image where expected — refusing to apply it." >&2; exit 1; }
grep -qE "^  replicas: ${replicas}$" "$setup" || { echo "${MIG}: could not carry replicas=${replicas} into the manifest — refusing to apply it." >&2; exit 1; }

for f in "$WORK"/*.yaml; do
  case "$f" in *setup-snapshot-controller.yaml) continue ;; esac
  "${KUBECTL[@]}" apply -f "$f" >/dev/null
done
"${KUBECTL[@]}" apply -f "$setup" >/dev/null
# minReadySeconds is 35 upstream and the roll is one replica at a time.
"${KUBECTL[@]}" -n kube-system rollout status deploy/snapshot-controller --timeout="$(( 60 + 60 * replicas ))s"

img=$("${KUBECTL[@]}" -n kube-system get deploy snapshot-controller -o jsonpath='{.spec.template.spec.containers[0].image}')
[ "$img" = "$IMAGE" ] || { echo "${MIG}: applied, but the Deployment runs ${img}." >&2; exit 1; }
echo "${MIG}: applied — snapshot-controller runs ${SNAP_VER}, group-snapshot CRDs installed."
