#!/usr/bin/env bash
# idempotent: checks for the init container by NAME with -o jsonpath (never by
#             grepping `-o json` text — kubectl pretty-prints, see
#             2026.8.18/0001) and patches only when it is absent. Re-runs on a
#             patched DaemonSet write nothing and do not roll the pods.
# allow-paths: (none — cluster-only change via kube-API, touches no host file)
# blocks-on-failure: no    # ADR-056: Traefik keeps serving traffic either way.
#                          # What is lost is the access log, so the CrowdSec
#                          # agent detects nothing. Degraded detection, not an
#                          # outage; the converger retries next pass.
set -euo pipefail

# 2026.9.9 — let Traefik actually WRITE the access log 0001 just turned on.
#
# 0001 mounts a hostPath at /var/log/traefik. That is not sufficient, and the
# failure is silent. The kubelet creates a hostPath directory root:root 0755,
# while Traefik runs as uid 65532 with a read-only rootfs, so it cannot create
# the file inside it. Verified on a live node 2026-09-05:
#
#   WRN Unable to create access logger
#       error="...open /var/log/traefik/access.log: permission denied"
#
# A WARNING. Traefik then starts, serves traffic and reports Ready with no
# access log at all — so the CrowdSec agent tails a file that never appears and
# reports healthy while detecting nothing.
#
# An init container is used rather than a host-side mkdir because Traefik is a
# DaemonSet: this way every node fixes its own directory, including nodes added
# to the cluster after this migration has already run.

KUBECTL="${KUBECTL:-kubectl}"
NS="traefik"
DS="traefik"
INIT_NAME="prepare-access-log"

command -v "$KUBECTL" >/dev/null 2>&1 || { echo "traefik-access-log-ownership: kubectl not found — skipping"; exit 0; }

if ! "$KUBECTL" get daemonset "$DS" -n "$NS" >/dev/null 2>&1; then
  echo "traefik-access-log-ownership: DaemonSet ${NS}/${DS} not found — nothing to do"
  exit 0
fi

existing="$("$KUBECTL" get daemonset "$DS" -n "$NS" \
  -o jsonpath='{.spec.template.spec.initContainers[*].name}' 2>/dev/null || echo '')"

case " $existing " in
  *" $INIT_NAME "*)
    echo "traefik-access-log-ownership: already present — no change"
    exit 0
    ;;
esac

echo "traefik-access-log-ownership: adding ${INIT_NAME} to ${NS}/${DS}"

# Root is required to chown a root-owned directory and nothing less will do. It
# is scoped as tightly as the job allows: two capabilities, a read-only rootfs,
# no privilege escalation, one chown.
#
# chown ONLY — never `install -d` or chmod. Changing the MODE of a directory
# owned by someone else additionally needs CAP_FOWNER; `install -d` attempts it
# and fails with "can't change permissions ... Operation not permitted"
# (observed on DEV). The kubelet already creates it 0755, which is correct.
prepare_container='{
  "name":"'"$INIT_NAME"'",
  "image":"alpine/k8s:1.33.13",
  "imagePullPolicy":"IfNotPresent",
  "command":["/bin/sh","-c","set -eu; mkdir -p /var/log/traefik; chown 65532:65532 /var/log/traefik"],
  "securityContext":{
    "runAsUser":0,"runAsNonRoot":false,"allowPrivilegeEscalation":false,
    "readOnlyRootFilesystem":true,
    "capabilities":{"drop":["ALL"],"add":["CHOWN","DAC_OVERRIDE"]}
  },
  "resources":{"requests":{"cpu":"10m","memory":"16Mi"},"limits":{"memory":"64Mi"}},
  "volumeMounts":[{"name":"traefik-access-log","mountPath":"/var/log/traefik"}]
}'

# `initContainers` may be absent entirely on a cluster installed before the
# plugin-registry wait existed, and a JSON-patch `add` whose PARENT path is
# missing fails outright — so create the array, or append to it.
if [ -n "$existing" ]; then
  patch='[{"op":"add","path":"/spec/template/spec/initContainers/-","value":'"$prepare_container"'}]'
else
  patch='[{"op":"add","path":"/spec/template/spec/initContainers","value":['"$prepare_container"']}]'
fi

"$KUBECTL" patch daemonset "$DS" -n "$NS" --type=json -p "$patch" >/dev/null

echo "traefik-access-log-ownership: added — Traefik pods will roll to pick it up"
