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
# The agent lives in platform-system (the crowdsec namespace enforces Pod
# Security `baseline`, which forbids the hostPath it needs), so the Secret goes
# there too. A Secret in the wrong namespace is the same failure with a more
# confusing symptom.
#
# The machine NAME is not stored here: the DaemonSet appends its pod name to
# this prefix so each node registers distinctly. Only the shared password lives
# in the Secret.

KUBECTL="${KUBECTL:-kubectl}"
NS="platform-system"
SECRET="crowdsec-agent-credentials"

command -v "$KUBECTL" >/dev/null 2>&1 || { echo "crowdsec-agent-credentials: kubectl not found — skipping"; exit 0; }

if ! "$KUBECTL" get namespace "$NS" >/dev/null 2>&1; then
  echo "crowdsec-agent-credentials: namespace ${NS} absent — nothing to do"
  exit 0
fi

if "$KUBECTL" get secret "$SECRET" -n "$NS" >/dev/null 2>&1; then
  echo "crowdsec-agent-credentials: already present — no change"
  exit 0
fi

# 32 bytes of urandom, same shape as the bouncer key bootstrap.sh generates.
pass="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)"

"$KUBECTL" create secret generic "$SECRET" -n "$NS" \
  --from-literal=username="insula-agent" \
  --from-literal=password="$pass" >/dev/null

echo "crowdsec-agent-credentials: created in ${NS}"
