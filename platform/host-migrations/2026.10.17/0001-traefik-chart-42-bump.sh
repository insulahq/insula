#!/usr/bin/env bash
# description: Traefik moves to chart 42.1.3 (Traefik v3.7.16), which fixes request-smuggling, path-routing, ForwardAuth, header-sanitising and mTLS advisories; rolls the DaemonSet node by node.
# idempotent: the guard reads the deployed chart version with `helm list` and exits 0 when the traefik release is already at chart 42.1.3 or newer (a floor, never a ceiling) — a re-run costs one helm read. Runs on CONTROL-PLANE nodes only (helm needs the admin kubeconfig); a second server finds the first one's result and skips.
# allow-paths: none — operates solely on the cluster via helm + the node kubeconfig; helm's cache/config/data dirs are redirected to a private mktemp -d (PrivateTmp) and removed on EXIT, because ProtectHome=yes makes $HOME/.config unwritable.
# blocks-on-failure: no    # ADR-056: --atomic and the plugin check roll a failed upgrade back to the working Traefik; the next converge retries; no later migration depends on this one.
# phase: before-services    # ADR-064: swaps the chart version under the release's own values; needs nothing from the new release's manifests
set -euo pipefail

# Backfills the Traefik chart bump onto EXISTING clusters. scripts/bootstrap.sh
# installs chart 42.1.3 on fresh clusters (TRAEFIK_CHART_VERSION);
# ci-migration-coverage.sh requires this migration to accompany that change.
#
# WHY: Traefik v3.7.7–v3.7.16 fix about thirty advisories. The ones this
# platform is exposed to: a rootless HTTP/1 request-target that skips
# path-scoped routers and middlewares, request smuggling, header sanitising
# bypassed through trailers, ForwardAuth identity spoofing, and TLS-option
# conflicts that switch client-certificate (mTLS) checks off on a route.
#
# HOW: the release's own user values, handed back whole with `-f` against the
# new chart, whose defaults then apply. NOT `--reuse-values`: that keeps the
# OLD chart's defaults, and chart 42 reads `.Values.hub.hardened`, which the
# 41.0.x defaults do not carry ("wrong type … expected bool"). Same values
# handling as 2026.10.15/0001: the forwardedHeaders.trustedIPs args that
# platform-api's cluster-trusted-proxies reconciler patches onto the LIVE
# DaemonSet are carried, or this roll would cut trust back to loopback until
# the reconciler's next tick rolls Traefik a second time.
#
# Chart 42.0.0's breaking changes are Hub-only (Secret RBAC, transparency
# logs) plus Kubernetes >= 1.30. Helm never upgrades a chart's crds/; Traefik
# 3.7.x only added the optional Middleware field `errorRequestHeaders`, which
# nothing here sets.
#
# Blast radius (by design): the DaemonSet rolls (maxUnavailable=1, no surge —
# hostPorts); ingress on each node blips for the seconds its pod restarts. A
# Traefik that cannot load its plugins drops every router that uses one (both
# panels, every WAF route), so a pod reporting its plugins disabled after the
# upgrade rolls the release back and fails the script.

MIG="traefik-chart-42-bump"
TARGET_CHART="42.1.3"
TARGET_APP="v3.7.16"
REJECTED_ANNOTATION="insula.host/traefik-chart-rejected"
# Overridable for the clean-room test only; the runner's env carries neither.
KUBECONFIG_PATH="${HM_KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
PLUGIN_VERDICT_WAIT="${HM_PLUGIN_VERDICT_WAIT:-120}"

if [ -r "$KUBECONFIG_PATH" ]; then
  export KUBECONFIG="$KUBECONFIG_PATH"
else
  echo "${MIG}: no admin kubeconfig on this node (worker/least-priv) — skipping."
  exit 0
fi
command -v kubectl >/dev/null 2>&1 || { echo "${MIG}: kubectl not found on PATH — skipping." >&2; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "${MIG}: jq not found on PATH — cannot carry the values safely." >&2; exit 1; }
if ! kubectl -n traefik get daemonset traefik >/dev/null 2>&1; then
  echo "${MIG}: no Traefik DaemonSet on this cluster — skipping."
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

chart_ver_ge() { # chart_ver_ge <have> <want> -> 0 when have >= want
  local a="${1#v}" b="${2#v}"
  [ "$a" = "$b" ] && return 0
  [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -n1)" = "$b" ]
}

# --- where the release is now -------------------------------------------------
# A failed READ exits non-zero (the runner retries next converge); only a
# successful listing without the release means "nothing to do here".
HELM_ERR="$HELM_HOME_DIR/helm.err"
if ! releases="$("$HELM" list -n traefik -o json 2>"$HELM_ERR")"; then
  echo "${MIG}: helm list failed — will retry on the next converge: $(cat "$HELM_ERR")" >&2
  exit 1
fi
deployed_ver="$(jq -r '.[]? | select(.name == "traefik") | .chart' <<<"$releases" 2>/dev/null \
  | sed -n 's/^traefik-//p' | head -n1 || true)"
if [ -z "$deployed_ver" ]; then
  echo "${MIG}: traefik helm release not found in ns traefik (installed out-of-band?) — skipping." >&2
  exit 0
fi
if chart_ver_ge "$deployed_ver" "$TARGET_CHART"; then
  echo "${MIG}: traefik already at chart ${deployed_ver} (>= ${TARGET_CHART}) — nothing to do."
  exit 0
fi
# A chart whose Traefik already refused its plugins (see the end) is not
# retried: every attempt would roll ingress on every node, each converge.
rejected="$(kubectl get namespace traefik -o json | jq -r --arg a "$REJECTED_ANNOTATION" '.metadata.annotations[$a] // ""')"
if [ "$rejected" = "$TARGET_CHART" ]; then
  echo "${MIG}: Traefik chart ${TARGET_CHART} refused its plugins on an earlier attempt — not retrying (to retry: kubectl annotate namespace traefik ${REJECTED_ANNOTATION}-)." >&2
  exit 1
fi
# The revision to roll back to if the new Traefik cannot load its plugins: the
# last one that DEPLOYED.
prev_rev="$("$HELM" history traefik -n traefik -o json 2>/dev/null \
  | jq -r '[.[] | select(.status == "deployed")] | last | .revision // empty' 2>/dev/null || true)"
"$HELM" repo add traefik https://traefik.github.io/charts 2>/dev/null || true
"$HELM" repo update traefik >/dev/null 2>&1 || "$HELM" repo update >/dev/null 2>&1 || true

# --- the release's own values, handed back whole ------------------------------
# A read that does not look like this platform's release would be installed
# as the entire configuration — refuse it instead.
if ! values="$("$HELM" get values traefik -n traefik -o json 2>"$HELM_ERR")"; then
  echo "${MIG}: helm get values failed — will retry on the next converge: $(cat "$HELM_ERR")" >&2
  exit 1
fi
if ! jq -e '.deployment.kind == "DaemonSet" and (.ports.websecure.hostPort // 0) == 443' <<<"$values" >/dev/null 2>&1; then
  echo "${MIG}: helm get values does not look like the bootstrap release (no DaemonSet/hostPort 443) — refusing to re-install it as the whole configuration." >&2
  exit 1
fi

# Carry the reconciler-owned trustedIPs args from the LIVE DaemonSet.
live_args="$(kubectl -n traefik get daemonset traefik -o json \
  | jq -c '[.spec.template.spec.containers[] | select(.name == "traefik")][0].args // []')"
args="$(jq -c '.additionalArguments // []' <<<"$values")"
for ep in web websecure; do
  prefix="--entryPoints.${ep}.forwardedHeaders.trustedIPs="
  lv="$(jq -r --arg p "$prefix" '[.[] | strings | select(startswith($p))] | last // ""' <<<"$live_args")"
  [ -n "$lv" ] || continue
  args="$(jq -c --arg p "$prefix" --arg a "$lv" '
    if any(.[]; type == "string" and startswith($p))
    then map(if type == "string" and startswith($p) then $a else . end)
    else . + [$a] end' <<<"$args")"
done

VALUES_FILE="$HELM_HOME_DIR/traefik-values.json"
jq --argjson args "$args" '.additionalArguments = $args' <<<"$values" > "$VALUES_FILE"

echo "${MIG}: upgrading traefik chart ${deployed_ver} -> ${TARGET_CHART} (Traefik ${TARGET_APP}) …"
# --atomic: an upgrade that does not become ready is rolled back by helm itself.
# Without it a timeout leaves the release `failed` and, with maxUnavailable=1
# and no surge (hostPorts), one node without ingress until a later converge.
"$HELM" upgrade traefik traefik/traefik \
  --namespace traefik \
  --version "$TARGET_CHART" \
  -f "$VALUES_FILE" \
  --atomic \
  --wait \
  --timeout 300s

image="$(kubectl -n traefik get daemonset traefik -o json \
  | jq -r '[.spec.template.spec.containers[] | select(.name == "traefik")][0].image')"
case "$image" in
  *":${TARGET_APP}"|*":${TARGET_APP#v}") ;;
  *) echo "${MIG}: helm upgrade succeeded but the DaemonSet runs ${image}, not ${TARGET_APP}." >&2; exit 1 ;;
esac

# --- prove every pod LOADED its plugins ---------------------------------------
# A pod that cannot load a plugin still reports Ready, but Traefik then drops
# every router with a plugin middleware. Each pod logs one verdict at startup.
# After a version change any "disabled" verdict is treated as caused by it:
# roll back, and let the next converge try again.
deadline=$(( $(date +%s) + PLUGIN_VERDICT_WAIT ))
while :; do
  pending=0; failed=""
  pods="$(kubectl -n traefik get pods -l app.kubernetes.io/name=traefik -o json \
    | jq -r '.items[] | select(.metadata.deletionTimestamp == null) | .metadata.name')"
  # No pods is not "all loaded".
  [ -n "$pods" ] || pending=1
  for pod in $pods; do
    logs="$(kubectl -n traefik logs "$pod" -c traefik --tail=500 2>/dev/null || true)"
    if grep -q 'Plugins are disabled' <<<"$logs"; then
      failed="${failed} ${pod}"
    elif ! grep -q 'Plugins loaded' <<<"$logs"; then pending=$((pending + 1)); fi
  done
  if [ -n "$failed" ]; then
    echo "${MIG}: Traefik ${TARGET_APP} reported its plugins disabled on${failed} — rolling the release back to revision ${prev_rev:-previous}." >&2
    "$HELM" rollback traefik ${prev_rev:+"$prev_rev"} -n traefik --wait --timeout 300s >&2 || true
    kubectl annotate namespace traefik --overwrite "${REJECTED_ANNOTATION}=${TARGET_CHART}" >&2 || true
    exit 1
  fi
  [ "$pending" -eq 0 ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "${MIG}: ${pending} Traefik pod(s) logged no plugin verdict within ${PLUGIN_VERDICT_WAIT}s — leaving them to traefik-plugin-guard; will re-check on the next converge." >&2
    exit 1
  fi
  sleep 5
done
echo "${MIG}: applied — traefik at chart ${TARGET_CHART} (${TARGET_APP}); every pod loaded its plugins."
