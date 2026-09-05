#!/usr/bin/env bash
# idempotent: reads the live Traefik DaemonSet's current accessLog config with
#             -o jsonpath (never by grepping `-o json` text — kubectl
#             pretty-prints, see 2026.8.18/0001) and patches only when access
#             logging is absent. A node whose Traefik already has it writes
#             nothing and re-runs are free.
# allow-paths: (none — cluster-only change via kube-API, touches no host file)
# blocks-on-failure: no    # ADR-056: the CrowdSec agent DaemonSet simply finds
#                          # no access log to parse and reports healthy while
#                          # detecting nothing. Degraded detection, not an
#                          # outage; the migration re-runs on the next pass.
set -euo pipefail

# 2026.9.9 — turn on Traefik's JSON access log on already-installed clusters.
#
# bootstrap.sh now writes `accessLog:` into the Traefik helm values, but that
# reaches FRESH INSTALLS ONLY — an existing cluster keeps the values it was
# installed with. Without this migration the CrowdSec agent added in the same
# release parses an empty log source forever: the DaemonSet runs, reports
# Ready, and http-probing / http-crawl-non-statics can never fire. Precisely
# the failure mode the agent was added to close, reproduced one layer down.
#
# It is also the platform's only per-request record. On 2026-09-05 a route was
# failing 100% of its requests and there was no way to determine who was
# calling it, because no source IP, path or user-agent is recorded anywhere.
#
# NOTE ON SCOPE: this patches the DaemonSet directly rather than re-running
# helm. Helm is not guaranteed present on a node at migration time, and a
# `helm upgrade` would re-reconcile the whole chart — far more blast radius
# than one field. The next bootstrap/helm run converges to the same value
# because bootstrap.sh now carries it in the values file.

KUBECTL="${KUBECTL:-kubectl}"
NS="traefik"
DS="traefik"

command -v "$KUBECTL" >/dev/null 2>&1 || { echo "traefik-access-log: kubectl not found — skipping"; exit 0; }

if ! "$KUBECTL" get daemonset "$DS" -n "$NS" >/dev/null 2>&1; then
  echo "traefik-access-log: DaemonSet ${NS}/${DS} not found — nothing to do"
  exit 0
fi

# Traefik reads its static config from CLI args on the DaemonSet. Access
# logging is on when --accesslog is present among them.
args="$("$KUBECTL" get daemonset "$DS" -n "$NS" \
  -o jsonpath='{.spec.template.spec.containers[0].args}' 2>/dev/null || echo '')"

# Test for the FILEPATH flag, not a bare `--accesslog`. `--accesslog=true` on
# its own logs to stdout, which the agent cannot read (the kubelet wraps stdout
# in the CRI envelope and the parser needs bare JSON). A cluster in that state
# is exactly the one this migration must still fix, so it must not be mistaken
# for a finished one.
case "$args" in
  *--accesslog.filepath*)
    echo "traefik-access-log: already enabled — no change"
    exit 0
    ;;
esac

echo "traefik-access-log: enabling JSON access log on ${NS}/${DS}"

# Append the access-log flags. A JSON-patch `add` at index '-' appends without
# rewriting the existing args, so unrelated flags (plugin config, entrypoints,
# provider settings) are preserved exactly.
#
# Headers: User-Agent is REQUIRED — the crowdsecurity/whitelists collection
# verifies search-engine crawlers by user-agent + reverse DNS, and without it
# http-crawl-non-statics would ban Googlebot from every tenant site once it is
# promoted out of simulation. Referer aids triage. Everything else is dropped:
# this log is read by a DaemonSet and lands in node-local files, so it must
# never carry Cookie or Authorization.
#
# The log must go to a FILE on a hostPath, not stdout: the agent is a separate
# DaemonSet and reads it through the node filesystem.
#
# And the mount alone is not enough. The kubelet creates a hostPath directory
# root:root 0755 while Traefik runs as uid 65532 with a read-only rootfs, so it
# cannot create the file — and it only WARNS, then serves traffic and reports
# Ready with no access log at all (verified on a live node 2026-09-05). The
# init container below chowns the directory so that cannot happen.
#
# `initContainers` may be absent entirely on a cluster installed before the
# plugin-registry wait existed, and a JSON-patch `add` to a path whose parent
# is missing fails — so create the array or append to it, as appropriate.
if "$KUBECTL" get daemonset "$DS" -n "$NS" \
     -o jsonpath='{.spec.template.spec.initContainers}' 2>/dev/null | grep -q '\[' ; then
  init_op='{"op":"add","path":"/spec/template/spec/initContainers/-","value":'
else
  init_op='{"op":"add","path":"/spec/template/spec/initContainers","value":['
fi

prepare_container='{
  "name":"prepare-access-log",
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

if [ "$init_op" = '{"op":"add","path":"/spec/template/spec/initContainers","value":[' ]; then
  init_patch="${init_op}${prepare_container}]}"
else
  init_patch="${init_op}${prepare_container}}"
fi

"$KUBECTL" patch daemonset "$DS" -n "$NS" --type=json -p '[
  {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--accesslog=true"},
  {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--accesslog.filepath=/var/log/traefik/access.log"},
  {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--accesslog.format=json"},
  {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--accesslog.fields.headers.defaultmode=drop"},
  {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--accesslog.fields.headers.names.User-Agent=keep"},
  {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--accesslog.fields.headers.names.Referer=keep"},
  {"op":"add","path":"/spec/template/spec/volumes/-","value":{"name":"traefik-access-log","hostPath":{"path":"/var/log/traefik","type":"DirectoryOrCreate"}}},
  {"op":"add","path":"/spec/template/spec/containers/0/volumeMounts/-","value":{"name":"traefik-access-log","mountPath":"/var/log/traefik"}},
  '"$init_patch"'
]' >/dev/null

echo "traefik-access-log: enabled — Traefik pods will roll to pick it up"
