#!/usr/bin/env bash
# idempotent: no-op once the longhorn helm release already reports chart 1.12.0
#   (v-prefix normalised). The guard reads `helm list -o json` and skips a release
#   already at target; a `helm upgrade` on an at-version release is itself a no-op.
#   Runs on CONTROL-PLANE nodes only (helm needs the admin kubeconfig; workers
#   hold only the least-privilege host-config kubeconfig and exit 0 without
#   acting). A release not installed here is skipped. Concurrent CP runs converge.
# allow-paths: none — operates solely on the cluster via helm + the node
#   kubeconfig. Writes no managed host files (helm refreshes its own cache/config).
set -euo pipefail

# Backfills the Longhorn bump onto EXISTING clusters. bootstrap.sh installs v1.12.0
# on FRESH clusters (install_longhorn); this is the one-time in-place upgrade for
# clusters bootstrapped before the bump (ADR-045 W10c; ci-migration-coverage.sh
# requires this migration to accompany the bootstrap.sh LONGHORN_VERSION change):
#   - Longhorn v1.11.1 -> v1.12.0    one sequential minor (Longhorn's supported
#     upgrade granularity). v1.12 REMOVES V2 (SPDK) backing images — a NO-OP here:
#     this platform runs the default V1 engine only (no dataEngine:v2 anywhere in
#     k8s/), so no V2 volumes exist to migrate.
#
# WHY --reuse-values: the release carries bootstrap-computed values
# (csi.kubeletRootDir=/var/lib/kubelet, defaultReplicaCount=1, replicaAutoBalance,
# storageMinimalAvailablePercentage, defaultDataLocality, …). A bare
# `helm upgrade --version` WITHOUT --reuse-values resets them to chart defaults
# (e.g. replicaCount 3, which would over-replicate on a single node). --reuse-values
# carries the prior release's values forward and only swaps the chart version.
#
# Blast radius (documented, by design): the longhorn-manager DaemonSet + CSI
# components roll (RollingUpdate); the engine/replica data-plane keeps serving
# attached volumes across the manager roll (Longhorn's live-upgrade path for V1).

# --- resolve an ADMIN kubeconfig (control-plane only; helm needs cluster-admin) ---
if [ -r /etc/rancher/k3s/k3s.yaml ]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
else
  echo "longhorn-1-12-bump: no admin kubeconfig on this node (worker/least-priv) — skipping."
  exit 0
fi

# --- resolve helm (bootstrap installs it to /usr/local/bin) ---
HELM=""
for h in helm /usr/local/bin/helm; do
  if command -v "$h" >/dev/null 2>&1; then HELM="$h"; break; fi
done
[ -n "$HELM" ] || { echo "longhorn-1-12-bump: helm not found on PATH — skipping." >&2; exit 0; }

TARGET_CHART="v1.12.0"          # matches bootstrap's LONGHORN_VERSION form
TARGET_NORM="${TARGET_CHART#v}" # 1.12.0 — compare v-agnostically

# Add/refresh the upstream chart repo (idempotent). Mirrors scripts/bootstrap.sh.
"$HELM" repo add longhorn https://charts.longhorn.io 2>/dev/null || true
"$HELM" repo update longhorn >/dev/null 2>&1 || "$HELM" repo update >/dev/null 2>&1 || true

# Deployed chart version for release 'longhorn' in longhorn-system, or "" if absent.
current_chart_ver() {
  "$HELM" list -n longhorn-system -o json 2>/dev/null \
    | sed -n 's/.*"name":"longhorn"[^}]*"chart":"longhorn-\([^"]*\)".*/\1/p' \
    | head -n1
}

cur=$(current_chart_ver)
if [ -z "$cur" ]; then
  echo "longhorn-1-12-bump: longhorn release not installed in longhorn-system here — skipping (migration never first-installs a chart)."
  exit 0
fi
if [ "${cur#v}" = "$TARGET_NORM" ]; then
  echo "longhorn-1-12-bump: longhorn already at chart ${cur} — nothing to do."
  exit 0
fi

echo "longhorn-1-12-bump: upgrading longhorn chart ${cur} -> ${TARGET_CHART} (--reuse-values) ..."
"$HELM" upgrade longhorn longhorn/longhorn \
  --namespace longhorn-system \
  --version "$TARGET_CHART" \
  --reuse-values \
  --wait \
  --timeout 600s

echo "longhorn-1-12-bump: longhorn now at chart ${TARGET_CHART}."
exit 0
