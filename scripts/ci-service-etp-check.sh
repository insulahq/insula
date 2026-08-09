#!/usr/bin/env bash
# ci-service-etp-check.sh — guard how the Traefik Service's
# externalTrafficPolicy is set, in BOTH directions.
#
# Background. The Traefik Service is `type: ClusterIP`. The
# ingress-external-ips reconciler adds `.spec.externalIPs` to it from the live
# Node, which hands node:80/443 to kube-proxy. Under the default `Cluster`
# policy kube-proxy SNATs every external client to the node's own address
# BEFORE Traefik sees it — CrowdSec, the WAF, the panels' real_ip chain and
# every tenant workload then see the node IP instead of the client. Measured
# 2026-08-09: waf-crowdsec 57 pass / 1 fail became 57 / 0 once the policy was
# set to `Local`.
#
# The two fields are only JOINTLY VALID. The apiserver accepts
# `.spec.externalTrafficPolicy` only on a Service it considers externally
# accessible: LoadBalancer, NodePort, or ClusterIP **with a non-empty
# externalIPs**. So:
#
#   * Setting the policy at helm-install time — when the Service is ClusterIP
#     and externalIPs is still empty — fails the install outright:
#         Error: Service "traefik" is invalid: spec.externalTrafficPolicy:
#         Invalid value: "Local": may only be set for externally-accessible services
#     Caught on a fresh --dual-stack bootstrap 2026-08-09. Nothing else catches
#     it: no unit test, no lint and no live-cluster patch reproduces a FRESH
#     install, so the failure is invisible until someone provisions a new node.
#
#   * Dropping the policy from the reconciler's patch silently restores the
#     masquerade on every cluster. That regression is invisible too — every
#     request still succeeds, it just carries the wrong source IP.
#
# Hence two assertions, one per direction.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BOOTSTRAP="scripts/bootstrap.sh"
CRONJOB="k8s/base/ingress-external-ips/cronjob.yaml"
errors=0

# ── 1. bootstrap.sh must NOT set the policy on the helm command line ────────
# Match only an actual `--set ...externalTrafficPolicy...` flag, so the design
# commentary explaining WHY it is absent does not trip the guard.
if [[ ! -f "$BOOTSTRAP" ]]; then
  echo "FAIL: $BOOTSTRAP missing"
  errors=$((errors + 1))
elif grep -nE -- '--set[[:space:]="'"'"']*[A-Za-z.]*externalTrafficPolicy' "$BOOTSTRAP"; then
  echo "FAIL: $BOOTSTRAP passes externalTrafficPolicy to helm."
  echo "      The Traefik Service is ClusterIP with no externalIPs at install"
  echo "      time, so the apiserver REJECTS the policy and the whole bootstrap"
  echo "      dies at 'Installing Traefik v3 Ingress Controller'."
  echo "      Let ${CRONJOB} set externalIPs + policy in one patch instead."
  errors=$((errors + 1))
fi

# ── 2. the reconciler patch must set BOTH fields, in the SAME patch ─────────
if [[ ! -f "$CRONJOB" ]]; then
  echo "FAIL: $CRONJOB missing"
  errors=$((errors + 1))
else
  # The patch is built as a single JSON object; both keys must appear on the
  # same line so they are applied atomically. Two separate patches would fail:
  # a policy-only patch on a Service that has no externalIPs yet is invalid.
  if ! grep -qE 'externalIPs.*externalTrafficPolicy|externalTrafficPolicy.*externalIPs' "$CRONJOB"; then
    echo "FAIL: $CRONJOB does not set externalIPs and externalTrafficPolicy in one patch."
    echo "      externalIPs alone re-enables kube-proxy's SNAT and every external"
    echo "      client is seen as the node itself (CrowdSec bans, WAF rules, tenant"
    echo "      access logs and real_ip all break, silently — requests still 200)."
    errors=$((errors + 1))
  fi
  # Quoting inside the CronJob's inline shell is heavily escaped
  # (\"externalTrafficPolicy\":\"Local\"), so assert co-occurrence on the line
  # rather than an exact JSON spelling.
  if ! grep -qE 'externalTrafficPolicy.*Local' "$CRONJOB"; then
    echo "FAIL: $CRONJOB does not patch externalTrafficPolicy=Local."
    echo "      'Cluster' is the masquerading default. 'Local' is safe here only"
    echo "      because Traefik is a DaemonSet — every eligible node has a local"
    echo "      endpoint, so kube-proxy has nothing to drop."
    errors=$((errors + 1))
  fi
fi

if [[ "$errors" -gt 0 ]]; then
  echo
  echo "ci-service-etp-check: ${errors} failure(s)"
  echo "See scripts/ci-service-etp-check.sh header for the incidents this guard prevents."
  exit 1
fi

echo "ci-service-etp-check: OK"
