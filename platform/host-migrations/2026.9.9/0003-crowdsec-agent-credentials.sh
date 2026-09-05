#!/usr/bin/env bash
# idempotent: creates the Secret only when absent (checked with `kubectl get`,
#             not by parsing output text). An existing Secret is reused
#             untouched, so re-runs never rotate a credential out from under a
#             running agent.
# allow-paths: (none — cluster-only change via kube-API, touches no host file)
# blocks-on-failure: no    # ADR-056: without it the agent DaemonSet stays at 0
#                          # ready with FailedMount. Degraded detection, not an
#                          # outage, and the converger retries next pass.
set -euo pipefail

# 2026.9.9 — create the CrowdSec agent credentials on already-installed clusters.
#
# bootstrap.sh generates this Secret, but bootstrap runs at INSTALL time. Every
# cluster installed before the log-processing agent existed has no such Secret,
# so the DaemonSet ships and then sits at 0/1 with FailedMount — visibly broken,
# but only after a deploy, and only if someone looks.
#
# It is needed in TWO namespaces. The agent DaemonSet lives in platform-system
# (the crowdsec namespace enforces Pod Security `baseline`, which forbids the
# hostPath it needs); the LAPI in crowdsec reads the same credentials to CREATE
# the machine. Missing either one fails silently in its own way — FailedMount on
# one side, an agent authenticating as a non-existent machine on the other.
#
# The username is a WHOLE machine name, not a prefix. The LAPI registers
# exactly one machine and the agent must present exactly that name, so the
# fleet shares one identity (ROADMAP R31 tracks per-node identity).

KUBECTL="${KUBECTL:-kubectl}"
SECRET="crowdsec-agent-credentials"
# BOTH namespaces, same values. platform-system runs the agent DaemonSet (the
# crowdsec namespace enforces Pod Security `baseline`, which forbids its
# hostPath); crowdsec runs the LAPI, whose entrypoint CREATES the machine from
# these same credentials. Without the LAPI copy the machine is never registered
# and the agent authenticates as something that does not exist, while staying up
# and reporting healthy. Secrets are namespace-scoped — one object cannot serve
# both.
NAMESPACES="platform-system crowdsec"

command -v "$KUBECTL" >/dev/null 2>&1 || { echo "crowdsec-agent-credentials: kubectl not found — skipping"; exit 0; }

# Reuse an existing password from EITHER namespace so a partially-applied run
# (or an install that predates the LAPI copy) converges to one shared value
# instead of minting a second, mismatched credential.
pass=""
for ns in $NAMESPACES; do
  if existing="$("$KUBECTL" get secret "$SECRET" -n "$ns" -o jsonpath='{.data.password}' 2>/dev/null)" \
     && [ -n "$existing" ]; then
    pass="$(printf '%s' "$existing" | base64 -d 2>/dev/null || true)"
    [ -n "$pass" ] && break
  fi
done

if [ -z "$pass" ]; then
  # 32 bytes of urandom, same shape as the bouncer key bootstrap.sh generates.
  pass="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)"
fi

changed=0
for ns in $NAMESPACES; do
  "$KUBECTL" get namespace "$ns" >/dev/null 2>&1 || continue
  if "$KUBECTL" get secret "$SECRET" -n "$ns" >/dev/null 2>&1; then
    continue
  fi
  "$KUBECTL" create secret generic "$SECRET" -n "$ns" \
    --from-literal=username="insula-agent" \
    --from-literal=password="$pass" >/dev/null
  echo "crowdsec-agent-credentials: created in ${ns}"
  changed=1
done

[ "$changed" -eq 0 ] && echo "crowdsec-agent-credentials: already present — no change"
exit 0
