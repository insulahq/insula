#!/usr/bin/env bash
# ci-gitops-structure-check.sh — guard the ADR-053 GitOps layout.
#
# The structure is load-bearing and easy to regress in a YAML edit, so assert
# the invariants that make dev/staging/prod behave as designed:
#   1. No committed Flux GitRepository tracks `branch: main` (ADR-053: the DEV
#      source tracks `development`, staging a semver tag range, production a tag).
#   2. The staging source uses a semver tag RANGE (auto-follows RC + stable).
#   3. The DEV source tracks `branch: development`; production tracks a tag.
#   4. build-deploy.yml triggers on `development`, never `main` (pins land on
#      development for the DEV cluster — no main→development propagation).
#   5. sync-development.yml is GONE (the old main→development auto-merge).
#   6. cut-release.sh stamps the release (production) overlay image pins, so the
#      immutable signed tag is self-describing.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
FLUX="$REPO_ROOT/k8s/base/flux"
BD="$REPO_ROOT/.github/workflows/build-deploy.yml"

fail() { echo "  ✗ $1" >&2; FAILED=1; }
FAILED=0

echo "ci-gitops-structure-check: verifying ADR-053 GitOps layout..."

# (1) no GitRepository tracks main
if grep -lqE '^[[:space:]]*branch:[[:space:]]*main[[:space:]]*$' "$FLUX"/gitrepository*.yaml 2>/dev/null; then
  fail "a Flux GitRepository still tracks 'branch: main' — ADR-053: dev→development, staging→semver, production→tag"
fi

# (2)+(3) per-source ref kind
grep -qE '^[[:space:]]*semver:' "$FLUX/gitrepository-staging.yaml" \
  || fail "staging GitRepository must use a semver tag range (spec.ref.semver)"
grep -qE '^[[:space:]]*branch:[[:space:]]*development[[:space:]]*$' "$FLUX/gitrepository.yaml" \
  || fail "the DEV GitRepository (gitrepository.yaml) must track 'branch: development'"
grep -qE '^[[:space:]]*tag:' "$FLUX/gitrepository-production.yaml" \
  || fail "production GitRepository must track a release tag (spec.ref.tag)"

# (4) build-deploy triggers on development, not main
if [[ -f "$BD" ]]; then
  grep -qE '^[[:space:]]*branches:[[:space:]]*\[development\]' "$BD" \
    || fail "build-deploy.yml must trigger on the development branch"
  if grep -qE '^[[:space:]]*branches:[[:space:]]*\[main\]' "$BD"; then
    fail "build-deploy.yml must NOT trigger on main (ADR-053)"
  fi
fi

# (5) sync-development is retired
if [[ -e "$REPO_ROOT/.github/workflows/sync-development.yml" ]]; then
  fail "sync-development.yml must be removed — ADR-053 inverts the flow (development → main via PR)"
fi

# (6) cut-release stamps the release overlay
grep -q 'overlays/production/kustomization.yaml' "$REPO_ROOT/scripts/cut-release.sh" \
  || fail "cut-release.sh must stamp the production overlay image pins (ADR-053 self-describing tags)"

if [[ "$FAILED" -ne 0 ]]; then
  echo "ci-gitops-structure-check: FAILED" >&2
  exit 1
fi
echo "ci-gitops-structure-check: OK"
