#!/usr/bin/env bash
# idempotent: exits 0 when the DaemonSet already carries an initContainer named
#             wait-for-plugin-registry; the patch itself is a server-side
#             strategic merge keyed on that name, so re-applying is a no-op.
# allow-paths: (none — cluster-only change via kube-API, touches no host file)
# blocks-on-failure: no    # ADR-056: nothing later depends on this. A node that
#                          # misses it keeps the old behaviour plus the
#                          # traefik-plugin-guard CronJob backstop.
set -euo pipefail

# 2026.8.8 — Traefik must not start before its plugin registry is reachable.
#
# Traefik downloads its Yaegi plugins at PROCESS START. If any one fails it
# disables the WHOLE plugin subsystem and keeps serving, so every router with a
# plugin middleware is dropped — including platform-ingress, which carries both
# panels. The cluster looks healthy (pods Ready, certs valid, Flux green) and
# admin.<apex> / tenant.<apex> return a bare 404. On a node reboot the network
# is routinely not up yet when Traefik starts: that took production down on
# 2026-08-20.
#
# bootstrap.sh now installs an initContainer that waits for the registry, but
# bootstrap runs ONCE at install time — this migration is what carries the same
# change onto already-bootstrapped clusters.
#
# Caching the plugins is NOT an alternative: measured against traefik v3.7.6
# with both archives present in /plugins-storage and no network, Traefik still
# calls the registry unconditionally and still disables plugins.

NS=traefik
DS=traefik
INIT_NAME=wait-for-plugin-registry
MIG="0001-traefik-wait-for-plugin-registry"

kube() { kubectl --kubeconfig=/etc/rancher/k3s/k3s.yaml "$@"; }

# Only the node that can reach the API server applies this; on a multi-node
# cluster the others no-op rather than fight over the same object.
if ! kube get --raw=/readyz >/dev/null 2>&1; then
  echo "${MIG}: kube-API not reachable from this node — skipping (another node applies it)"
  exit 0
fi

if ! kube -n "$NS" get daemonset "$DS" >/dev/null 2>&1; then
  echo "${MIG}: daemonset ${NS}/${DS} not present — nothing to patch"
  exit 0
fi

# Idempotence: already patched (fresh install, or a re-run).
if kube -n "$NS" get daemonset "$DS" \
     -o jsonpath='{.spec.template.spec.initContainers[*].name}' 2>/dev/null \
   | tr ' ' '\n' | grep -qx "$INIT_NAME"; then
  echo "${MIG}: ${INIT_NAME} already present — no-op"
  exit 0
fi

patch=$(cat <<'PATCH'
{
  "spec": {
    "template": {
      "spec": {
        "initContainers": [
          {
            "name": "wait-for-plugin-registry",
            "image": "alpine/k8s:1.33.13",
            "imagePullPolicy": "IfNotPresent",
            "securityContext": {
              "runAsNonRoot": true,
              "runAsUser": 65532,
              "allowPrivilegeEscalation": false,
              "readOnlyRootFilesystem": true,
              "capabilities": { "drop": ["ALL"] }
            },
            "resources": {
              "requests": { "cpu": "10m", "memory": "32Mi" },
              "limits": { "memory": "128Mi" }
            },
            "command": [
              "/bin/sh",
              "-c",
              "set -u\ntries=0\nmax=60\nuntil curl -fsS --max-time 5 -o /dev/null https://plugins.traefik.io/public/; do\n  tries=$((tries + 1))\n  if [ \"$tries\" -ge \"$max\" ]; then\n    echo \"wait-for-plugin-registry: still unreachable after $tries tries - starting anyway\" >&2\n    exit 0\n  fi\n  echo \"wait-for-plugin-registry: plugins.traefik.io unreachable (try $tries/$max) - waiting\"\n  sleep 5\ndone\necho \"wait-for-plugin-registry: registry reachable after $tries retries\"\n"
            ]
          }
        ]
      }
    }
  }
}
PATCH
)

if kube -n "$NS" patch daemonset "$DS" --type=strategic -p "$patch" >/dev/null 2>&1; then
  echo "${MIG}: traefik now waits for plugins.traefik.io before starting"
else
  echo "${MIG}: failed to patch daemonset ${NS}/${DS}" >&2
  exit 1
fi

# Deliberately NOT waiting for the rollout: this runs inside the host-config
# converger's timeout budget, and the DaemonSet rolls on its own. A stuck roll
# is the plugin-guard CronJob's problem, not this migration's.
echo "${MIG}: patch applied (DaemonSet rolls asynchronously)"
