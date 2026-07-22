#!/usr/bin/env bash
# idempotent: no-op once the cert-manager helm release already reports chart
#   v1.21.0. The guard reads `helm list -o json` and skips a release already at
#   target; a `helm upgrade` on an already-at-version release is itself a no-op
#   too. Runs on CONTROL-PLANE nodes only (helm needs the admin kubeconfig;
#   workers hold only the least-privilege host-config kubeconfig and exit 0
#   without acting). A release not installed here is skipped (a migration never
#   first-installs a chart — it lacks the bootstrap-computed values). Concurrent
#   CP runs converge (helm upgrade on an at-version release is a no-op).
# allow-paths: none — operates solely on the cluster via helm + the node
#   kubeconfig. Writes no managed host files (helm refreshes its own cache/config).
set -euo pipefail

# Backfills the cert-manager chart bump onto EXISTING clusters. bootstrap.sh
# installs v1.21.0 on FRESH clusters (install_cert_manager); this is the one-time
# in-place upgrade for clusters bootstrapped before the bump (ADR-045 W10c;
# ci-migration-coverage.sh requires this migration to accompany the bootstrap.sh
# CERT_MANAGER_CHART_VERSION change):
#   - cert-manager v1.20.3 -> v1.21.0    ACME Renewal Information (ARI) support +
#                                        security hardening (upstream 1.21).
#
# SAFETY — the v1.21 Helm chart REMOVES the default `tokenrequest` Role/RoleBinding
# that let the controller mint tokens for its own ServiceAccount. That only
# matters for issuers using serviceAccountRef / ambient credentials; this
# platform issues exclusively via ACME ClusterIssuers (http01 + dns01/Cloudflare)
# — no serviceAccountRef anywhere in k8s/ — so the removal is a no-op for us.
#
# WHY --reuse-values (not --set): the release carries bootstrap-computed values.
# A bare `helm upgrade --version` WITHOUT --reuse-values resets them to chart
# defaults. --reuse-values carries the prior release's values forward and only
# swaps the chart version. The cert-manager chart carries crds.enabled=true, so
# `helm upgrade` rolls the CRDs with the release (no separate CRD apply needed).
#
# Blast radius (documented, by design): the controller/webhook/cainjector
# Deployments roll (RollingUpdate); brief in-flight certificate reconciliation
# pause while the new controller starts. No data-plane impact (issued certs keep
# serving; renewals resume on the new controller).

# --- resolve an ADMIN kubeconfig (control-plane only; helm needs cluster-admin) ---
if [ -r /etc/rancher/k3s/k3s.yaml ]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
else
  echo "cert-manager-1-21-bump: no admin kubeconfig on this node (worker/least-priv) — skipping."
  exit 0
fi

# --- resolve helm (bootstrap installs it to /usr/local/bin) ---
HELM=""
for h in helm /usr/local/bin/helm; do
  if command -v "$h" >/dev/null 2>&1; then HELM="$h"; break; fi
done
[ -n "$HELM" ] || { echo "cert-manager-1-21-bump: helm not found on PATH — skipping." >&2; exit 0; }

TARGET_CHART="v1.21.0"

# Add/refresh the upstream chart repo (idempotent). Mirrors scripts/bootstrap.sh.
"$HELM" repo add jetstack https://charts.jetstack.io 2>/dev/null || true
"$HELM" repo update jetstack >/dev/null 2>&1 || "$HELM" repo update >/dev/null 2>&1 || true

# Deployed chart version for release 'cert-manager' in cert-manager, or "" if absent.
current_chart_ver() {
  "$HELM" list -n cert-manager -o json 2>/dev/null \
    | sed -n 's/.*"name":"cert-manager"[^}]*"chart":"cert-manager-\([^"]*\)".*/\1/p' \
    | head -n1
}

cur=$(current_chart_ver)
if [ -z "$cur" ]; then
  echo "cert-manager-1-21-bump: cert-manager release not installed in ns cert-manager here — skipping (migration never first-installs a chart)."
  exit 0
fi
if [ "$cur" = "$TARGET_CHART" ]; then
  echo "cert-manager-1-21-bump: cert-manager already at chart ${TARGET_CHART} — nothing to do."
  exit 0
fi

echo "cert-manager-1-21-bump: upgrading cert-manager chart ${cur} -> ${TARGET_CHART} (--reuse-values) ..."
"$HELM" upgrade cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --version "$TARGET_CHART" \
  --reuse-values \
  --wait \
  --timeout 300s

echo "cert-manager-1-21-bump: cert-manager now at chart ${TARGET_CHART}."
exit 0
