#!/usr/bin/env bash
# description: Traefik's two init containers move from alpine/k8s 1.33.13 (critical OpenSSL, Python and Go CVEs) to curlimages/curl 8.23.0, the CrowdSec plugin to v1.8.1; the DaemonSet rolls node by node.
# idempotent: the guard reads the release values with `helm get values` and exits 0 when both init containers already run curlimages/curl:8.23.0, the CrowdSec plugin is at v1.8.1 and the traefik namespace's insula.host/traefik-values-verified annotation says every pod loaded its plugins on them; with the values in place but unverified it re-runs only the plugin check. Runs on CONTROL-PLANE nodes only (helm needs the admin kubeconfig); a second server finds the first one's result and skips.
# allow-paths: none — operates solely on the cluster via helm + the node kubeconfig; helm's cache/config/data dirs are redirected to a private mktemp -d (PrivateTmp) and removed on EXIT, because ProtectHome=yes makes $HOME/.config unwritable.
# blocks-on-failure: no    # ADR-056: a failed upgrade and a refused plugin are both rolled back to the working Traefik; the next converge retries, at most three attempts; no later migration depends on this one.
# phase: before-services    # ADR-064: changes the release's own values at its deployed chart; needs nothing from the new release's manifests
set -euo pipefail

# Backfills two Traefik value changes onto EXISTING clusters, in ONE roll.
# scripts/bootstrap.sh installs both on fresh clusters (TRAEFIKVALUES,
# CROWDSEC_PLUGIN_VERSION).
#
# 1. The init containers. prepare-access-log (mkdir + chown of the access-log
#    hostPath) and wait-for-plugin-registry (a curl loop) ran alpine/k8s
#    1.33.13 — kubectl, helm, eksctl, aws-cli and Python for two shell lines —
#    whose OpenSSL, Python, brotli and grpc-go carry critical CVEs. Bumping
#    that image would only have swapped one bundle of unused tools for
#    another, so they move to curlimages/curl, which has exactly what they run
#    (busybox sh, mkdir, chown, curl) and is already the platform's HTTP-probe
#    init image. Same commands, same securityContext.
#    2026.8.8/0001, 2026.9.9/0004 and 2026.10.3/0002 wrote the old image; their
#    `# superseded-images:` header points here.
#
# 2. The CrowdSec bouncer plugin v1.6.0 -> v1.8.1. In stream mode, which the
#    crowdsec Middleware uses, v1.7/v1.8 apply a stream's deletions before its
#    new decisions (a replaced ban could otherwise be deleted) and keep the
#    stream and metrics tickers apart. No option was renamed or removed; the
#    new streamStartupBlock defaults to the v1.6.0 behaviour.
#
# HOW: the release's own values, handed back whole with `-f` at the chart
# version it is deployed at (no chart change), with the two edits made in jq.
# The forwardedHeaders.trustedIPs args that platform-api's
# cluster-trusted-proxies reconciler patches onto the LIVE DaemonSet are carried,
# as in 2026.10.17/0001, or this roll would cut trust back to loopback.
#
# Blast radius (by design): the DaemonSet rolls (maxUnavailable=1, no surge —
# hostPorts); ingress on each node blips for the seconds its pod restarts. A
# Traefik that cannot load its plugins drops every router that uses one, so a
# pod reporting its plugins disabled rolls the release back, marks the change
# rejected and fails the script.
#
# Budget. The roll is one node at a time, so helm's wait scales with the
# DaemonSet (60s + 40s a node, at most 280s), and a rollback takes as long
# again. helm's --atomic is not used: its rollback would wait the full timeout a
# second time on top of everything else; the script rolls back itself, on a
# failed upgrade or a refused plugin, never both. The whole run must fit the
# host-config unit's 600s, which earlier migrations of the same converge have
# already used part of — so, as 2026.10.17/0008 does, a run that starts with too
# little of the 600s left defers to the next converge (exit 1, retried; this
# release's other migrations are then done and leave it the whole budget).

MIG="traefik-init-images-crowdsec-plugin"
INIT_IMAGE="curlimages/curl:8.23.0"
INIT_NAMES='["prepare-access-log","wait-for-plugin-registry"]'
PLUGIN_VERSION="v1.8.1"
MARKER="init=${INIT_IMAGE},crowdsec=${PLUGIN_VERSION}"
REJECTED_ANNOTATION="insula.host/traefik-values-rejected"
VERIFIED_ANNOTATION="insula.host/traefik-values-verified"
ATTEMPTS_ANNOTATION="insula.host/traefik-values-attempts"
MAX_ATTEMPTS=3
# Overridable for the clean-room test only; the runner's env carries neither.
KUBECONFIG_PATH="${HM_KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
PLUGIN_VERDICT_WAIT="${HM_PLUGIN_VERDICT_WAIT:-60}"

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

ns_annotation() { # ns_annotation <key> -> the traefik namespace's value, or ""
  kubectl get namespace traefik -o json | jq -r --arg a "$1" '.metadata.annotations[$a] // ""'
}
pod_ready_age() { # pod_ready_age <pod> -> seconds since it became Ready (0 if not Ready)
  local since
  since="$(kubectl -n traefik get pod "$1" -o jsonpath='{.status.conditions[?(@.type=="Ready")].lastTransitionTime}' 2>/dev/null || true)"
  [ -n "$since" ] || { echo 0; return; }
  echo $(( $(date +%s) - $(date -d "$since" +%s 2>/dev/null || date +%s) ))
}
# A pending-* release whose last revision is over 15 minutes old is a run that
# was killed (the host-config unit bounds a whole converge to 600s), not one in
# progress; rolling back to the last deployed revision is safe for Traefik.
recover_stale_pending() {
  local hist updated age rev
  hist="$(timeout 60 "$HELM" history traefik -n traefik -o json 2>/dev/null)" || return 1
  updated="$(jq -r '.[-1].updated // ""' <<<"$hist")"
  [ -n "$updated" ] || return 1
  age=$(( $(date +%s) - $(date -d "$updated" +%s 2>/dev/null || date +%s) ))
  [ "$age" -gt 900 ] || return 1
  rev="$(jq -r '[.[] | select(.status == "deployed" or .status == "superseded")] | last | .revision // empty' <<<"$hist")"
  [ -n "$rev" ] || return 1
  echo "${MIG}: the traefik release has been pending for ${age}s — a killed run; rolling it back to revision ${rev}." >&2
  timeout 300 "$HELM" rollback traefik "$rev" -n traefik --wait --timeout 240s >&2
}

# --- where the release is now -------------------------------------------------
HELM_ERR="$HELM_HOME_DIR/helm.err"
read_release() {
  local releases rel
  if ! releases="$(timeout 60 "$HELM" list -n traefik -a -o json 2>"$HELM_ERR")"; then
    echo "${MIG}: helm list failed — will retry on the next converge: $(cat "$HELM_ERR")" >&2
    exit 1
  fi
  rel="$(jq -c '[.[]? | select(.name == "traefik")][0] // {}' <<<"$releases")"
  deployed_ver="$(jq -r '.chart // ""' <<<"$rel" | sed -n 's/^traefik-//p')"
  status="$(jq -r '.status // ""' <<<"$rel")"
}
read_release
if [ -z "$deployed_ver" ]; then
  echo "${MIG}: traefik helm release not found in ns traefik (installed out-of-band?) — skipping." >&2
  exit 0
fi
case "$status" in
  pending-*)
    if recover_stale_pending; then
      read_release
    else
      echo "${MIG}: the traefik release is ${status} (an earlier helm run was cut short, or one is running) — not upgrading over it; the next converge retries." >&2
      exit 1
    fi ;;
esac

if ! values="$("$HELM" get values traefik -n traefik -o json 2>"$HELM_ERR")"; then
  echo "${MIG}: helm get values failed — will retry on the next converge: $(cat "$HELM_ERR")" >&2
  exit 1
fi
# A read that does not look like this platform's release would be installed as
# the entire configuration — refuse it instead.
if ! jq -e '.deployment.kind == "DaemonSet" and (.ports.websecure.hostPort // 0) == 443' <<<"$values" >/dev/null 2>&1; then
  echo "${MIG}: helm get values does not look like the bootstrap release (no DaemonSet/hostPort 443) — refusing to re-install it as the whole configuration." >&2
  exit 1
fi

# The two edits. An init container or plugin the release does not carry is left
# alone (an operator who removed one meant it); only images and the version change.
want="$(jq -c --arg img "$INIT_IMAGE" --argjson names "$INIT_NAMES" --arg pv "$PLUGIN_VERSION" '
  (if (.deployment.initContainers | type) == "array"
   then .deployment.initContainers |= map(if (.name as $n | $names | index($n)) != null then .image = $img else . end)
   else . end)
  | (if .experimental.plugins.crowdsec != null then .experimental.plugins.crowdsec.version = $pv else . end)' <<<"$values")"

need_upgrade=1
if [ "$status" = "deployed" ] && [ "$(jq -S . <<<"$want")" = "$(jq -S . <<<"$values")" ]; then
  if [ "$(ns_annotation "$VERIFIED_ANNOTATION")" = "$MARKER" ]; then
    echo "${MIG}: Traefik already runs its init containers on ${INIT_IMAGE} and the CrowdSec plugin ${PLUGIN_VERSION} — nothing to do."
    exit 0
  fi
  echo "${MIG}: the values are in place but the plugins were never confirmed loaded on them — checking them."
  need_upgrade=0
fi
# The revision to roll back to: the newest one that WORKED before this change —
# deployed or superseded, never a `failed` one an earlier run left current.
history_json="$(timeout 60 "$HELM" history traefik -n traefik -o json 2>/dev/null || echo '[]')"
if [ "$need_upgrade" -eq 1 ]; then
  rollback_rev="$(jq -r '[.[] | select(.status == "deployed" or .status == "superseded")] | last | .revision // empty' <<<"$history_json")"
else
  rollback_rev="$(jq -r '[.[] | select(.status == "superseded")] | last | .revision // empty' <<<"$history_json")"
fi

# How long the roll may take, and is there that much of the 600s left?
nodes="$(kubectl -n traefik get daemonset traefik -o jsonpath='{.status.desiredNumberScheduled}' 2>/dev/null || echo 1)"
case "$nodes" in ''|*[!0-9]*|0) nodes=1 ;; esac
HELM_TIMEOUT=$(( 60 + 40 * nodes )); [ "$HELM_TIMEOUT" -le 280 ] || HELM_TIMEOUT=280
NEEDED=$(( 40 + 2 * HELM_TIMEOUT + PLUGIN_VERDICT_WAIT )); [ "$NEEDED" -le 560 ] || NEEDED=560
if [ "$need_upgrade" -eq 1 ] && grep -q 'platform-ops-host-config.service' /proc/self/cgroup 2>/dev/null; then
  start_us="$(systemctl show -p InactiveExitTimestampMonotonic --value platform-ops-host-config.service 2>/dev/null || echo 0)"
  now_s="$(cut -d' ' -f1 /proc/uptime | cut -d. -f1)"
  case "$start_us" in ''|*[!0-9]*) start_us=0 ;; esac
  if [ "$start_us" -gt 0 ]; then
    elapsed=$(( now_s - start_us / 1000000 ))
    if [ "$elapsed" -gt $(( 600 - NEEDED )) ]; then
      echo "${MIG}: this converge has already run ${elapsed}s of its 600s and a ${nodes}-node roll may need ${NEEDED}s — deferring to the next converge." >&2
      exit 1
    fi
  fi
fi

if [ "$need_upgrade" -eq 1 ]; then
  if [ "$(ns_annotation "$REJECTED_ANNOTATION")" = "$MARKER" ]; then
    echo "${MIG}: Traefik refused its plugins on these values on an earlier attempt — not retrying (to retry: kubectl annotate namespace traefik ${REJECTED_ANNOTATION}-)." >&2
    exit 1
  fi
  attempts="$(ns_annotation "$ATTEMPTS_ANNOTATION")"
  n=0
  case "$attempts" in "${MARKER}:"*) n="${attempts##*:}" ;; esac
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  if [ "$n" -ge "$MAX_ATTEMPTS" ]; then
    echo "${MIG}: ${n} attempts failed — not retrying (to retry: kubectl annotate namespace traefik ${ATTEMPTS_ANNOTATION}-)." >&2
    exit 1
  fi

  timeout 20 "$HELM" repo add traefik https://traefik.github.io/charts >/dev/null 2>&1 || true
  timeout 20 "$HELM" repo update traefik >/dev/null 2>&1 || true

  # Carry the reconciler-owned trustedIPs args from the LIVE DaemonSet.
  live_args="$(kubectl -n traefik get daemonset traefik -o json \
    | jq -c '[.spec.template.spec.containers[] | select(.name == "traefik")][0].args // []')"
  args="$(jq -c '.additionalArguments // []' <<<"$want")"
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
  jq --argjson args "$args" '.additionalArguments = $args' <<<"$want" > "$VALUES_FILE"

  kubectl annotate namespace traefik --overwrite "${ATTEMPTS_ANNOTATION}=${MARKER}:$((n + 1))" >/dev/null
  echo "${MIG}: traefik chart ${deployed_ver} (unchanged): init containers -> ${INIT_IMAGE}, CrowdSec plugin -> ${PLUGIN_VERSION}, attempt $((n + 1)) of ${MAX_ATTEMPTS} …"
  # A roll that does not become ready is rolled back here, instead of leaving
  # a node without ingress (no surge, hostPorts) until a later converge.
  if ! "$HELM" upgrade traefik traefik/traefik \
      --namespace traefik \
      --version "$deployed_ver" \
      -f "$VALUES_FILE" \
      --wait \
      --timeout "${HELM_TIMEOUT}s"; then
    echo "${MIG}: the roll did not become ready within ${HELM_TIMEOUT}s — rolling back to revision ${rollback_rev:-previous}; the next converge retries." >&2
    "$HELM" rollback traefik ${rollback_rev:+"$rollback_rev"} -n traefik --wait --timeout "${HELM_TIMEOUT}s" >&2 || true
    exit 1
  fi

  live="$(kubectl -n traefik get daemonset traefik -o json)"
  bad="$(jq -r --arg img "$INIT_IMAGE" --argjson names "$INIT_NAMES" '
    [.spec.template.spec.initContainers[]? | select((.name as $n | $names | index($n)) != null and .image != $img) | .name] | join(",")' <<<"$live")"
  [ -z "$bad" ] || { echo "${MIG}: helm upgrade succeeded but init container(s) ${bad} do not run ${INIT_IMAGE}." >&2; exit 1; }
fi

# --- prove every pod LOADED its plugins ---------------------------------------
# A pod that cannot load a plugin still reports Ready, but Traefik then drops
# every router with a plugin middleware. Each pod logs one verdict at startup.
deadline=$(( $(date +%s) + PLUGIN_VERDICT_WAIT ))
while :; do
  pending=0; failed=""
  pods="$(kubectl -n traefik get pods -l app.kubernetes.io/name=traefik -o json \
    | jq -r '.items[] | select(.metadata.deletionTimestamp == null) | .metadata.name')"
  [ -n "$pods" ] || pending=1
  for pod in $pods; do
    verdicts="$(kubectl -n traefik logs "$pod" -c traefik 2>/dev/null | grep -E 'Plugins (are disabled|loaded)' || true)"
    if grep -q 'Plugins are disabled' <<<"$verdicts"; then
      failed="${failed} ${pod}"
    elif ! grep -q 'Plugins loaded' <<<"$verdicts"; then
      # A pod Ready for over 30 minutes whose startup line has rotated out of
      # its log: traefik-plugin-guard recycles a pod whose plugins failed, so
      # one this old loaded them. Only on the re-check path — after a roll
      # every pod is minutes old.
      if [ "$need_upgrade" -eq 0 ] && [ "$(pod_ready_age "$pod")" -gt 1800 ]; then continue; fi
      pending=$((pending + 1))
    fi
  done
  if [ -n "$failed" ] && [ "$need_upgrade" -eq 0 ]; then
    # Re-check path: these pods did not come from a roll in this run, so the
    # verdict may be a registry blip at their start, which traefik-plugin-guard
    # handles. Report it; do not roll back or reject.
    echo "${MIG}: Traefik reported its plugins disabled on${failed} — not marked verified; traefik-plugin-guard recycles such pods and the next converge checks again." >&2
    exit 1
  fi
  if [ -n "$failed" ]; then
    echo "${MIG}: Traefik reported its plugins disabled on${failed} — rolling the release back to revision ${rollback_rev:-previous} and marking these values rejected." >&2
    "$HELM" rollback traefik ${rollback_rev:+"$rollback_rev"} -n traefik --wait --timeout "${HELM_TIMEOUT}s" >&2 || true
    kubectl annotate namespace traefik --overwrite "${REJECTED_ANNOTATION}=${MARKER}" >&2 || true
    exit 1
  fi
  [ "$pending" -eq 0 ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "${MIG}: ${pending} Traefik pod(s) logged no plugin verdict within ${PLUGIN_VERDICT_WAIT}s — the next converge checks them again (not marked verified)." >&2
    exit 1
  fi
  sleep 5
done

kubectl annotate namespace traefik --overwrite "${VERIFIED_ANNOTATION}=${MARKER}" >/dev/null
kubectl annotate namespace traefik "${ATTEMPTS_ANNOTATION}-" >/dev/null 2>&1 || true
echo "${MIG}: applied — init containers on ${INIT_IMAGE}, CrowdSec plugin ${PLUGIN_VERSION}; every pod loaded its plugins."
