#!/usr/bin/env bash
# idempotent: no-op once all three helm releases already report their target chart
#   version (the per-chart guard reads `helm list -o json` and skips a release
#   that matches). Runs on CONTROL-PLANE nodes only — helm needs the admin
#   kubeconfig; worker nodes hold only the least-privilege host-config kubeconfig
#   (get on 5 ConfigMaps) and exit 0 without acting. Concurrent CP runs converge:
#   `helm upgrade` on an already-at-version release is a no-op and the guard skips
#   it first anyway. A release that isn't installed here is skipped (a migration
#   never does a first-time chart install — it lacks the bootstrap-computed values).
# allow-paths: none — operates solely on the cluster via helm + the node
#   kubeconfig. Writes no managed host files (helm refreshes its own
#   $HOME/.cache/helm + $HOME/.config/helm repo metadata, which are caches).
set -euo pipefail

# Backfills three tier-0/1 helm-chart PATCH bumps onto EXISTING clusters.
# bootstrap.sh installs these versions on FRESH clusters (install_cert_manager /
# install_traefik / install_cnpg); this is the one-time in-place upgrade for
# clusters bootstrapped before the bump (ADR-045 W10c; ci-migration-coverage.sh
# requires this migration to accompany the bootstrap.sh pin change):
#   - cert-manager  v1.20.2 -> v1.20.3   HIGH CVE fix GHSA-8rvj-mm4h-c258
#                                        (ACME Challenge/Order solver priv-esc;
#                                        "all users should upgrade")
#   - traefik chart 41.0.0  -> 41.0.2    Traefik app v3.7.5 -> v3.7.6 (patch)
#   - cnpg chart    0.28.2  -> 0.28.3    CloudNative-PG operator patch
#
# WHY --reuse-values (not --set): each release carries extensive bootstrap-computed
# custom values — Traefik especially (DaemonSet mode, hostPorts :80/:443,
# CrowdSec/ModSecurity/Coraza plugin module+version pins, forwardedHeaders
# trustedIPs, the bouncer-key volume). A bare `helm upgrade --version` WITHOUT
# --reuse-values resets those to chart defaults and tears down the ingress
# perimeter. --reuse-values carries the prior release's values forward and only
# swaps the chart version (→ the new pinned app image). These are same-major patch
# bumps, so no new REQUIRED values are introduced.
#
# Blast radius (documented, by design): the cnpg operator roll triggers an
# operator-managed rolling switchover on existing Cluster CRs (brief on
# instances:1, graceful on HA instances:3); traefik's DaemonSet RollingUpdate
# (maxUnavailable=1,maxSurge=0) blips ingress per node as it rolls.

# --- resolve an ADMIN kubeconfig (control-plane only; helm needs cluster-admin) ---
# The runner hands us a clean env (PATH + HOME only) — resolve our own KUBECONFIG,
# never inherit one. Only the control-plane admin kubeconfig grants helm the access
# it needs; the worker least-priv kubeconfig deliberately does not, so workers skip.
if [ -r /etc/rancher/k3s/k3s.yaml ]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
else
  echo "infra-chart-bumps: no admin kubeconfig on this node (worker/least-priv) — skipping."
  exit 0
fi

# --- resolve helm (bootstrap installs it to /usr/local/bin) ---
HELM=""
for h in helm /usr/local/bin/helm; do
  if command -v "$h" >/dev/null 2>&1; then HELM="$h"; break; fi
done
[ -n "$HELM" ] || { echo "infra-chart-bumps: helm not found on PATH — skipping." >&2; exit 0; }

# Add/refresh the upstream chart repos (idempotent). Mirrors scripts/bootstrap.sh.
"$HELM" repo add jetstack https://charts.jetstack.io          2>/dev/null || true
"$HELM" repo add traefik  https://traefik.github.io/charts    2>/dev/null || true
"$HELM" repo add cnpg     https://cloudnative-pg.github.io/charts 2>/dev/null || true
"$HELM" repo update jetstack traefik cnpg >/dev/null 2>&1 || "$HELM" repo update >/dev/null 2>&1 || true

# current_chart_ver <release> <namespace> <chart-name-prefix>
# Echoes the deployed chart version (e.g. "41.0.0"), or "" if the release is absent.
current_chart_ver() {
  local rel="$1" ns="$2" prefix="$3"
  "$HELM" list -n "$ns" -o json 2>/dev/null \
    | sed -n "s/.*\"name\":\"${rel}\"[^}]*\"chart\":\"${prefix}-\([^\"]*\)\".*/\1/p" \
    | head -n1
}

# bump <release> <namespace> <chart-ref> <chart-name-prefix> <target-version> [extra helm flags...]
bump() {
  local rel="$1" ns="$2" ref="$3" prefix="$4" target="$5"; shift 5
  local cur
  cur=$(current_chart_ver "$rel" "$ns" "$prefix")
  if [ -z "$cur" ]; then
    echo "infra-chart-bumps: release '${rel}' not installed in ns '${ns}' here — skipping (migration never first-installs a chart)."
    return 0
  fi
  if [ "$cur" = "$target" ]; then
    echo "infra-chart-bumps: ${rel} already at chart ${target} — nothing to do."
    return 0
  fi
  echo "infra-chart-bumps: upgrading ${rel} chart ${cur} -> ${target} (--reuse-values) ..."
  "$HELM" upgrade "$rel" "$ref" \
    --namespace "$ns" \
    --version "$target" \
    --reuse-values \
    "$@"
  echo "infra-chart-bumps: ${rel} now at chart ${target}."
}

# cert-manager: chart carries crds.enabled=true → CRDs upgrade with the release.
bump cert-manager cert-manager jetstack/cert-manager cert-manager v1.20.3 \
  --wait --timeout 300s

# traefik: DaemonSet; RollingUpdate blips ingress per node as it rolls.
bump traefik traefik traefik/traefik traefik 41.0.2 \
  --wait --timeout 300s

# cnpg operator: roll triggers an operator-managed switchover on existing Cluster CRs.
bump cnpg cnpg-system cnpg/cloudnative-pg cloudnative-pg 0.28.3 \
  --wait --timeout 600s

echo "infra-chart-bumps: all target chart versions reconciled."
exit 0
