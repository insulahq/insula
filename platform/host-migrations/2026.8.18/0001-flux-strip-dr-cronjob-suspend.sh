#!/usr/bin/env bash
# idempotent: greps the flux-system/platform Kustomization for each CronJob
#             target before appending its strip patch; nodes where all three
#             are present exit 0 without writing. The JSON-patch append is
#             guarded per target, so a partial earlier run completes cleanly.
# allow-paths: (none — cluster-only change via kube-API, touches no host file)
# blocks-on-failure: no    # ADR-056: nothing later depends on this. A node
#                          # that misses it keeps the Flux/bridge suspend
#                          # tug-of-war (bridge re-unsuspends within 5 min of
#                          # every Flux sync) until the migration re-runs.
set -euo pipefail

# 2026.8.18 — stop Flux re-suspending the shim-bridged DR CronJobs.
#
# platform-api's dr-cronjobs bridge owns /spec/suspend on
# platform-secrets-backup, platform-cluster-state-backup and
# platform-backup-audit (unsuspends them when the SYSTEM backup class is
# bound). The base manifests ship `suspend: true`, so without a strip
# patch Flux reverts the bridge's unsuspend on every sync — the nightly
# secrets bundle / cluster-state dump / audit never get a stable window
# to fire. bootstrap.sh now writes the strip patches into the
# flux-system/platform Kustomization on FRESH installs; this migration
# carries the same three patches onto already-bootstrapped clusters.
# Mirrors the existing stalwart-snapshot strip (same Kustomization).

MIG="0001-flux-strip-dr-cronjob-suspend"
kube() { kubectl --kubeconfig=/etc/rancher/k3s/k3s.yaml "$@"; }

# Only the node that can reach the API server applies this; on a
# multi-node cluster the others no-op rather than fight over the object.
if ! kube get --raw=/readyz >/dev/null 2>&1; then
  echo "${MIG}: kube-API not reachable from this node — skipping (another node applies it)"
  exit 0
fi

if ! kube get kustomization -n flux-system platform >/dev/null 2>&1; then
  # Production-style clusters that apply overlays without a Flux
  # Kustomization have no object to patch — and no Flux to fight the
  # bridge either.
  echo "${MIG}: no flux-system/platform Kustomization on this cluster — nothing to do"
  exit 0
fi

LIVE=$(kube get kustomization -n flux-system platform -o json)

# If spec.patches is absent entirely, seed an empty list first so the
# JSON-patch 'add' to /spec/patches/- has a parent to append to.
if ! printf '%s' "$LIVE" | grep -q '"patches"'; then
  kube patch kustomization -n flux-system platform --type=json \
    -p '[{"op":"add","path":"/spec/patches","value":[]}]'
fi

applied=0
for cj in platform-secrets-backup platform-cluster-state-backup platform-backup-audit; do
  if printf '%s' "$LIVE" | grep -q "\"name\":\"${cj}\""; then
    echo "${MIG}: strip patch for ${cj} already present"
    continue
  fi
  kube patch kustomization -n flux-system platform --type=json -p "[
    {\"op\":\"add\",\"path\":\"/spec/patches/-\",\"value\":{
      \"patch\":\"- op: remove\\n  path: /spec/suspend\",
      \"target\":{\"group\":\"batch\",\"version\":\"v1\",\"kind\":\"CronJob\",\"name\":\"${cj}\"}
    }}
  ]"
  applied=$((applied+1))
  echo "${MIG}: appended strip patch for ${cj}"
done

echo "${MIG}: done (${applied} patch(es) appended)"
