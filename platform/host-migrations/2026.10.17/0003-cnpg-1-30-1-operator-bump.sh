#!/usr/bin/env bash
# description: The CloudNativePG operator moves to v1.30.1 (chart 0.29.1), a webhook validation and gRPC security fix. Each Postgres instance restarts once; the platform database waits 15 s, not 180 s, to stop.
# idempotent: the guard reads the deployed chart version with `helm list` and exits 0 when the cnpg release is `deployed` at chart 0.29.1 or newer (a floor, never a ceiling); `helm upgrade` onto an at-version release would itself be a no-op. The smart-shutdown step only lowers a value above 15 s, so a re-run leaves it alone. Runs on CONTROL-PLANE nodes only (helm needs the admin kubeconfig; workers hold only the least-privilege host-config kubeconfig and exit 0 without acting). A release not installed here is skipped.
# allow-paths: none — operates solely on the cluster via helm, kubectl and the node kubeconfig; helm's cache/config/data dirs are redirected to a private mktemp -d (PrivateTmp) and removed on EXIT, because ProtectHome=yes makes $HOME/.config unwritable.
# blocks-on-failure: no    # ADR-056: --atomic rolls a failed upgrade back, so on failure the previous CloudNativePG operator keeps running and the next converge retries; no later migration depends on this one.
# phase: before-services    # ADR-064: a chart-version swap under the release's own values; needs nothing from the new release's manifests
set -euo pipefail

# Backfills the CloudNativePG operator bump onto EXISTING clusters. scripts/bootstrap.sh
# installs chart 0.29.1 on fresh clusters (CNPG_CHART_VERSION); ci-migration-coverage.sh
# requires this migration to accompany that change.
#
# WHY: v1.30.1 fixes a webhook validation bypass (an absolute extension path
# with an embedded ".." was accepted) and updates gRPC (CVE fix), and stops
# inheritedMetadata PVC labels being overwritten — the path
# k8s/base/longhorn/recurring-jobs.yaml relies on. The default operand image
# changed, but every Cluster here pins imageName.
#
# HOW: `--reset-then-reuse-values` — the NEW chart's defaults, then the
# release's own user-supplied values on top — with `--atomic`, so a release
# that does not become ready is rolled back rather than left `failed` at the
# new chart version (240s each way fits the runner's 10 minutes). Plain `--reuse-values` keeps the
# OLD chart's defaults, so a key the new chart added has no value — the 0.29.1 chart fails on that with
# "nil pointer … scratchData.emptyDir".
#
# Blast radius (by design): the operator Deployment rolls, and then restarts every
# Postgres instance once to give it the new instance manager (CNPG's default when the
# operator changes; measured on staging: the platform database restarted, ~30 s of API
# errors on a one-instance cluster). On HA clusters helm resets the operator to
# one replica; the storage-policy reconciler restores the count within minutes.

MIG="cnpg-1-30-1-operator-bump"
TARGET_CHART="0.29.1"

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

# A pending-* release whose last revision is over 15 minutes old is a run that
# was killed (the host-config unit bounds a whole converge to 600s), not one in
# progress. For this stateless controller chart, rolling back to the last
# deployed revision is safe; the upgrade then runs again.
recover_stale_pending() { # recover_stale_pending <release> <namespace>
  local hist updated age rev
  command -v jq >/dev/null 2>&1 || return 1
  hist="$(timeout 60 "$HELM" history "$1" -n "$2" -o json 2>/dev/null)" || return 1
  updated="$(jq -r '.[-1].updated // ""' <<<"$hist")"
  [ -n "$updated" ] || return 1
  age=$(( $(date +%s) - $(date -d "$updated" +%s 2>/dev/null || date +%s) ))
  [ "$age" -gt 900 ] || return 1
  rev="$(jq -r '[.[] | select(.status == "deployed" or .status == "superseded")] | last | .revision // empty' <<<"$hist")"
  [ -n "$rev" ] || return 1
  echo "${MIG}: release $1 has been ${status} for ${age}s — a killed run; rolling it back to revision ${rev}." >&2
  timeout 300 "$HELM" rollback "$1" "$rev" -n "$2" --wait --timeout 240s >&2
}

# Deployed chart version of the release, or "" if absent. A failed READ exits
# non-zero (the runner retries next converge).
if ! releases="$(timeout 60 "$HELM" list -n cnpg-system -a -o json 2>"$HELM_HOME_DIR/helm.err")"; then
  echo "${MIG}: helm list failed — will retry on the next converge: $(cat "$HELM_HOME_DIR/helm.err")" >&2
  exit 1
fi
cur="$(printf '%s' "$releases" \
  | sed -n 's/.*"name":"cnpg"[^}]*"chart":"cloudnative-pg-\([^"]*\)".*/\1/p' \
  | head -n1)"
status="$(printf '%s' "$releases" \
  | sed -n 's/.*"name":"cnpg"[^}]*"status":"\([^"]*\)".*/\1/p' \
  | head -n1)"
if [ -z "$cur" ]; then
  echo "${MIG}: cnpg release not installed in cnpg-system here — skipping (migration never first-installs a chart)."
  exit 0
fi

chart_ver_ge() { # chart_ver_ge <have> <want> -> 0 when have >= want
  local a="${1#v}" b="${2#v}"
  [ "$a" = "$b" ] && return 0
  [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -n1)" = "$b" ]
}
case "$status" in
  pending-*)
    if recover_stale_pending cnpg cnpg-system \
       && releases="$(timeout 60 "$HELM" list -n cnpg-system -a -o json 2>"$HELM_HOME_DIR/helm.err")"; then
      cur="$(printf '%s' "$releases" \
        | sed -n 's/.*"name":"cnpg"[^}]*"chart":"cloudnative-pg-\([^"]*\)".*/\1/p' \
        | head -n1)"
      status="$(printf '%s' "$releases" \
        | sed -n 's/.*"name":"cnpg"[^}]*"status":"\([^"]*\)".*/\1/p' \
        | head -n1)"
    else
      echo "${MIG}: the cnpg release is ${status} (an earlier helm run was cut short, or one is running) — not upgrading over it. If it stays so, check 'helm history cnpg -n cnpg-system' and roll back to the last deployed revision; the next converge retries." >&2
      exit 1
    fi ;;
esac
# A `failed` release at the target chart is not done: upgrade it again.
if [ "$status" = "deployed" ] && chart_ver_ge "$cur" "$TARGET_CHART"; then
  echo "${MIG}: cnpg already at chart ${cur} (>= ${TARGET_CHART}) — nothing to do."
  exit 0
fi

# Each of those restarts first runs a SMART shutdown for smartShutdownTimeout:
# open sessions may continue, every new connection is refused. platform-api's
# pool never closes its sessions, so CNPG's default of 180 s ran in full on
# staging. k8s/base/database.yaml sets 15 s, but it arrives with the services,
# after this before-services step, so lower it here first. Changing the field
# restarts nothing (the instance manager reads it when the stop signal comes).
# Only ever lowers it, and a failure here does not stop the operator upgrade.
SHORT_SMART_SHUTDOWN=15
lower_smart_shutdown() {
  local kubectl="" k out sst
  for k in kubectl /usr/local/bin/kubectl; do
    if command -v "$k" >/dev/null 2>&1; then kubectl="$k"; break; fi
  done
  [ -n "$kubectl" ] || { echo "${MIG}: kubectl not found on PATH — not lowering the smart-shutdown window." >&2; return 0; }
  if ! out="$(timeout 30 "$kubectl" -n platform get clusters.postgresql.cnpg.io system-db -o name 2>&1)"; then
    case "$out" in
      *NotFound*|*"not found"*|*"doesn't have a resource type"*)
        echo "${MIG}: no platform database Cluster here — nothing to lower."; return 0 ;;
    esac
    return 1
  fi
  sst="$(timeout 30 "$kubectl" -n platform get clusters.postgresql.cnpg.io system-db \
    -o jsonpath='{.spec.smartShutdownTimeout}' 2>/dev/null)" || return 1
  case "$sst" in
    '') sst=180 ;;           # unset = CNPG's default
    *[!0-9]*) return 1 ;;
  esac
  [ "$sst" -gt "$SHORT_SMART_SHUTDOWN" ] || return 0
  timeout 30 "$kubectl" -n platform patch clusters.postgresql.cnpg.io system-db --type merge \
    -p "{\"spec\":{\"smartShutdownTimeout\":${SHORT_SMART_SHUTDOWN}}}" >/dev/null || return 1
  echo "${MIG}: platform database smart-shutdown window ${sst}s -> ${SHORT_SMART_SHUTDOWN}s before the operator restarts it."
}
lower_smart_shutdown || echo "${MIG}: could not lower the platform database's smart-shutdown window — its restart waits up to the old window; continuing." >&2

"$HELM" repo add cnpg https://cloudnative-pg.github.io/charts 2>/dev/null || true
timeout 60 "$HELM" repo update cnpg >/dev/null 2>&1 || timeout 90 "$HELM" repo update >/dev/null 2>&1 || true

echo "${MIG}: upgrading cnpg chart ${cur} -> ${TARGET_CHART} (operator v1.30.1, --reset-then-reuse-values) ..."
"$HELM" upgrade cnpg cnpg/cloudnative-pg \
  --namespace cnpg-system \
  --version "$TARGET_CHART" \
  --reset-then-reuse-values \
  --atomic \
  --wait \
  --timeout 240s

echo "${MIG}: cnpg now at chart ${TARGET_CHART} (operator v1.30.1)."
exit 0
