#!/usr/bin/env bash
# description: Traefik loads Insula's own ModSecurity WAF plugin from a ConfigMap instead of the catalog plugin (one header bypassed it; bodies sat in Traefik's heap); rolls the DaemonSet node by node.
# idempotent: the guard reads the LIVE DaemonSet and the ConfigMap and exits 0 when Traefik already loads the local plugin from that ConfigMap, no catalog modsecurity plugin is configured, and the pod template's insula.host/modsecurity-plugin-sha256 equals the ConfigMap's content hash — a re-run costs two kubectl reads. A later release that changes the plugin source re-runs a copy of this script to re-stamp the hash. Runs on CONTROL-PLANE nodes only (helm needs the admin kubeconfig); a second server finds the first one's result and skips.
# allow-paths: none — operates solely on the cluster via helm + the node kubeconfig; helm's cache/config/data dirs are redirected to a private mktemp -d (PrivateTmp) and removed on EXIT, because ProtectHome=yes makes $HOME/.config unwritable.
# blocks-on-failure: no    # ADR-056: on failure the cluster keeps the previous, working Traefik (catalog plugin) and the next converge retries; no later migration depends on this one.
# phase: after-services    # ADR-064: needs the traefik-plugin-modsecurity ConfigMap, which Flux applies with this release's services
set -euo pipefail

# Switches EXISTING clusters to the in-repo plugin. scripts/bootstrap.sh
# installs the same values on fresh clusters (install_traefik);
# scripts/test-traefik-modsecurity-plugin-migration.sh keeps the two in step.
#
# WHY: madebymode/traefik-modsecurity-plugin v1.6.0 skipped the WAF for any
# request carrying `Upgrade: websocket`, and copied every request body (up to
# the 12.5 MiB cap) into Traefik's heap for the whole request. The platform now
# carries its own copy — k8s/base/traefik/plugins/modsecurity/README.md.
#
# How the values change (helm renders the DaemonSet from them):
#   * experimental.plugins.modsecurity      removed (no more catalog download)
#   * experimental.localPlugins.modsecurity type localPath, mounted from
#   * deployment.additionalVolumes          + traefik-plugin-modsecurity (ConfigMap)
#   * deployment.podAnnotations             insula.host/modsecurity-plugin-sha256
#     — Traefik reads plugin source only at startup; a new hash is what rolls
#     the DaemonSet onto new source.
# The key stays `modsecurity`, so the Middleware CRs are unchanged.
#
# Blast radius (by design, like 0001): the values change rolls the Traefik
# DaemonSet (maxUnavailable=1, no surge — hostPorts). Ingress on each node
# blips for the seconds its pod restarts, one node at a time. If a new pod
# reports its plugins disabled, the release is rolled back to the previous
# revision and the script fails, so a bad switch cannot leave the panels 404ing.

MIG="traefik-modsecurity-plugin-local"
MODULE="github.com/insulahq/insula/traefik-plugins/modsecurity"
MOUNT="/plugins-local/src/${MODULE}"
CONFIGMAP="traefik-plugin-modsecurity"
VOLUME="traefik-plugin-modsecurity"
ANNOTATION="insula.host/modsecurity-plugin-sha256"
REJECTED_ANNOTATION="insula.host/modsecurity-plugin-rejected-sha256"
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
command -v jq >/dev/null 2>&1 || { echo "${MIG}: jq not found on PATH — cannot edit values safely." >&2; exit 1; }
if ! kubectl -n traefik get daemonset traefik >/dev/null 2>&1; then
  echo "${MIG}: no Traefik DaemonSet on this cluster — skipping."
  exit 0
fi

# --- the plugin source, as Flux applied it ------------------------------------
# Missing or malformed means Flux has not applied this release's traefik
# kustomization (yet) — fail so the next converge retries, rather than point
# Traefik at a module it cannot load (which disables EVERY plugin: crowdsec too).
if ! cm="$(kubectl -n traefik get configmap "$CONFIGMAP" -o json 2>&1)"; then
  echo "${MIG}: ConfigMap traefik/${CONFIGMAP} not readable yet — will retry on the next converge: ${cm}" >&2
  exit 1
fi
if ! jq -e --arg mod "$MODULE" '
    (.data["modsecurity.go"] // "" | length > 0)
    and (.data["go.mod"] // "" | contains("module " + $mod))
    and (.data[".traefik.yml"] // "" | contains("import: " + $mod))' <<<"$cm" >/dev/null; then
  echo "${MIG}: ConfigMap traefik/${CONFIGMAP} does not hold module ${MODULE} — refusing to switch; will retry." >&2
  exit 1
fi
# Same hash bootstrap.sh stamps: sorted, compact .data.
sha="$(jq -S -c .data <<<"$cm" | sha256sum | awk '{print $1}')"
# A source Traefik already refused to load (see the end of this script) is not
# retried: every attempt would roll ingress on every node, twice, each converge.
rejected="$(jq -r --arg a "$REJECTED_ANNOTATION" '.metadata.annotations[$a] // ""' <<<"$cm")"
if [ "$rejected" = "$sha" ]; then
  echo "${MIG}: Traefik refused plugin source ${sha:0:12} on an earlier attempt — not retrying until the source changes (or: kubectl -n traefik annotate configmap ${CONFIGMAP} ${REJECTED_ANNOTATION}-)." >&2
  exit 1
fi

live_state() {
  kubectl -n traefik get daemonset traefik -o json | jq -c --arg ann "$ANNOTATION" '
    .spec.template as $t
    | ([$t.spec.containers[] | select(.name == "traefik")][0]) as $c
    | {args: ($c.args // []),
       mounts: [($c.volumeMounts // [])[] | {name, mountPath}],
       volumes: [($t.spec.volumes // [])[] | {name, configMap: (.configMap.name // null)}],
       sha: ($t.metadata.annotations[$ann] // "")}'
}
satisfied() { # <live-state-json>
  jq -e --arg mod "$MODULE" --arg mount "$MOUNT" --arg vol "$VOLUME" --arg cm "$CONFIGMAP" --arg sha "$sha" '
    any(.args[]; . == "--experimental.localPlugins.modsecurity.moduleName=" + $mod)
    and (any(.args[]; startswith("--experimental.plugins.modsecurity.")) | not)
    and any(.mounts[]; .name == $vol and .mountPath == $mount)
    and any(.volumes[]; .name == $vol and .configMap == $cm)
    and .sha == $sha' <<<"$1" >/dev/null
}

live="$(live_state)"
if satisfied "$live"; then
  echo "${MIG}: already applied (local plugin, source sha ${sha:0:12}) — no change."
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
# successful listing without the release means "nothing to do here". stderr
# goes to a file, not into the JSON.
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
# The revision to roll back to if Traefik cannot load the new source: the last
# one that DEPLOYED. `helm list` shows the newest, which after an earlier
# failed attempt is that failed revision.
prev_rev="$("$HELM" history traefik -n traefik -o json 2>/dev/null \
  | jq -r '[.[] | select(.status == "deployed")] | last | .revision // empty' 2>/dev/null || true)"
"$HELM" repo add traefik https://traefik.github.io/charts 2>/dev/null || true
"$HELM" repo update traefik >/dev/null 2>&1 || "$HELM" repo update >/dev/null 2>&1 || true

# The FULL user-supplied values, edited and handed back whole (no
# --reuse-values): removing the catalog plugin needs a key deleted, which a
# merged patch cannot express. A read that does not look like this platform's
# release would be installed as the entire configuration — refuse it instead.
if ! values="$("$HELM" get values traefik -n traefik -o json 2>"$HELM_ERR")"; then
  echo "${MIG}: helm get values failed — will retry on the next converge: $(cat "$HELM_ERR")" >&2
  exit 1
fi
if ! jq -e '.deployment.kind == "DaemonSet" and (.ports.websecure.hostPort // 0) == 443' <<<"$values" >/dev/null 2>&1; then
  echo "${MIG}: helm get values does not look like the bootstrap release (no DaemonSet/hostPort 443) — refusing to re-install it as the whole configuration." >&2
  exit 1
fi

# The forwardedHeaders.trustedIPs args are owned by platform-api's
# cluster-trusted-proxies reconciler, which JSON-patches them onto the LIVE
# DaemonSet, outside the release. helm renders args from values, so carry the
# live value — otherwise this roll cuts the trust list back to loopback and the
# reconciler's next tick rolls Traefik a second time (same as 0001).
live_args="$(jq -c .args <<<"$live")"
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
jq --argjson args "$args" --arg mod "$MODULE" --arg mount "$MOUNT" \
   --arg vol "$VOLUME" --arg cm "$CONFIGMAP" --arg ann "$ANNOTATION" --arg sha "$sha" '
  .additionalArguments = $args
  | del(.experimental.plugins.modsecurity)
  | .experimental.localPlugins.modsecurity =
      {type: "localPath", moduleName: $mod, mountPath: $mount, volumeName: $vol}
  | .deployment.additionalVolumes =
      ([(.deployment.additionalVolumes // [])[] | select(.name != $vol)]
       + [{name: $vol, configMap: {name: $cm}}])
  | .deployment.podAnnotations = ((.deployment.podAnnotations // {}) + {($ann): $sha})
' <<<"$values" > "$VALUES_FILE"

echo "${MIG}: Traefik → local ModSecurity plugin ${MODULE} (source sha ${sha:0:12}, chart ${deployed_ver}) …"
# --atomic: an upgrade that does not become ready is rolled back by helm itself.
# Without it a timeout leaves the release `failed` and, with maxUnavailable=1
# and no surge (hostPorts), one node without ingress until a later converge.
"$HELM" upgrade traefik traefik/traefik \
  --namespace traefik \
  --version "${deployed_ver}" \
  -f "$VALUES_FILE" \
  --atomic \
  --wait \
  --timeout 300s

live="$(live_state)"
if ! satisfied "$live"; then
  echo "${MIG}: helm upgrade succeeded but the DaemonSet does not show the local plugin: $(jq -c '{sha, volumes}' <<<"$live")" >&2
  exit 1
fi

# --- prove the plugin LOADED -----------------------------------------------
# A pod that cannot load a plugin still reports Ready, but Traefik then drops
# every router with a plugin middleware — both panels and every WAF route. Each
# pod logs one verdict at startup; wait for all of them.
deadline=$(( $(date +%s) + PLUGIN_VERDICT_WAIT ))
while :; do
  pending=0; failed=""; ours=0
  pods="$(kubectl -n traefik get pods -l app.kubernetes.io/name=traefik -o json \
    | jq -r '.items[] | select(.metadata.deletionTimestamp == null) | .metadata.name')"
  # No pods is not "all loaded".
  [ -n "$pods" ] || pending=1
  for pod in $pods; do
    logs="$(kubectl -n traefik logs "$pod" -c traefik --tail=500 2>/dev/null || true)"
    if grep -q 'Plugins are disabled' <<<"$logs"; then
      failed="${failed} ${pod}"
      # Our module in the error = the source. Anything else (a crowdsec
      # download timing out) is transient and traefik-plugin-guard's to recycle.
      disabled="$(grep 'Plugins are disabled' <<<"$logs")"
      grep -q 'modsecurity' <<<"$disabled" && ours=1
    elif ! grep -q 'Plugins loaded' <<<"$logs"; then pending=$((pending + 1)); fi
  done
  if [ -n "$failed" ] && [ "$ours" -eq 1 ]; then
    echo "${MIG}: Traefik could not load plugin source ${sha:0:12} on${failed} — rolling the release back to revision ${prev_rev:-previous} and marking that source rejected." >&2
    "$HELM" rollback traefik ${prev_rev:+"$prev_rev"} -n traefik --wait --timeout 300s >&2 || true
    kubectl -n traefik annotate configmap "$CONFIGMAP" --overwrite "${REJECTED_ANNOTATION}=${sha}" >&2 || true
    exit 1
  fi
  if [ -n "$failed" ]; then
    echo "${MIG}: plugins disabled on${failed}, not by ${MODULE} (a catalog download?) — traefik-plugin-guard recycles those pods; re-checking on the next converge." >&2
    exit 1
  fi
  [ "$pending" -eq 0 ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "${MIG}: ${pending} Traefik pod(s) logged no plugin verdict within ${PLUGIN_VERDICT_WAIT}s — leaving them to traefik-plugin-guard; will re-check on the next converge." >&2
    exit 1
  fi
  sleep 5
done
echo "${MIG}: applied — every Traefik pod loaded the local plugin (source sha ${sha:0:12})."
