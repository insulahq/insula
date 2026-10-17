#!/usr/bin/env bash
# description: Traefik ingress gets a 1Gi memory limit (was 512Mi) and at most 100 parallel HTTP/2 streams per connection; rolls the Traefik DaemonSet one node at a time.
# idempotent: the guard reads the LIVE DaemonSet and exits 0 when the traefik container's memory limit is already >= 1Gi and both entrypoints already carry an http2.maxConcurrentStreams argument <= 100, so a re-run costs one kubectl read. Never lowers a limit or loosens a cap an operator set tighter. Runs on CONTROL-PLANE nodes only (helm needs the admin kubeconfig); a second server finds the first one's result and skips.
# allow-paths: none — operates solely on the cluster via helm + the node kubeconfig; helm's cache/config/data dirs are redirected to a private mktemp -d (PrivateTmp) and removed on EXIT, because ProtectHome=yes makes $HOME/.config unwritable.
# blocks-on-failure: no    # ADR-056: headroom and a per-connection cap. The change that removes the production trigger is the compress Middleware, which Flux applies with the release; nothing later depends on this script.
# phase: before-services    # ADR-064: needs nothing from the new release
set -euo pipefail

# Bounds Traefik's memory on EXISTING clusters. scripts/bootstrap.sh installs
# the same values on fresh clusters (install_traefik: resources.limits.memory,
# additionalArguments[2..3]); scripts/test-traefik-ingress-memory-bounds.sh
# keeps the two in step.
#
# WHY: the Traefik DaemonSet was OOM-killed on two nodes of a production
# cluster 9 s apart, kernel-confirmed at the 512Mi limit. A webmail page loaded
# dozens of inline images at once over HTTP/2 and the shared `compress`
# Middleware held a brotli writer per image. The Middleware change (gzip only,
# text allowlist) removes that cost; this script adds the headroom and the
# per-connection ceiling around it:
#   * limits.memory 1Gi — the chart derives GOMEMLIMIT as 90% of the limit
#     (460MiB → 921MiB), so the Go runtime collects against the new ceiling.
#   * --entryPoints.{web,websecure}.http2.maxConcurrentStreams=100 — Traefik's
#     default is 250; 100 is what nginx/HAProxy use and what browsers need.
#
# Blast radius (by design, same as 2026.9.18/0002 and 2026.10.3/0002): a
# values change rolls the Traefik DaemonSet (maxUnavailable=1, no surge —
# hostPorts). Ingress on each node blips for the seconds its pod restarts,
# one node at a time.

MIG="traefik-ingress-memory-bounds"
WANT_MEMORY="1Gi"
WANT_MEMORY_MIB=1024
WANT_STREAMS=100
ENTRYPOINTS="web websecure"
# Overridable for the clean-room test only; the runner's env carries neither.
KUBECONFIG_PATH="${HM_KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

if [ -r "$KUBECONFIG_PATH" ]; then
  export KUBECONFIG="$KUBECONFIG_PATH"
else
  echo "${MIG}: no admin kubeconfig on this node (worker/least-priv) — skipping."
  exit 0
fi
command -v kubectl >/dev/null 2>&1 || { echo "${MIG}: kubectl not found on PATH — skipping." >&2; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "${MIG}: jq not found on PATH — cannot merge values safely." >&2; exit 1; }
if ! kubectl -n traefik get daemonset traefik >/dev/null 2>&1; then
  echo "${MIG}: no Traefik DaemonSet on this cluster — skipping."
  exit 0
fi

# Kubernetes memory quantity → MiB (integer, rounded down). Unknown → 0, which
# reads as "below target" and gets the target value.
to_mib() {
  local q="$1" n unit
  n="${q%%[!0-9.]*}"; unit="${q#"$n"}"
  [ -n "$n" ] || { echo 0; return; }
  case "$unit" in
    Ki) awk -v n="$n" 'BEGIN{printf "%d", n/1024}' ;;
    Mi) awk -v n="$n" 'BEGIN{printf "%d", n}' ;;
    Gi) awk -v n="$n" 'BEGIN{printf "%d", n*1024}' ;;
    Ti) awk -v n="$n" 'BEGIN{printf "%d", n*1048576}' ;;
    k)  awk -v n="$n" 'BEGIN{printf "%d", n*1000/1048576}' ;;
    M)  awk -v n="$n" 'BEGIN{printf "%d", n*1000000/1048576}' ;;
    G)  awk -v n="$n" 'BEGIN{printf "%d", n*1000000000/1048576}' ;;
    T)  awk -v n="$n" 'BEGIN{printf "%d", n*1000000000000/1048576}' ;;
    Pi) awk -v n="$n" 'BEGIN{printf "%d", n*1073741824}' ;;
    Ei) awk -v n="$n" 'BEGIN{printf "%d", n*1099511627776}' ;;
    P)  awk -v n="$n" 'BEGIN{printf "%d", n*1e15/1048576}' ;;
    E)  awk -v n="$n" 'BEGIN{printf "%d", n*1e18/1048576}' ;;
    e[0-9]*|E[0-9]*) awk -v n="$n" -v e="${unit#?}" 'BEGIN{printf "%d", n*(10^e)/1048576}' ;;
    "") awk -v n="$n" 'BEGIN{printf "%d", n/1048576}' ;;
    *)  echo 0 ;;
  esac
}
# Value of `--entryPoints.<ep>.http2.maxConcurrentStreams=` in a JSON arg list, or "".
streams_arg() { # <json-array> <entrypoint>
  jq -r --arg p "--entryPoints.$2.http2.maxConcurrentStreams=" \
    '[.[]? | strings | select(startswith($p)) | ltrimstr($p)] | last // ""' <<<"$1"
}
live_state() {
  kubectl -n traefik get daemonset traefik -o json \
    | jq -c '[.spec.template.spec.containers[] | select(.name == "traefik")][0]
             | {memory: (.resources.limits.memory // ""), args: (.args // []),
                gomemlimit: ([.env[]? | select(.name == "GOMEMLIMIT") | .value] | first // "")}'
}
satisfied() { # <live-state-json>
  local st="$1" ep v
  [ "$(to_mib "$(jq -r .memory <<<"$st")")" -ge "$WANT_MEMORY_MIB" ] || return 1
  for ep in $ENTRYPOINTS; do
    v="$(streams_arg "$(jq -c .args <<<"$st")" "$ep")"
    case "$v" in ''|*[!0-9]*) return 1 ;; esac
    # 0 is not "tighter": Go's HTTP/2 server reads 0 as its default (250).
    [ "$v" -ge 1 ] && [ "$v" -le "$WANT_STREAMS" ] || return 1
  done
}

live="$(live_state)"
if satisfied "$live"; then
  echo "${MIG}: already applied (memory $(jq -r .memory <<<"$live"), streams capped) — no change."
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

# --- pin the chart to what is ALREADY deployed (never move it) --------------
# A failed READ exits non-zero (the runner retries next converge); only a
# successful listing without the release means "nothing to do here".
# stderr goes to a file, not into the JSON: a helm warning there would make
# jq read "no release" and the script skip silently.
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
"$HELM" repo add traefik https://traefik.github.io/charts 2>/dev/null || true
"$HELM" repo update traefik >/dev/null 2>&1 || "$HELM" repo update >/dev/null 2>&1 || true

# Fail rather than fall back to {}: the additionalArguments list is rebuilt
# from these values, and an empty read would drop everything the release holds.
if ! values="$("$HELM" get values traefik -n traefik -o json 2>"$HELM_ERR")"; then
  echo "${MIG}: helm get values failed — will retry on the next converge: $(cat "$HELM_ERR")" >&2
  exit 1
fi
[ "$values" = "null" ] && values='{}'

# --- desired values ------------------------------------------------------------
# Memory: the larger of the release's limit and 1Gi — never shrink a limit an
# operator already raised.
cur_mem="$(jq -r '.resources.limits.memory // ""' <<<"$values")"
memory="$WANT_MEMORY"
if [ -n "$cur_mem" ] && [ "$(to_mib "$cur_mem")" -ge "$WANT_MEMORY_MIB" ]; then memory="$cur_mem"; fi

# additionalArguments: helm values REPLACE lists wholesale, so the full list is
# rebuilt from the release's own (forwardedHeaders.trustedIPs etc. survive).
# A cap already at or below 100 is kept; anything else becomes 100.
args="$(jq -c '.additionalArguments // []' <<<"$values")"
# The forwardedHeaders.trustedIPs args are owned by platform-api's
# cluster-trusted-proxies reconciler, which JSON-patches them onto the LIVE
# DaemonSet, outside the release (measured on a lab cluster: live
# 127.0.0.1/32,<pod CIDR>,<service CIDR>, release values 127.0.0.1/32 only).
# helm renders args from values, so the release's copy would roll Traefik with
# its trust list cut back to loopback until the reconciler's next 5-min tick
# re-patched it — a second roll. Carry the live value instead.
live_args="$(jq -c .args <<<"$live")"
for ep in $ENTRYPOINTS; do
  prefix="--entryPoints.${ep}.forwardedHeaders.trustedIPs="
  lv="$(jq -r --arg p "$prefix" '[.[] | strings | select(startswith($p))] | last // ""' <<<"$live_args")"
  [ -n "$lv" ] || continue
  args="$(jq -c --arg p "$prefix" --arg a "$lv" '
    if any(.[]; type == "string" and startswith($p))
    then map(if type == "string" and startswith($p) then $a else . end)
    else . + [$a] end' <<<"$args")"
done
for ep in $ENTRYPOINTS; do
  prefix="--entryPoints.${ep}.http2.maxConcurrentStreams="
  v="$(streams_arg "$args" "$ep")"
  case "$v" in ''|*[!0-9]*) v="" ;; esac
  if [ -z "$v" ] || [ "$v" -lt 1 ] || [ "$v" -gt "$WANT_STREAMS" ]; then v="$WANT_STREAMS"; fi
  args="$(jq -c --arg p "$prefix" --arg a "${prefix}${v}" \
    '[.[] | select((type == "string" and startswith($p)) | not)] + [$a]' <<<"$args")"
done

PATCH_FILE="$HELM_HOME_DIR/memory-bounds-values.json"
jq -n --argjson args "$args" --arg mem "$memory" \
  '{additionalArguments: $args, resources: {limits: {memory: $mem}}}' > "$PATCH_FILE"

echo "${MIG}: memory limit ${cur_mem:-unset} → ${memory}, http2.maxConcurrentStreams → ${WANT_STREAMS} (chart ${deployed_ver}) …"
# --reuse-values keeps the bootstrap-computed release (DaemonSet mode, hostPorts,
# plugin pins, access log, init containers); -f merges maps on top of it, so
# resources.requests survive and only limits.memory changes.
"$HELM" upgrade traefik traefik/traefik \
  --namespace traefik \
  --version "${deployed_ver}" \
  --reuse-values \
  -f "$PATCH_FILE" \
  --wait \
  --timeout 300s

# Prove it rendered — check the DaemonSet, not the values.
live="$(live_state)"
if satisfied "$live"; then
  echo "${MIG}: applied — memory $(jq -r .memory <<<"$live"), GOMEMLIMIT $(jq -r '.gomemlimit // "unset"' <<<"$live"), http2.maxConcurrentStreams ${WANT_STREAMS} on ${ENTRYPOINTS}."
else
  echo "${MIG}: helm upgrade succeeded but the DaemonSet does not show the new bounds: $(jq -c '{memory, args}' <<<"$live")" >&2
  exit 1
fi
