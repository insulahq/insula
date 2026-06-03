#!/usr/bin/env bash
# ci-system-upgrade-check.sh — guard the system-upgrade-controller integration
# (ADR-045 W12). SUC runs privileged per-node upgrade Jobs when a Plan CR exists,
# so the load-bearing invariant is: a Plan is NEVER committed to git — Plans are
# created only at runtime by `platform-ops cluster upgrade` (gated, dry-run by
# default). A committed Plan would auto-trigger a k3s upgrade on every cluster
# the moment Flux reconciles it.
#
# Invariants:
#   1. NO upgrade.cattle.io Plan CR is committed anywhere under k8s/.
#   2. SUC is vendored + image-PINNED (not :latest) + wired into base.
#   3. The controller pod itself is hardened (runAsNonRoot, drop ALL caps).
#   4. The k3s Plan generator REFUSES skip-a-minor / downgrade / cross-major.
#   5. The CLI defaults to dry-run (only `--apply` creates Plans).

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SUC_DIR="$REPO_ROOT/k8s/base/system-upgrade-controller"
CONTROLLER="$SUC_DIR/controller.yaml"
CRD="$SUC_DIR/crd.yaml"
GEN_TS="$REPO_ROOT/backend/src/cli/platform-ops/operations/k3s-plan.ts"
CMD_TS="$REPO_ROOT/backend/src/cli/platform-ops/commands.ts"

fail() { echo "  ✗ $1" >&2; FAILED=1; }
FAILED=0

echo "ci-system-upgrade-check: verifying SUC integration..."

# (1) NO committed Plan CR anywhere in k8s/. A real standalone Plan manifest has
#     a column-zero `^kind: Plan` (the `^` anchor), so the CRD's own indented
#     `kind: Plan` schema example never matches — the `$CRD` exemption below is a
#     deliberate belt-and-suspenders (KEEP it even though the anchor already
#     excludes the CRD; do not "simplify" by removing one layer).
while IFS= read -r -d '' f; do
  if grep -qE '^kind:[[:space:]]*Plan[[:space:]]*$' "$f" && grep -qE 'upgrade\.cattle\.io/v1' "$f"; then
    if [[ "$f" != "$CRD" ]]; then
      fail "a committed upgrade.cattle.io Plan CR found in $f — Plans must be created only at runtime by 'platform-ops cluster upgrade'"
    fi
  fi
done < <(find "$REPO_ROOT/k8s" -type f -name '*.yaml' -print0)

# (2) vendored + pinned + wired
if [[ -f "$CONTROLLER" && -f "$CRD" ]]; then
  grep -qE 'image:[[:space:]]*rancher/system-upgrade-controller:v[0-9]' "$CONTROLLER" \
    || fail "controller.yaml must pin a versioned rancher/system-upgrade-controller image (not :latest)"
  grep -qE 'image:.*:latest' "$CONTROLLER" && fail "controller.yaml must not use a :latest image tag"
else
  fail "vendored SUC controller.yaml / crd.yaml is missing under k8s/base/system-upgrade-controller/"
fi
grep -q 'system-upgrade-controller/' "$REPO_ROOT/k8s/base/kustomization.yaml" \
  || fail "system-upgrade-controller is not wired into k8s/base/kustomization.yaml"

# (3) controller pod hardened
if [[ -f "$CONTROLLER" ]]; then
  grep -q 'runAsNonRoot: true' "$CONTROLLER" || fail "SUC controller must run runAsNonRoot: true"
  grep -q '\- ALL' "$CONTROLLER" || fail "SUC controller must drop ALL capabilities"
fi

# (4) generator refuses unsafe transitions
if [[ -f "$GEN_TS" ]]; then
  for token in 'skip-a-minor' 'downgrade' 'cross-major'; do
    grep -q "$token" "$GEN_TS" || fail "k3s-plan.ts is missing the '$token' refusal"
  done
else
  fail "operations/k3s-plan.ts is missing"
fi

# (5) CLI is dry-run by default — apply is opt-in
if [[ -f "$CMD_TS" ]]; then
  grep -q "if (!apply)" "$CMD_TS" || fail "clusterUpgrade must be dry-run unless --apply is passed"
fi

# (6) the privileged system-upgrade namespace denies ingress
NETPOL="$SUC_DIR/networkpolicy.yaml"
if [[ -f "$NETPOL" ]]; then
  grep -q 'kind: NetworkPolicy' "$NETPOL" || fail "networkpolicy.yaml is not a NetworkPolicy"
  grep -q 'Ingress' "$NETPOL" || fail "system-upgrade NetworkPolicy must deny Ingress"
  grep -q 'networkpolicy.yaml' "$SUC_DIR/kustomization.yaml" || fail "networkpolicy.yaml not wired into the SUC kustomization"
else
  fail "missing default-deny-ingress NetworkPolicy for the privileged system-upgrade namespace"
fi

# (7) a --upgrade-image override is validated (no arbitrary image into privileged Jobs)
grep -q 'imageRefValid' "$GEN_TS" || fail "k3s-plan.ts must validate a --upgrade-image override (imageRefValid)"

if [[ "$FAILED" -ne 0 ]]; then
  echo "ci-system-upgrade-check: FAILED" >&2
  exit 1
fi
echo "ci-system-upgrade-check: OK"
