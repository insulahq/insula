#!/usr/bin/env bash
# description: The Sealed Secrets controller moves to 0.40.0 (chart 2.20.0), which stops its /v1/verify and /v1/rotate endpoints acting as decryption oracles; the controller rolls.
# idempotent: the guard reads the deployed chart version with `helm list` and exits 0 when the sealed-secrets release is `deployed` at chart 2.20.0 or newer (a floor, never a ceiling); `helm upgrade` onto an at-version release would itself be a no-op. Runs on CONTROL-PLANE nodes only (helm needs the admin kubeconfig; workers hold only the least-privilege host-config kubeconfig and exit 0 without acting). A release not installed here is skipped.
# allow-paths: none — operates solely on the cluster via helm + the node kubeconfig; helm's cache/config/data dirs are redirected to a private mktemp -d (PrivateTmp) and removed on EXIT, because ProtectHome=yes makes $HOME/.config unwritable.
# blocks-on-failure: no    # ADR-056: --atomic rolls a failed upgrade back, so on failure the previous Sealed Secrets keeps running and the next converge retries; no later migration depends on this one.
# phase: before-services    # ADR-064: a chart-version swap under the release's own values; needs nothing from the new release's manifests
set -euo pipefail

# Backfills the Sealed Secrets bump onto EXISTING clusters. scripts/bootstrap.sh
# installs chart 2.20.0 on fresh clusters (SEALED_SECRETS_CHART_VERSION); ci-migration-coverage.sh
# requires this migration to accompany that change.
#
# WHY: controller 0.39.0 and 0.40.0 stop /v1/verify and /v1/rotate acting as
# decryption oracles. 0.41.x is tagged but no chart ships it yet; 2.20.0
# (controller 0.40.0) is the newest chart.
#
# HOW: `--reset-then-reuse-values` — the NEW chart's defaults, then the
# release's own user-supplied values on top — with `--atomic`, so a release
# that does not become ready is rolled back rather than left `failed` at the
# new chart version (240s each way fits the runner's 10 minutes). Plain `--reuse-values` keeps the
# OLD chart's defaults, so a key the new chart added has no value and the image tag stays the old one (0.38.4).
#
# Blast radius (by design): the controller Deployment rolls; existing Secrets are untouched, and
# unsealing pauses for the seconds of the roll.

MIG="sealed-secrets-2-20-bump"
TARGET_CHART="2.20.0"

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
if ! releases="$(timeout 60 "$HELM" list -n kube-system -a -o json 2>"$HELM_HOME_DIR/helm.err")"; then
  echo "${MIG}: helm list failed — will retry on the next converge: $(cat "$HELM_HOME_DIR/helm.err")" >&2
  exit 1
fi
cur="$(printf '%s' "$releases" \
  | sed -n 's/.*"name":"sealed-secrets"[^}]*"chart":"sealed-secrets-\([^"]*\)".*/\1/p' \
  | head -n1)"
status="$(printf '%s' "$releases" \
  | sed -n 's/.*"name":"sealed-secrets"[^}]*"status":"\([^"]*\)".*/\1/p' \
  | head -n1)"
if [ -z "$cur" ]; then
  echo "${MIG}: sealed-secrets release not installed in kube-system here — skipping (migration never first-installs a chart)."
  exit 0
fi

chart_ver_ge() { # chart_ver_ge <have> <want> -> 0 when have >= want
  local a="${1#v}" b="${2#v}"
  [ "$a" = "$b" ] && return 0
  [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -n1)" = "$b" ]
}
case "$status" in
  pending-*)
    if recover_stale_pending sealed-secrets kube-system \
       && releases="$(timeout 60 "$HELM" list -n kube-system -a -o json 2>"$HELM_HOME_DIR/helm.err")"; then
      cur="$(printf '%s' "$releases" \
        | sed -n 's/.*"name":"sealed-secrets"[^}]*"chart":"sealed-secrets-\([^"]*\)".*/\1/p' \
        | head -n1)"
      status="$(printf '%s' "$releases" \
        | sed -n 's/.*"name":"sealed-secrets"[^}]*"status":"\([^"]*\)".*/\1/p' \
        | head -n1)"
    else
      echo "${MIG}: the sealed-secrets release is ${status} (an earlier helm run was cut short, or one is running) — not upgrading over it. If it stays so, check 'helm history sealed-secrets -n kube-system' and roll back to the last deployed revision; the next converge retries." >&2
      exit 1
    fi ;;
esac
# A `failed` release at the target chart is not done: upgrade it again.
if [ "$status" = "deployed" ] && chart_ver_ge "$cur" "$TARGET_CHART"; then
  echo "${MIG}: sealed-secrets already at chart ${cur} (>= ${TARGET_CHART}) — nothing to do."
  exit 0
fi

"$HELM" repo add sealed-secrets https://bitnami.github.io/sealed-secrets --force-update 2>/dev/null || true
timeout 60 "$HELM" repo update sealed-secrets >/dev/null 2>&1 || timeout 90 "$HELM" repo update >/dev/null 2>&1 || true

echo "${MIG}: upgrading sealed-secrets chart ${cur} -> ${TARGET_CHART} (controller 0.40.0, --reset-then-reuse-values) ..."
"$HELM" upgrade sealed-secrets sealed-secrets/sealed-secrets \
  --namespace kube-system \
  --version "$TARGET_CHART" \
  --reset-then-reuse-values \
  --atomic \
  --wait \
  --timeout 240s

echo "${MIG}: sealed-secrets now at chart ${TARGET_CHART} (controller 0.40.0)."
exit 0
