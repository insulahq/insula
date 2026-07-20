#!/usr/bin/env bash
# idempotent: no-op once the cnpg helm release already reports chart 0.29.0. The
#   guard reads `helm list -o json` and skips a release already at target; a
#   `helm upgrade` on an already-at-version release is itself a no-op too. Runs on
#   CONTROL-PLANE nodes only (helm needs the admin kubeconfig; workers hold only
#   the least-privilege host-config kubeconfig and exit 0 without acting). A
#   release not installed here is skipped (a migration never first-installs a
#   chart — it lacks the bootstrap-computed values). Concurrent CP runs converge.
# allow-paths: none — operates solely on the cluster via helm + the node
#   kubeconfig. Writes no managed host files (helm refreshes its own cache/config).
set -euo pipefail

# Backfills the CloudNative-PG operator chart bump onto EXISTING clusters.
# bootstrap.sh installs 0.29.0 on FRESH clusters (install_cnpg); this is the
# one-time in-place upgrade for clusters bootstrapped before the bump (ADR-045
# W10c; ci-migration-coverage.sh requires this migration to accompany the
# bootstrap.sh CNPG_CHART_VERSION change):
#   - cnpg chart 0.28.3 -> 0.29.0    CloudNative-PG operator v1.29.1 -> v1.30.0
#
# WHY: version hygiene (latest stable) + a PARTIAL mitigation of a barman-cloud
# WAL-archiver plugin-roll bug. Adding the plugin to a RUNNING cluster forces CNPG
# to roll the primary to inject the archiver sidecar; that roll can loop forever
# ("Primary instance is being restarted without a switchover" / "PodSpec differ …
# has been added"), wedging system-db. 1.30.0 fixes this for the HA/multi-instance
# `switchover` path — recreates the primary Pod in place so the sidecar is injected
# (cnpg#11032/#11059). It does NOT fix the platform's single-instance (instances:1)
# case (still wedges on 1.29.1 AND 1.30.0); that CNPG limitation is reported
# upstream + tracked separately (node-pin / HA). So this bump helps but is not the
# single-instance wedge fix.
#
# WHY --reuse-values (not --set): the release carries bootstrap-computed values
# (monitoring.podMonitorEnabled=false, maxConcurrentReconciles=3). A bare
# `helm upgrade --version` WITHOUT --reuse-values resets them to chart defaults.
# --reuse-values carries the prior release's values forward and only swaps the
# chart version. The cnpg chart TEMPLATES its CRDs (they appear in `helm get
# manifest`), so `helm upgrade` also rolls the CRDs to 1.30.0 — no separate CRD
# apply needed (verified live: the 1.30-new DatabaseRole CRD appears on upgrade).
#
# Blast radius (documented, by design): the operator roll triggers an
# operator-managed rolling restart on the existing system-db Cluster CR
# (brief on instances:1; graceful switchover on HA instances:3).

# --- resolve an ADMIN kubeconfig (control-plane only; helm needs cluster-admin) ---
if [ -r /etc/rancher/k3s/k3s.yaml ]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
else
  echo "cnpg-1-30-operator-bump: no admin kubeconfig on this node (worker/least-priv) — skipping."
  exit 0
fi

# --- resolve helm (bootstrap installs it to /usr/local/bin) ---
HELM=""
for h in helm /usr/local/bin/helm; do
  if command -v "$h" >/dev/null 2>&1; then HELM="$h"; break; fi
done
[ -n "$HELM" ] || { echo "cnpg-1-30-operator-bump: helm not found on PATH — skipping." >&2; exit 0; }

TARGET_CHART="0.29.0"

# Add/refresh the upstream chart repo (idempotent). Mirrors scripts/bootstrap.sh.
"$HELM" repo add cnpg https://cloudnative-pg.github.io/charts 2>/dev/null || true
"$HELM" repo update cnpg >/dev/null 2>&1 || "$HELM" repo update >/dev/null 2>&1 || true

# Deployed chart version for release 'cnpg' in cnpg-system, or "" if absent.
current_chart_ver() {
  "$HELM" list -n cnpg-system -o json 2>/dev/null \
    | sed -n 's/.*"name":"cnpg"[^}]*"chart":"cloudnative-pg-\([^"]*\)".*/\1/p' \
    | head -n1
}

cur=$(current_chart_ver)
if [ -z "$cur" ]; then
  echo "cnpg-1-30-operator-bump: cnpg release not installed in cnpg-system here — skipping (migration never first-installs a chart)."
  exit 0
fi
if [ "$cur" = "$TARGET_CHART" ]; then
  echo "cnpg-1-30-operator-bump: cnpg already at chart ${TARGET_CHART} — nothing to do."
  exit 0
fi

echo "cnpg-1-30-operator-bump: upgrading cnpg chart ${cur} -> ${TARGET_CHART} (operator -> v1.30.0, --reuse-values) ..."
"$HELM" upgrade cnpg cnpg/cloudnative-pg \
  --namespace cnpg-system \
  --version "$TARGET_CHART" \
  --reuse-values \
  --wait \
  --timeout 600s

echo "cnpg-1-30-operator-bump: cnpg now at chart ${TARGET_CHART} (operator v1.30.0)."
exit 0
