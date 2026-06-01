#!/usr/bin/env bash
# TDD harness for scripts/ci-no-cluster-push.sh (Holistic plan W7).
#
# The guard enforces the "no push-to-cluster" rule: CI never mutates a live
# cluster — clusters PULL (Flux + the version-poller). A workflow that runs a
# write-verb kubectl/helm/flux command against a cluster context is rejected.
#
# Run: ./scripts/test-ci-no-cluster-push.sh   (exit 0 = all pass)
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
GUARD="$REPO_ROOT/scripts/ci-no-cluster-push.sh"

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
yes() { if eval "$2"; then ok "$1"; else bad "$1 — predicate failed: $2"; fi; }

# A throwaway repo whose single workflow body is $1.
fixture() {
  local d; d=$(mktemp -d)
  mkdir -p "$d/.github/workflows"
  printf 'name: x\non: [push]\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n%s\n' \
    "$(printf '          %s\n' "$1")" > "$d/.github/workflows/ci-x.yml"
  printf '%s' "$d"
}
run_on() { REPO_ROOT="$1" "$GUARD" >/dev/null 2>&1; }

# 1. The real repo passes (pull model holds).
"$GUARD" >/dev/null 2>&1
yes "guard PASSES on the real repo" "[ \$? -eq 0 ]"

# 2. A real write-verb kubectl command is rejected.
T=$(fixture 'kubectl apply -f manifest.yaml'); run_on "$T"; yes "kubectl apply → FAIL" "[ \$? -ne 0 ]"; rm -rf "$T"
T=$(fixture 'kubectl rollout restart deploy/x -n p'); run_on "$T"; yes "kubectl rollout → FAIL" "[ \$? -ne 0 ]"; rm -rf "$T"
T=$(fixture 'kubectl delete pod x'); run_on "$T"; yes "kubectl delete → FAIL" "[ \$? -ne 0 ]"; rm -rf "$T"
T=$(fixture 'helm upgrade --install x ./chart'); run_on "$T"; yes "helm upgrade → FAIL" "[ \$? -ne 0 ]"; rm -rf "$T"
T=$(fixture 'flux reconcile kustomization platform'); run_on "$T"; yes "flux reconcile → FAIL" "[ \$? -ne 0 ]"; rm -rf "$T"

# 3. Read-only cluster commands are allowed.
T=$(fixture 'kubectl get pods -n platform'); run_on "$T"; yes "kubectl get → PASS" "[ \$? -eq 0 ]"; rm -rf "$T"
T=$(fixture 'kubectl kustomize k8s/overlays/dev'); run_on "$T"; yes "kubectl kustomize (local) → PASS" "[ \$? -eq 0 ]"; rm -rf "$T"
T=$(fixture 'helm template ./chart'); run_on "$T"; yes "helm template (local) → PASS" "[ \$? -eq 0 ]"; rm -rf "$T"

# 4. A write-verb mentioned only in a comment is not a command.
T=$(fixture '# we used to kubectl apply here'); run_on "$T"; yes "kubectl apply in a comment → PASS" "[ \$? -eq 0 ]"; rm -rf "$T"

# 5. An explicit per-line allow-marker (in the comment) exempts a legitimate case.
T=$(fixture 'kubectl apply -f x.yaml  # ci-no-cluster-push: allow (self-test only)'); run_on "$T"
yes "allow-marker in a comment exempts the line → PASS" "[ \$? -eq 0 ]"; rm -rf "$T"

# 6. The marker smuggled into a string (not a comment) does NOT exempt.
T=$(fixture 'VAR="ci-no-cluster-push: allow"; kubectl apply -f x.yaml'); run_on "$T"
yes "marker in a string (not a comment) does NOT exempt → FAIL" "[ \$? -ne 0 ]"; rm -rf "$T"

# 7. helm install (a distinct verb from upgrade).
T=$(fixture 'helm install x ./chart'); run_on "$T"; yes "helm install → FAIL" "[ \$? -ne 0 ]"; rm -rf "$T"

# 8. A command split across a `\` line-continuation is joined and caught.
T=$(mktemp -d); mkdir -p "$T/.github/workflows"
printf 'name: x\non: [push]\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          kubectl \\\n            apply -f x.yaml\n' \
  > "$T/.github/workflows/ci-x.yml"
run_on "$T"; yes "kubectl split across a \\ continuation → FAIL" "[ \$? -ne 0 ]"; rm -rf "$T"

echo
echo "ci-no-cluster-push tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
