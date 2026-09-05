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

case "$args" in
  *--accesslog*)
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
"$KUBECTL" patch daemonset "$DS" -n "$NS" --type=json -p '[
  {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--accesslog=true"},
  {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--accesslog.format=json"},
  {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--accesslog.fields.headers.defaultmode=drop"},
  {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--accesslog.fields.headers.names.User-Agent=keep"},
  {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--accesslog.fields.headers.names.Referer=keep"}
]' >/dev/null

echo "traefik-access-log: enabled — Traefik pods will roll to pick it up"
