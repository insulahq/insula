#!/usr/bin/env bash
# idempotent: reads the existing patch TARGET NAMES out of the flux-system/
#             platform Kustomization with -o jsonpath (never by grepping the
#             JSON text — kubectl pretty-prints, see 2026.8.18/0001) and
#             removes only a platform-backup-audit entry if one is still there.
#             A node where it is already gone writes nothing.
# allow-paths: (none — cluster-only change via kube-API, touches no host file)
# blocks-on-failure: no    # ADR-056: nothing later depends on this. The orphan
#                          # patch is inert (kustomize treats a target that
#                          # matches no resource as a no-op — verified against
#                          # kubectl kustomize 2026-09-03), so a node that
#                          # misses this keeps a harmless stale list entry.
set -euo pipefail

# 2026.9.5 — clean up after the retired backup-audit CronJob.
#
# The CronJob is gone from git, so Flux (prune: true) garbage-collects it along
# with its ServiceAccount, ClusterRole and ClusterRoleBinding. What Flux cannot
# clean up is the strip patch that bootstrap.sh and host-migration
# 2026.8.18/0001 wrote INTO the flux-system/platform Kustomization itself:
#
#   {"patch":"- op: remove\n  path: /spec/suspend",
#    "target":{"group":"batch","version":"v1","kind":"CronJob",
#              "name":"platform-backup-audit"}}
#
# That entry is inert once the CronJob is gone — a kustomize patch whose target
# selector matches nothing is a no-op, confirmed by building a two-patch
# kustomization where one target was absent: the build succeeded and the
# matching patch still applied. This migration removes it anyway, so the
# Kustomization's patch list keeps describing something real.
#
# 2026.8.18/0001 was edited in place to stop re-adding it. That script is a
# CONVERGER re-run on every enforce pass, so removing the entry here without
# also editing there would have produced a permanent add/remove flap.

MIG="0002-flux-drop-backup-audit-patch"
TARGET="platform-backup-audit"
kube() { kubectl --kubeconfig=/etc/rancher/k3s/k3s.yaml "$@"; }

# Only the node that can reach the API server applies this; on a multi-node
# cluster the others no-op rather than fight over the object.
if ! kube get --raw=/readyz >/dev/null 2>&1; then
  echo "${MIG}: kube-API not reachable from this node — skipping (another node applies it)"
  exit 0
fi

if ! kube get kustomization -n flux-system platform >/dev/null 2>&1; then
  echo "${MIG}: no flux-system/platform Kustomization on this cluster — nothing to do"
  exit 0
fi

names_of() {
  kube get kustomization -n flux-system platform \
    -o jsonpath='{range .spec.patches[*]}{.target.name}{"\n"}{end}' 2>/dev/null
}

# Indices are removed highest-first so the earlier ones stay valid as the list
# shrinks. Handles duplicates left by the pre-2026.8.19 guard as a side effect.
removed=0
for idx in $(names_of | awk -v t="$TARGET" 'NF && $0 == t { print NR-1 }' | sort -rn); do
  if kube patch kustomization -n flux-system platform --type=json \
       -p "[{\"op\":\"remove\",\"path\":\"/spec/patches/${idx}\"}]" >/dev/null 2>&1; then
    removed=$((removed+1))
  fi
done

if [ "$removed" -eq 0 ]; then
  echo "${MIG}: no ${TARGET} strip patch present — nothing to do"
else
  echo "${MIG}: removed ${removed} orphaned ${TARGET} strip patch(es)"
fi
