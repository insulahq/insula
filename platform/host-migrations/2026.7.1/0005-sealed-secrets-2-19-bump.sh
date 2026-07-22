#!/usr/bin/env bash
# idempotent: no-op once the sealed-secrets helm release already reports chart
#   2.19.1. The guard reads `helm list -o json` and skips a release already at
#   target; a `helm upgrade` on an already-at-version release is itself a no-op.
#   Runs on CONTROL-PLANE nodes only (helm needs the admin kubeconfig; workers
#   hold only the least-privilege host-config kubeconfig and exit 0 without
#   acting). A release not installed here is skipped. Concurrent CP runs converge.
# allow-paths: none — operates solely on the cluster via helm + the node
#   kubeconfig. Writes no managed host files (helm refreshes its own cache/config).
set -euo pipefail

# Backfills the sealed-secrets chart bump onto EXISTING clusters. bootstrap.sh
# installs 2.19.1 on FRESH clusters (install_sealed_secrets); this is the one-time
# in-place upgrade for clusters bootstrapped before the bump (ADR-045 W10c;
# ci-migration-coverage.sh requires this migration to accompany the bootstrap.sh
# SEALED_SECRETS_CHART_VERSION change):
#   - sealed-secrets chart 2.18.6 -> 2.19.1    controller v0.37.0 -> v0.38.4.
#     No breaking chart changes (minor bump). The controller decrypts the same
#     SealedSecrets; sealing keys are untouched.
#
# WHY --reset-then-reuse-values + --force-update: (1) clusters bootstrapped before
# the repo URL was corrected have `sealed-secrets` pointing at the stale
# `bitnami-LABS.github.io` mirror (stuck at 2.18.6); a plain `helm repo add` is a
# no-op when the name already exists, so `--force-update` is required to repoint it
# to `bitnami.github.io` (which serves 2.19.1). (2) --reset-then-reuse-values is
# defensive against chart-schema tightening (same class as cert-manager 0004): it
# resets to the new chart defaults and re-applies only the USER value
# (fullnameOverride=sealed-secrets-controller), which bootstrap sets. Requires helm
# >= 3.14 (nodes ship 3.21).

# --- resolve an ADMIN kubeconfig (control-plane only; helm needs cluster-admin) ---
if [ -r /etc/rancher/k3s/k3s.yaml ]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
else
  echo "sealed-secrets-2-19-bump: no admin kubeconfig on this node (worker/least-priv) — skipping."
  exit 0
fi

# --- resolve helm (bootstrap installs it to /usr/local/bin) ---
HELM=""
for h in helm /usr/local/bin/helm; do
  if command -v "$h" >/dev/null 2>&1; then HELM="$h"; break; fi
done
[ -n "$HELM" ] || { echo "sealed-secrets-2-19-bump: helm not found on PATH — skipping." >&2; exit 0; }

TARGET_CHART="2.19.1"

# Add/refresh the upstream chart repo (idempotent). Mirrors scripts/bootstrap.sh.
"$HELM" repo add sealed-secrets https://bitnami.github.io/sealed-secrets --force-update 2>/dev/null || true
"$HELM" repo update sealed-secrets >/dev/null 2>&1 || "$HELM" repo update >/dev/null 2>&1 || true

# Deployed chart version for release 'sealed-secrets' in kube-system, or "" if absent.
current_chart_ver() {
  "$HELM" list -n kube-system -o json 2>/dev/null \
    | sed -n 's/.*"name":"sealed-secrets"[^}]*"chart":"sealed-secrets-\([^"]*\)".*/\1/p' \
    | head -n1
}

cur=$(current_chart_ver)
if [ -z "$cur" ]; then
  echo "sealed-secrets-2-19-bump: sealed-secrets release not installed in kube-system here — skipping (migration never first-installs a chart)."
  exit 0
fi
if [ "$cur" = "$TARGET_CHART" ]; then
  echo "sealed-secrets-2-19-bump: sealed-secrets already at chart ${TARGET_CHART} — nothing to do."
  exit 0
fi

echo "sealed-secrets-2-19-bump: upgrading sealed-secrets chart ${cur} -> ${TARGET_CHART} (--reset-then-reuse-values) ..."
"$HELM" upgrade sealed-secrets sealed-secrets/sealed-secrets \
  --namespace kube-system \
  --version "$TARGET_CHART" \
  --reset-then-reuse-values \
  --wait \
  --timeout 300s

echo "sealed-secrets-2-19-bump: sealed-secrets now at chart ${TARGET_CHART}."
exit 0
