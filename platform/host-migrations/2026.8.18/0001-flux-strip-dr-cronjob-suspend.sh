#!/usr/bin/env bash
# idempotent: reads the existing patch TARGET NAMES out of the flux-system/
#             platform Kustomization with -o jsonpath (never by grepping the
#             JSON text) and appends only the targets that are missing; a node
#             where they are all present writes nothing. It also removes any
#             duplicate strip patches left by the broken pre-2026.8.19 guard.
# allow-paths: (none — cluster-only change via kube-API, touches no host file)
# blocks-on-failure: no    # ADR-056: nothing later depends on this. A node
#                          # that misses it keeps the Flux/bridge suspend
#                          # tug-of-war (bridge re-unsuspends within 5 min of
#                          # every Flux sync) until the migration re-runs.
set -euo pipefail

# 2026.8.18 — stop Flux re-suspending the shim-bridged DR CronJobs.
#
# platform-api's dr-cronjobs bridge owns /spec/suspend on
# platform-secrets-backup and platform-cluster-state-backup (unsuspends them
# when the SYSTEM backup class is
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

# Read the patch target names STRUCTURALLY. The original guard grepped the
# raw `-o json` text for "name":"<cj>" — kubectl pretty-prints with a space
# after the colon ("name": "<cj>"), so that pattern could never match and the
# converger appended a fresh copy of all three patches on EVERY enforce pass.
# Observed on staging 2026-08-27: three duplicates per CronJob, and kustomize
# fails the SECOND remove of the same key —
#   "error in remove for path: '/spec/suspend': Unable to remove nonexistent
#    key: suspend: missing value"
# — which pins the whole platform Kustomization at Ready=False, so NOTHING
# reconciles. jsonpath returns the values themselves, with no quoting or
# whitespace to be wrong about.
names_of() {
  kube get kustomization -n flux-system platform \
    -o jsonpath='{range .spec.patches[*]}{.target.name}{"\n"}{end}' 2>/dev/null
}

# If spec.patches is absent entirely, seed an empty list first so the
# JSON-patch 'add' to /spec/patches/- has a parent to append to.
if ! kube get kustomization -n flux-system platform \
     -o jsonpath='{.spec.patches}' 2>/dev/null | grep -q '.'; then
  kube patch kustomization -n flux-system platform --type=json \
    -p '[{"op":"add","path":"/spec/patches","value":[]}]'
fi

# ── Repair: drop duplicate targets left by the broken guard ──────────────
# Keep the FIRST occurrence of each target name, delete the rest. Indices are
# removed highest-first so the earlier ones stay valid as the list shrinks.
removed=0
dupes=$(names_of | awk 'NF { if (seen[$0]++) print NR-1 }' | sort -rn)
for idx in $dupes; do
  if kube patch kustomization -n flux-system platform --type=json \
       -p "[{\"op\":\"remove\",\"path\":\"/spec/patches/${idx}\"}]" >/dev/null 2>&1; then
    removed=$((removed+1))
  fi
done
if [ "$removed" -gt 0 ]; then
  echo "${MIG}: removed ${removed} duplicate strip patch(es) left by the pre-2026.8.19 guard"
fi

applied=0
# 2026-09-03: platform-backup-audit removed from this list. EDITED IN PLACE
# rather than superseded by a later migration, because this script is a
# CONVERGER — the host-config enforcer re-runs it on every pass, so a
# superseding migration would delete the orphan patch and this one would
# immediately re-add it. (The "never edit a shipped migration" rule is about
# paths and numbering, not about a converger's target list.)
for cj in platform-secrets-backup platform-cluster-state-backup; do
  if names_of | grep -qx "${cj}"; then
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

echo "${MIG}: done (${applied} appended, ${removed} duplicate(s) removed)"
