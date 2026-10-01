#!/usr/bin/env bash
# scripts/test-platform-api-exec-scope.sh — LIVE check of the
# platform-api-pods-exec-scope admission policy
# (k8s/base/platform-api-guardrails/pods-exec-scope.yaml).
#
# Impersonates the platform-api ServiceAccount and attempts `true` in one
# running pod per namespace:
#   expected ALLOWED: platform, mail, traefik, one tenant-* namespace
#   expected DENIED : kube-system, flux-system, cert-manager, longhorn-system, cnpg-system
#
# "Allowed" means admission let it through — the command itself may still fail
# in an image without `true` (distroless); only the policy's denial counts as
# denied. Namespaces with no running pod are reported as SKIP, not as a pass.
#
# Needs kubectl with impersonation rights (cluster-admin), e.g. on a server:
#   KUBECONFIG=/etc/rancher/k3s/k3s.yaml scripts/test-platform-api-exec-scope.sh
# Exit 0 = every checked namespace behaved; 1 = a mismatch; 2 = nothing checkable.
set -uo pipefail

AS="system:serviceaccount:platform:platform-api"
POLICY="platform-api-pods-exec-scope"
ALLOWED=(platform mail traefik)
DENIED=(kube-system flux-system cert-manager longhorn-system cnpg-system)

# First tenant namespace that has a running pod to exec into.
tenant_ns="$(kubectl get pods -A --field-selector=status.phase=Running --no-headers 2>/dev/null \
  | awk '$1 ~ /^tenant-/ {print $1; exit}')"
[[ -n "$tenant_ns" ]] && ALLOWED+=("$tenant_ns")

checked=0 failed=0

# exec_verdict <ns> → prints allowed|denied|skip
exec_verdict() {
  local ns="$1" pod out
  pod="$(kubectl -n "$ns" get pods --field-selector=status.phase=Running -o name 2>/dev/null | head -1)"
  [[ -z "$pod" ]] && { echo skip; return; }
  out="$(kubectl -n "$ns" exec "$pod" --as="$AS" -- true 2>&1 || true)"
  if [[ "$out" == *"ValidatingAdmissionPolicy '${POLICY}'"* ]]; then echo denied
  elif [[ "$out" == *"forbidden"* ]]; then echo "rbac-forbidden"
  else echo allowed; fi
}

check() {
  local ns="$1" want="$2" got
  got="$(exec_verdict "$ns")"
  if [[ "$got" == skip ]]; then
    printf 'SKIP  %-24s no running pod\n' "$ns"; return
  fi
  checked=$((checked + 1))
  if [[ "$got" == "$want" ]]; then
    printf 'PASS  %-24s %s\n' "$ns" "$got"
  else
    printf 'FAIL  %-24s want %s, got %s\n' "$ns" "$want" "$got"; failed=$((failed + 1))
  fi
}

kubectl get validatingadmissionpolicy "$POLICY" >/dev/null 2>&1 \
  || { echo "FAIL  policy ${POLICY} is not installed"; exit 1; }

for ns in "${ALLOWED[@]}"; do check "$ns" allowed; done
for ns in "${DENIED[@]}"; do check "$ns" denied; done
[[ -z "$tenant_ns" ]] && echo "SKIP  tenant-*                 no tenant namespace with a running pod"

(( checked == 0 )) && { echo "nothing was checkable"; exit 2; }
echo "${checked} checked, ${failed} failed"
(( failed == 0 ))
