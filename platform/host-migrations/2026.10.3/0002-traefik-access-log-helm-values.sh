#!/usr/bin/env bash
# idempotent: the guard reads the LIVE DaemonSet args and the release values and exits 0 when Traefik already runs with --accesslog.filepath and accessLog.enabled is true in the values, so a re-run costs two reads and changes nothing. Runs on CONTROL-PLANE nodes only (helm needs the admin kubeconfig); a second server finds the first one's result and skips.
# allow-paths: none — operates solely on the cluster via helm + the node kubeconfig; helm's cache/config/data dirs are redirected to a private mktemp -d (PrivateTmp) and removed on EXIT, because ProtectHome=yes makes $HOME/.config unwritable.
# blocks-on-failure: no    # ADR-056: detection quality only. Without it the CrowdSec agent parses no HTTP access log; ingress itself is unaffected, and nothing later depends on this script.
set -euo pipefail

# Turn Traefik's access log on, durably, through the Helm release values.
#
# Two defects compounded into "no access log anywhere":
#
#  1. bootstrap.sh's Traefik values set accessLog.filePath/format/fields but
#     never accessLog.enabled. The chart renders every --accesslog* argument
#     inside `{{- if .enabled }}`, so FRESH installs never logged a request.
#  2. On clusters installed before those values existed, 2026.9.9/0001 added the
#     --accesslog* arguments with `kubectl patch`, outside the release. The next
#     `helm upgrade --reuse-values` (2026.9.18/0002, latency buckets) re-rendered
#     the container args from values and dropped them; the patched volume
#     survived (volumes merge by name), so 2026.9.9/0001 replayed on a new node
#     then failed with "Duplicate value: traefik-access-log".
#
# Either way the CrowdSec agent DaemonSet had nothing to parse: its HTTP rate
# scenarios (probing, crawling) could never fire, and there was no per-request
# record of source IP, path or user agent.
#
# Fix: put the complete access-log configuration that bootstrap.sh installs on
# fresh clusters into the release values — accessLog (enabled), the hostPath
# volume and mount, and the init containers — so no later helm upgrade can drop
# it. Lists are MERGED by name with what the release already holds (helm values
# replace lists wholesale), and objects that today exist only as kubectl patches
# on the live DaemonSet (same names) are adopted, not duplicated: the API server
# merges containers, volumes and mounts by name.
#
# Blast radius (by design, same as 2026.9.18/0002): a values change rolls the
# Traefik DaemonSet (maxUnavailable=1, no surge — hostPorts). Ingress on each
# node blips for the seconds its pod restarts, one node at a time.

MIG="traefik-access-log-helm-values"
LOG_PATH="/var/log/traefik/access.log"

if [ -r /etc/rancher/k3s/k3s.yaml ]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
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

live_args="$(kubectl -n traefik get daemonset traefik \
  -o jsonpath='{.spec.template.spec.containers[0].args}' 2>/dev/null || true)"
values="$("$HELM" get values traefik -n traefik -o json 2>/dev/null || echo '{}')"
[ "$values" = "null" ] && values='{}'

# --- guard: already rendered from the release values? ----------------------
if [ "$(jq -r '.accessLog.enabled // false' <<<"$values")" = "true" ]; then
  case "$live_args" in
    *"--accesslog.filepath=${LOG_PATH}"*)
      echo "${MIG}: access log already enabled through the release values — no change."
      exit 0
      ;;
  esac
fi

# --- pin the chart to what is ALREADY deployed (never move it) --------------
deployed_ver=$("$HELM" list -n traefik -o json 2>/dev/null \
  | jq -r '.[] | select(.name == "traefik") | .chart' | sed -n 's/^traefik-//p' | head -n1)
if [ -z "$deployed_ver" ]; then
  echo "${MIG}: traefik helm release not found in ns traefik (installed out-of-band?) — skipping." >&2
  exit 0
fi
"$HELM" repo add traefik https://traefik.github.io/charts 2>/dev/null || true
"$HELM" repo update traefik >/dev/null 2>&1 || "$HELM" repo update >/dev/null 2>&1 || true

# --- desired values: generated from bootstrap.sh's fresh-install TRAEFIKVALUES
# (accessLog, additionalVolumeMounts, deployment.additionalVolumes,
# deployment.initContainers) — keep the two in sync; the test diffs them.
DESIRED="$(cat <<'DESIREDJSON'
{
  "accessLog": {
    "enabled": true,
    "filePath": "/var/log/traefik/access.log",
    "format": "json",
    "fields": {
      "headers": {
        "defaultMode": "drop",
        "names": {
          "User-Agent": "keep",
          "Referer": "keep"
        }
      }
    }
  },
  "additionalVolumeMounts": [
    {
      "name": "traefik-access-log",
      "mountPath": "/var/log/traefik"
    }
  ],
  "deployment": {
    "additionalVolumes": [
      {
        "name": "traefik-access-log",
        "hostPath": {
          "path": "/var/log/traefik",
          "type": "DirectoryOrCreate"
        }
      }
    ],
    "initContainers": [
      {
        "name": "prepare-access-log",
        "image": "alpine/k8s:1.33.13",
        "imagePullPolicy": "IfNotPresent",
        "securityContext": {
          "runAsUser": 0,
          "runAsNonRoot": false,
          "allowPrivilegeEscalation": false,
          "readOnlyRootFilesystem": true,
          "capabilities": {
            "drop": [
              "ALL"
            ],
            "add": [
              "CHOWN",
              "DAC_OVERRIDE"
            ]
          }
        },
        "resources": {
          "requests": {
            "cpu": "10m",
            "memory": "16Mi"
          },
          "limits": {
            "memory": "64Mi"
          }
        },
        "volumeMounts": [
          {
            "name": "traefik-access-log",
            "mountPath": "/var/log/traefik"
          }
        ],
        "command": [
          "/bin/sh",
          "-c",
          "set -eu\nmkdir -p /var/log/traefik\nchown 65532:65532 /var/log/traefik\n"
        ]
      },
      {
        "name": "wait-for-plugin-registry",
        "image": "alpine/k8s:1.33.13",
        "imagePullPolicy": "IfNotPresent",
        "securityContext": {
          "runAsNonRoot": true,
          "runAsUser": 65532,
          "allowPrivilegeEscalation": false,
          "readOnlyRootFilesystem": true,
          "capabilities": {
            "drop": [
              "ALL"
            ]
          }
        },
        "resources": {
          "requests": {
            "cpu": "10m",
            "memory": "32Mi"
          },
          "limits": {
            "memory": "128Mi"
          }
        },
        "command": [
          "/bin/sh",
          "-c",
          "set -u\ntries=0\nmax=60\nuntil curl -fsS --max-time 5 -o /dev/null https://plugins.traefik.io/public/; do\n  tries=$((tries + 1))\n  if [ \"$tries\" -ge \"$max\" ]; then\n    echo \"wait-for-plugin-registry: still unreachable after $tries tries - starting anyway; traefik-plugin-guard will recycle if plugins fail\" >&2\n    exit 0\n  fi\n  echo \"wait-for-plugin-registry: plugins.traefik.io unreachable (try $tries/$max) - waiting\"\n  sleep 5\ndone\necho \"wait-for-plugin-registry: registry reachable after $tries retries\"\n"
        ]
      }
    ]
  }
}
DESIREDJSON
)"

# Merge lists by name: keep everything the release already has, add only what
# is missing. A plain -f would REPLACE each list and drop existing entries.
PATCH_FILE="$HELM_HOME_DIR/access-log-values.json"
jq -n --argjson cur "$values" --argjson want "$DESIRED" '
  def union_by_name(a; b): (a // []) + [ (b // [])[] | select(.name as $n | ((a // []) | map(.name) | index($n)) == null) ];
  {
    accessLog: (($cur.accessLog // {}) * $want.accessLog),
    additionalVolumeMounts: union_by_name($cur.additionalVolumeMounts; $want.additionalVolumeMounts),
    deployment: {
      additionalVolumes: union_by_name($cur.deployment.additionalVolumes; $want.deployment.additionalVolumes),
      initContainers: union_by_name($cur.deployment.initContainers; $want.deployment.initContainers)
    }
  }' > "$PATCH_FILE"

echo "${MIG}: enabling the access log through the release values (chart ${deployed_ver}) …"
"$HELM" upgrade traefik traefik/traefik \
  --namespace traefik \
  --version "${deployed_ver}" \
  --reuse-values \
  -f "$PATCH_FILE" \
  --wait \
  --timeout 300s

# Prove it rendered — the original defect was values that LOOKED right.
live_args="$(kubectl -n traefik get daemonset traefik \
  -o jsonpath='{.spec.template.spec.containers[0].args}' 2>/dev/null || true)"
case "$live_args" in
  *"--accesslog.filepath=${LOG_PATH}"*)
    echo "${MIG}: applied — Traefik now writes ${LOG_PATH} on every node."
    ;;
  *)
    echo "${MIG}: helm upgrade succeeded but the DaemonSet still has no --accesslog.filepath — the chart did not render it." >&2
    exit 1
    ;;
esac
