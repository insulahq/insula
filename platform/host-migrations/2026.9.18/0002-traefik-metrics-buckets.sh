#!/usr/bin/env bash
# idempotent: the guard reads the LIVE DaemonSet args and exits 0 when Traefik
#   already runs with the target `--metrics.prometheus.buckets=` value, so a
#   re-run costs one kubectl call and changes nothing. Runs on CONTROL-PLANE
#   nodes only — helm needs the admin kubeconfig; worker nodes hold only the
#   least-privilege host-config kubeconfig and exit 0 without acting.
#   Concurrent control-plane runs converge: the second one finds the value
#   already applied and skips, and a racing `helm upgrade` with identical
#   values is a no-op release.
# allow-paths: none — operates solely on the cluster via helm + the node
#   kubeconfig. Writes no managed host files: helm's cache/config/data dirs are
#   redirected to a private mktemp -d under the unit's PrivateTmp and removed on
#   EXIT, because ProtectHome=yes makes the default $HOME/.config unwritable.
# blocks-on-failure: no     # ADR-056: metrics resolution only. If this fails,
#   Traefik keeps its default buckets and every SLO rule still evaluates —
#   `platform-latency-slow-share` deliberately keys on le="1.2", an edge that
#   exists in the default set too. Nothing later depends on this script.
set -euo pipefail

# Widens Traefik's latency histogram buckets on EXISTING clusters.
# scripts/bootstrap.sh installs these on FRESH clusters (install_traefik,
# TRAEFIKVALUES `metrics.prometheus.buckets`); this is the one-time in-place
# backfill (ADR-045 W10c; ci-migration-coverage.sh requires a migration to
# accompany the bootstrap helm-values change).
#
# WHY: Traefik's default buckets are "0.1,0.3,1.2,5.0". A p95 anywhere between
# 0.3s and 1.2s is reported as a linear interpolation across that 900ms gap, so
# Monitoring → SLOs showed latency figures that were arithmetic rather than
# measurement (production 2026-09-12 reported "615ms" from a 36/39/39 bucket
# split — no request was measured at 615ms). The new set is a strict SUPERSET
# of the default, so no existing query or SLO rule changes meaning; it only
# gains resolution.
#
# Blast radius (documented, by design): a values change rolls the Traefik
# DaemonSet, whose updateStrategy is maxUnavailable=1/maxSurge=0 (forced —
# hostPort :80/:443 cannot be surged). Ingress on each node blips for the few
# seconds its pod restarts, one node at a time.
TARGET_BUCKETS="0.05,0.1,0.25,0.3,0.5,1,1.2,2.5,5,10"

# --- resolve an ADMIN kubeconfig (control-plane only; helm needs cluster-admin) ---
# The runner hands us a clean env (PATH + HOME only) — resolve our own
# KUBECONFIG, never inherit one.
if [ -r /etc/rancher/k3s/k3s.yaml ]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
else
  echo "traefik-metrics-buckets: no admin kubeconfig on this node (worker/least-priv) — skipping."
  exit 0
fi

command -v kubectl >/dev/null 2>&1 || {
  echo "traefik-metrics-buckets: kubectl not found on PATH — skipping." >&2; exit 0; }

# --- guard: already applied? -------------------------------------------------
# Reads the RUNNING DaemonSet, not the helm release: the pod template is what
# actually determines the exported buckets, and it is the thing a partially
# applied or hand-edited cluster would disagree with.
if ! kubectl -n traefik get daemonset traefik >/dev/null 2>&1; then
  echo "traefik-metrics-buckets: no Traefik DaemonSet on this cluster — skipping."
  exit 0
fi

current_args=$(kubectl -n traefik get daemonset traefik \
  -o jsonpath='{.spec.template.spec.containers[0].args}' 2>/dev/null || true)

case "$current_args" in
  *"--metrics.prometheus.buckets=${TARGET_BUCKETS}"*)
    echo "traefik-metrics-buckets: already applied — skipping."
    exit 0
    ;;
esac

# --- resolve helm (bootstrap installs it to /usr/local/bin) ------------------
HELM=""
for h in helm /usr/local/bin/helm; do
  if command -v "$h" >/dev/null 2>&1; then HELM="$h"; break; fi
done
[ -n "$HELM" ] || { echo "traefik-metrics-buckets: helm not found on PATH — skipping." >&2; exit 0; }

# --- give helm a WRITABLE home ----------------------------------------------
# The converge unit runs with ProtectHome=yes, so /root is mounted read-only,
# and the runner hands migrations a clean env whose HOME is /root. helm creates
# $HOME/.config/helm and $HOME/.cache/helm on essentially every invocation, so
# it dies before doing anything:
#
#   Error: mkdir /root/.config: read-only file system
#
# Measured on staging 2026-09-12: this failed the migration on its first real
# run. The unit sets PrivateTmp=yes, so /tmp is private and writable — point
# HOME and every HELM_*_HOME at a temp dir there. Verified under a systemd-run
# sandbox with the same ProtectHome/PrivateTmp properties: identical helm
# command fails with HOME=/root and succeeds with the redirect.
#
# Not merely cosmetic for `helm repo add`, which the script tolerates with
# `|| true` — `helm upgrade` below is NOT tolerated and runs under `set -e`.
HELM_HOME_DIR="$(mktemp -d)"
trap 'rm -rf "$HELM_HOME_DIR"' EXIT
export HOME="$HELM_HOME_DIR"
export HELM_CACHE_HOME="$HELM_HOME_DIR/cache"
export HELM_CONFIG_HOME="$HELM_HOME_DIR/config"
export HELM_DATA_HOME="$HELM_HOME_DIR/data"
mkdir -p "$HELM_CACHE_HOME" "$HELM_CONFIG_HOME" "$HELM_DATA_HOME"

"$HELM" repo add traefik https://traefik.github.io/charts 2>/dev/null || true
"$HELM" repo update traefik >/dev/null 2>&1 || "$HELM" repo update >/dev/null 2>&1 || true

# --- pin the chart version to whatever is ALREADY deployed -------------------
# Deliberately NOT the version bootstrap.sh pins today. This migration changes
# one value and must never move the chart: a node that was bootstrapped later
# (newer chart) and only now runs this script would otherwise be DOWNGRADED.
# Without an explicit --version, helm would resolve the newest chart in the
# repo, which is the same failure with a different sign.
deployed_ver=$("$HELM" list -n traefik -o json 2>/dev/null \
  | sed -n 's/.*"name":"traefik"[^}]*"chart":"traefik-\([^"]*\)".*/\1/p' | head -n1)

if [ -z "$deployed_ver" ]; then
  echo "traefik-metrics-buckets: traefik helm release not found in ns traefik (chart installed out-of-band?) — skipping." >&2
  exit 0
fi

echo "traefik-metrics-buckets: setting buckets on traefik chart ${deployed_ver} …"

# --reuse-values, for the same reason 2026.7.1/0001 uses it: the release
# carries extensive bootstrap-computed values (DaemonSet mode, hostPorts,
# plugin module+version pins, forwardedHeaders trustedIPs, the bouncer-key
# volume, the access-log hostPath). A bare upgrade resets those to chart
# defaults and tears down the ingress perimeter.
#
# --set-string with ESCAPED commas: helm's --set parser splits on `,` to mean
# "next assignment", so a bare --set metrics.prometheus.buckets=0.05,0.1,…
# is read as one assignment plus a pile of malformed ones. Escaping each comma
# passes the literal string through. --set-string additionally stops helm
# type-guessing the value (the chart expects a string here).
TARGET_BUCKETS_ESC="${TARGET_BUCKETS//,/\\,}"

"$HELM" upgrade traefik traefik/traefik \
  --namespace traefik \
  --version "${deployed_ver}" \
  --reuse-values \
  --set-string "metrics.prometheus.buckets=${TARGET_BUCKETS_ESC}" \
  --wait \
  --timeout 300s

echo "traefik-metrics-buckets: applied (buckets=${TARGET_BUCKETS})."
