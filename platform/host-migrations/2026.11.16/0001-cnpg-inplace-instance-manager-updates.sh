#!/usr/bin/env bash
# description: The CloudNativePG operator will update its instance manager inside the running database pods, so an operator update no longer restarts the database by itself. Only the operator restarts now.
# idempotent: the guard reads the cnpg release's own values with `helm get values` and exits 0 when the release is `deployed` with config.data.ENABLE_INSTANCE_MANAGER_INPLACE_UPDATES="true". `helm upgrade` keeps the release's current chart version, so it never moves the operator. Runs on CONTROL-PLANE nodes only (helm needs the admin kubeconfig; workers hold only the least-privilege host-config kubeconfig and exit 0 without acting). A release not installed here is skipped.
# allow-paths: none — operates solely on the cluster via helm and the node kubeconfig; helm's cache/config/data dirs are redirected to a private mktemp -d (PrivateTmp) and removed on EXIT, because ProtectHome=yes makes $HOME/.config unwritable.
# blocks-on-failure: no    # ADR-056: --atomic rolls a failed upgrade back, so on failure the operator keeps running with its old configuration and the next converge retries; no later migration depends on this one.
# phase: before-services    # ADR-064: an operator setting under the release's own chart version; needs nothing from the new release's manifests
set -euo pipefail

# Backfills ENABLE_INSTANCE_MANAGER_INPLACE_UPDATES onto EXISTING clusters.
# scripts/bootstrap.sh sets it on fresh installs (install_cnpg);
# ci-migration-coverage.sh requires this migration to accompany that change.
#
# WHY: without it, every operator update restarts every Postgres instance,
# because the new operator rolls each pod to swap the instance manager binary
# (pid 1 of the postgres container). With it, the operator uploads its own
# binary to each pod (PUT /update on :8000, operator client certificate
# required), the instance manager checks the hash against the Cluster status,
# replaces /controller/manager and re-executes itself; the postmaster, its
# connections and the pod are left as they are. A pod spec change, a
# PostgreSQL image change or a restart annotation still rolls the instances as
# before; so does an operator update that also changes the instance pod spec.
#
# HOW: `helm upgrade` at the release's deployed chart version with
# `--reset-then-reuse-values`, adding the one value. The chart puts a checksum of
# its config in the operator pod template, so the operator rolls and reads the
# setting at start. The operator and its instance managers stay the same
# version, so no instance restarts. `--set-string`: ConfigMap data takes strings
# only; a plain --set renders an unquoted bool, which the API server refuses
# when it creates the ConfigMap.
#
# Blast radius: the operator Deployment rolls (seconds without reconciles). On
# HA clusters helm resets the operator to one replica; the storage-policy
# reconciler restores the count within minutes. The databases keep running.

MIG="cnpg-inplace-instance-manager-updates"
KEY="ENABLE_INSTANCE_MANAGER_INPLACE_UPDATES"

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

# Deployed chart version and status of the release, or "" if absent. A failed
# READ exits non-zero (the runner retries next converge).
read_release() {
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
}
read_release
if [ -z "$cur" ]; then
  echo "${MIG}: cnpg release not installed in cnpg-system here — skipping (migration never first-installs a chart)."
  exit 0
fi
case "$status" in
  pending-*)
    if recover_stale_pending cnpg cnpg-system; then
      read_release
    else
      echo "${MIG}: the cnpg release is ${status} (an earlier helm run was cut short, or one is running) — not upgrading over it. If it stays so, check 'helm history cnpg -n cnpg-system' and roll back to the last deployed revision; the next converge retries." >&2
      exit 1
    fi ;;
esac

# The release's user-supplied values (compact JSON). The setting is done only
# on a `deployed` release; a `failed` one is upgraded again.
if ! values="$(timeout 60 "$HELM" get values cnpg -n cnpg-system -o json 2>"$HELM_HOME_DIR/helm.err")"; then
  echo "${MIG}: helm get values failed — will retry on the next converge: $(cat "$HELM_HOME_DIR/helm.err")" >&2
  exit 1
fi
if [ "$status" = "deployed" ] && printf '%s' "$values" | grep -q "\"${KEY}\":\"true\""; then
  echo "${MIG}: cnpg (chart ${cur}) already has ${KEY}=true — nothing to do."
  exit 0
fi

"$HELM" repo add cnpg https://cloudnative-pg.github.io/charts 2>/dev/null || true
timeout 60 "$HELM" repo update cnpg >/dev/null 2>&1 || timeout 90 "$HELM" repo update >/dev/null 2>&1 || true

echo "${MIG}: setting ${KEY}=true on cnpg (chart ${cur}, unchanged) ..."
"$HELM" upgrade cnpg cnpg/cloudnative-pg \
  --namespace cnpg-system \
  --version "$cur" \
  --reset-then-reuse-values \
  --set-string "config.data.${KEY}=true" \
  --atomic \
  --wait \
  --timeout 240s

echo "${MIG}: cnpg (chart ${cur}) now updates instance managers in place."
exit 0
