#!/usr/bin/env bash
# description: cert-manager moves to v1.21.2: Go and gRPC security updates, and ACME response bodies capped against unbounded-body denial of service; its controllers roll.
# idempotent: the guard reads the deployed chart version with `helm list` and exits 0 when the cert-manager release is already at chart v1.21.2 or newer (a floor, never a ceiling); `helm upgrade` onto an at-version release would itself be a no-op. Runs on CONTROL-PLANE nodes only (helm needs the admin kubeconfig; workers hold only the least-privilege host-config kubeconfig and exit 0 without acting). A release not installed here is skipped.
# allow-paths: none — operates solely on the cluster via helm + the node kubeconfig; helm's cache/config/data dirs are redirected to a private mktemp -d (PrivateTmp) and removed on EXIT, because ProtectHome=yes makes $HOME/.config unwritable.
# blocks-on-failure: no    # ADR-056: on failure the previous cert-manager keeps running and the next converge retries; no later migration depends on this one.
# phase: before-services    # ADR-064: a chart-version swap under the release's own values; needs nothing from the new release's manifests
set -euo pipefail

# Backfills the cert-manager bump onto EXISTING clusters. scripts/bootstrap.sh
# installs chart v1.21.2 on fresh clusters (CERT_MANAGER_CHART_VERSION); ci-migration-coverage.sh
# requires this migration to accompany that change.
#
# WHY: v1.21.1–v1.21.2 carry Go 1.26.6 and gRPC/x-text/cel-go security
# updates, cap ACME server response bodies at 16 MiB, and fix controller and
# webhook panics and HTTP-01 solver bugs. No chart value was renamed.
#
# HOW: `--reset-then-reuse-values` — the NEW chart's defaults, then the
# release's own user-supplied values on top. Plain `--reuse-values` keeps the
# OLD chart's defaults, so a key the new chart added has no value.
#
# Blast radius (by design): the controller, webhook and cainjector Deployments roll (RollingUpdate);
# issued certificates keep serving, renewals pause for the seconds of the roll.

MIG="cert-manager-1-21-2-bump"
TARGET_CHART="v1.21.2"

if [ -r /etc/rancher/k3s/k3s.yaml ]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
else
  echo "${MIG}: no admin kubeconfig on this node (worker/least-priv) — skipping."
  exit 0
fi

HELM=""
for h in helm /usr/local/bin/helm; do
  if command -v "$h" >/dev/null 2>&1; then HELM="$h"; break; fi
done
[ -n "$HELM" ] || { echo "${MIG}: helm not found on PATH — skipping." >&2; exit 0; }

HELM_HOME_DIR="$(mktemp -d)"
trap 'rm -rf "$HELM_HOME_DIR"' EXIT
export HOME="$HELM_HOME_DIR"
export HELM_CACHE_HOME="$HELM_HOME_DIR/cache"
export HELM_CONFIG_HOME="$HELM_HOME_DIR/config"
export HELM_DATA_HOME="$HELM_HOME_DIR/data"
mkdir -p "$HELM_CACHE_HOME" "$HELM_CONFIG_HOME" "$HELM_DATA_HOME"

# Deployed chart version of the release, or "" if absent. A failed READ exits
# non-zero (the runner retries next converge).
if ! releases="$("$HELM" list -n cert-manager -o json 2>"$HELM_HOME_DIR/helm.err")"; then
  echo "${MIG}: helm list failed — will retry on the next converge: $(cat "$HELM_HOME_DIR/helm.err")" >&2
  exit 1
fi
cur="$(printf '%s' "$releases" \
  | sed -n 's/.*"name":"cert-manager"[^}]*"chart":"cert-manager-\([^"]*\)".*/\1/p' \
  | head -n1)"
if [ -z "$cur" ]; then
  echo "${MIG}: cert-manager release not installed in cert-manager here — skipping (migration never first-installs a chart)."
  exit 0
fi

chart_ver_ge() { # chart_ver_ge <have> <want> -> 0 when have >= want
  local a="${1#v}" b="${2#v}"
  [ "$a" = "$b" ] && return 0
  [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -n1)" = "$b" ]
}
if chart_ver_ge "$cur" "$TARGET_CHART"; then
  echo "${MIG}: cert-manager already at chart ${cur} (>= ${TARGET_CHART}) — nothing to do."
  exit 0
fi

"$HELM" repo add jetstack https://charts.jetstack.io 2>/dev/null || true
"$HELM" repo update jetstack >/dev/null 2>&1 || "$HELM" repo update >/dev/null 2>&1 || true

echo "${MIG}: upgrading cert-manager chart ${cur} -> ${TARGET_CHART} (cert-manager v1.21.2, --reset-then-reuse-values) ..."
"$HELM" upgrade cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --version "$TARGET_CHART" \
  --reset-then-reuse-values \
  --wait \
  --timeout 300s

echo "${MIG}: cert-manager now at chart ${TARGET_CHART} (cert-manager v1.21.2)."
exit 0
