#!/usr/bin/env bash
# ci-version-poller-check.sh — guard the W11 version-poller invariants
# (ADR-045 / HOLISTIC_RELEASE_AND_UPGRADE_PLAN.md W11).
#
# The poller is the cluster's ONLY gate deciding a release is authentic, and the
# user requirement is that verification stays LIGHTWEIGHT (pure Node crypto — NOT
# the 120 MB cosign binary). These checks fail the build on any regression of:
#
#   1. The pinned trust anchor is baked into the backend image (no key ⇒ nothing
#      verifiable ⇒ the poller can never surface a version).
#   2. release.yml builds AND cosign-signs `release-manifest.json` and uploads
#      BOTH it and its `.sig` as release assets (else there's nothing to verify).
#   3. The CronJob exists, runs in `platform`, hourly, invokes the poll job, has
#      NO Kubernetes RBAC, and is wired into the base kustomization.
#   4. The poll path actually calls the signature verifier (no silent bypass).
#   5. NO cosign *binary* is invoked anywhere on the node-side poll path — the
#      lightweight requirement. (cosign is CI/signing-side only.)

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DOCKERFILE="$REPO_ROOT/backend/Dockerfile"
RELEASE_YML="$REPO_ROOT/.github/workflows/release.yml"
CRONJOB="$REPO_ROOT/k8s/base/version-poller-cronjob.yaml"
BASE_KUST="$REPO_ROOT/k8s/base/kustomization.yaml"
POLLER_DIR="$REPO_ROOT/backend/src/modules/platform-updates/poller"
JOB="$REPO_ROOT/backend/src/cli/version-poll-job.ts"

fail() { echo "  ✗ $1" >&2; FAILED=1; }
FAILED=0

echo "ci-version-poller-check: verifying W11 invariants..."

# (1) backend image bakes the pinned cosign public key
if [[ ! -f "$REPO_ROOT/platform/cosign.pub" ]]; then
  fail "platform/cosign.pub (the pinned trust anchor) is missing"
fi
if ! grep -qE '^COPY[[:space:]]+platform/cosign\.pub' "$DOCKERFILE"; then
  fail "backend/Dockerfile does not bake platform/cosign.pub (COPY platform/cosign.pub …) — verification would fail-closed forever"
fi

# (2) release.yml builds, cosign-signs, and uploads the manifest + its signature
grep -q 'release-manifest.json' "$RELEASE_YML" \
  || fail "release.yml never produces release-manifest.json (the poller's trust artifact)"
grep -q 'cosign sign-blob' "$RELEASE_YML" \
  || fail "release.yml has no 'cosign sign-blob' step"
grep -q 'release-manifest.json.sig' "$RELEASE_YML" \
  || fail "release.yml does not upload release-manifest.json.sig as a release asset (nothing to verify)"

# (3) CronJob discipline
if [[ ! -f "$CRONJOB" ]]; then
  fail "k8s/base/version-poller-cronjob.yaml is missing"
else
  grep -q 'namespace: platform' "$CRONJOB" || fail "CronJob is not in the platform namespace"
  grep -q 'version-poll-job.js' "$CRONJOB" || fail "CronJob does not invoke dist/cli/version-poll-job.js"
  # hourly: a 5-field cron whose minute is numeric and hour is '*' (e.g. '42 * * * *')
  grep -qE 'schedule:[[:space:]]*"[0-9]+ \* \* \* \*"' "$CRONJOB" || fail "CronJob schedule is not hourly (expected \"<min> * * * *\")"
  # least privilege: no RoleBinding/ClusterRoleBinding in the manifest
  if grep -qE 'kind:[[:space:]]*(Role|ClusterRole|RoleBinding|ClusterRoleBinding)' "$CRONJOB"; then
    fail "version-poller CronJob manifest grants RBAC — the poller needs none (reads GitHub, writes one DB table)"
  fi
  grep -q 'automountServiceAccountToken: false' "$CRONJOB" || fail "CronJob should set automountServiceAccountToken: false (no k8s API access needed)"
fi
grep -q 'version-poller-cronjob.yaml' "$BASE_KUST" || fail "version-poller-cronjob.yaml is not wired into k8s/base/kustomization.yaml"

# (4) the poll path actually verifies
if [[ -f "$POLLER_DIR/poll.ts" ]]; then
  grep -q 'verifyCosignSignature' "$POLLER_DIR/poll.ts" || fail "poll.ts never calls verifyCosignSignature — the gate would be bypassed"
else
  fail "poller/poll.ts is missing"
fi

# (4b) the verifier pins the ECDSA curve to P-256 (defence-in-depth: a wrong-curve
# trust anchor would silently break every verify).
if [[ -f "$POLLER_DIR/verify.ts" ]]; then
  grep -q 'prime256v1' "$POLLER_DIR/verify.ts" || fail "verify.ts does not assert the ECDSA curve is P-256 (prime256v1)"
else
  fail "poller/verify.ts is missing"
fi

# (5) lightweight: NO cosign binary invoked on the node-side poll path. We allow
# the identifiers (cosign.pub, verifyCosignSignature) but forbid spawning a
# `cosign` process.
NODE_PATHS=("$POLLER_DIR" "$JOB")
for p in "${NODE_PATHS[@]}"; do
  [[ -e "$p" ]] || continue
  # Flag a spawned `cosign` process — exec/execFile/spawn(...'cosign'...), which
  # also catches exec("cosign verify …") since cosign sits right after the quote.
  # The identifiers `cosign.pub` / `verifyCosignSignature` and prose mentioning
  # cosign are fine — only invoking the cosign *binary* is forbidden.
  if grep -rnE "(exec|execFile|execFileSync|spawn|spawnSync)[A-Za-z]*\([[:space:]]*['\"]cosign" "$p" 2>/dev/null; then
    fail "the node-side poll path invokes the cosign BINARY — verification must stay pure Node crypto (lightweight requirement)"
  fi
done

if [[ "$FAILED" -ne 0 ]]; then
  echo "ci-version-poller-check: FAILED" >&2
  exit 1
fi
echo "ci-version-poller-check: OK"
