#!/usr/bin/env bash
# TDD harness for the image-org fork-safety mechanism (Holistic plan W2 / PR 2).
#
# Covers two artefacts:
#   scripts/preflight-image-org.sh   — repoints the canonical GHCR org in the
#                                      static kustomize overlays to a fork's own
#                                      org, so a fork deploying to a REAL cluster
#                                      pulls images it actually owns.
#   scripts/ci-image-org-check.sh    — CI guard locking in the invariants:
#                                        (1) overlays reference ONLY the canonical
#                                            org (no stray fork org committed);
#                                        (2) image-building workflows derive their
#                                            org from ${{ github.repository }} and
#                                            never hardcode ghcr.io/insulahq/insula;
#                                        (3) preflight's canonical constant agrees
#                                            with the overlays.
#
# Run: ./scripts/test-image-org.sh   (exit 0 = all pass)
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
PREFLIGHT="$REPO_ROOT/scripts/preflight-image-org.sh"
GUARD="$REPO_ROOT/scripts/ci-image-org-check.sh"
CANONICAL="ghcr.io/insulahq/insula"

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check(){ if eval "$2"; then ok "$1"; else bad "$1 — predicate failed: $2"; fi; }

# Build a throwaway repo-shaped tree with canonical overlays + workflows.
make_fixture() {
  local root; root=$(mktemp -d)
  mkdir -p "$root/k8s/overlays/dev" "$root/k8s/overlays/development" \
           "$root/k8s/overlays/production" "$root/k8s/base/sidecar" \
           "$root/.github/workflows"
  for ov in dev development production; do
    cat >"$root/k8s/overlays/$ov/kustomization.yaml" <<EOF
images:
  - name: $CANONICAL/backend
    newTag: latest
  - name: $CANONICAL/admin-panel
    newTag: latest
  - name: $CANONICAL/tenant-panel
    newTag: latest
EOF
  done
  # A base manifest mixing a platform sidecar image (must repoint) with a
  # third-party ghcr image (must be left alone).
  cat >"$root/k8s/base/sidecar/daemonset.yaml" <<EOF
spec:
  template:
    spec:
      containers:
        - name: firewall-reconciler
          image: $CANONICAL/firewall-reconciler:latest
        - name: reloader
          image: ghcr.io/stakater/reloader:v1.0.0
EOF
  printf '%s' "$root"
}

# Set T to a fresh fixture, aborting loudly if setup failed (so a failed mktemp
# never lets tests run against a bogus root or `rm -rf` an empty path).
req_fixture() { T=$(make_fixture); if [ -z "${T:-}" ] || [ ! -d "$T/k8s" ]; then echo "FATAL: fixture setup failed" >&2; exit 1; fi; }
req_tmp()     { T=$(mktemp -d);    if [ -z "${T:-}" ] || [ ! -d "$T" ];     then echo "FATAL: mktemp failed" >&2; exit 1; fi; }

echo "== preflight-image-org.sh =="

# 1. Repoint: canonical -> fork org across the whole k8s tree, none left.
req_fixture
"$PREFLIGHT" --owner forkorg/forkrepo --root "$T" >/dev/null 2>&1
check "repoints the entire k8s tree to the fork org" \
  "! grep -rq '$CANONICAL/' '$T/k8s'"
check "fork org present in every overlay" \
  "[ \$(grep -rl 'ghcr.io/forkorg/forkrepo/backend' '$T/k8s/overlays' | wc -l) -eq 3 ]"
check "base sidecar image repointed too" \
  "grep -q 'ghcr.io/forkorg/forkrepo/firewall-reconciler' '$T/k8s/base/sidecar/daemonset.yaml'"
check "third-party ghcr image LEFT UNTOUCHED" \
  "grep -q 'ghcr.io/stakater/reloader:v1.0.0' '$T/k8s/base/sidecar/daemonset.yaml'"

# 2. Idempotent: a second run changes nothing.
before=$(find "$T/k8s" -name '*.yaml' -exec cat {} +)
"$PREFLIGHT" --owner forkorg/forkrepo --root "$T" >/dev/null 2>&1
after=$(find "$T/k8s" -name '*.yaml' -exec cat {} +)
if [ "$before" = "$after" ]; then ok "second run is a no-op (idempotent)"
else bad "second run changed files (not idempotent)"; fi
rm -rf "$T"

# 3. --check exit codes: 3 when repoint needed, 0 once aligned.
req_fixture
"$PREFLIGHT" --check --owner forkorg/forkrepo --root "$T" >/dev/null 2>&1
check "--check exits 3 when a repoint is pending" "[ \$? -eq 3 ]"
"$PREFLIGHT" --owner forkorg/forkrepo --root "$T" >/dev/null 2>&1
"$PREFLIGHT" --check --owner forkorg/forkrepo --root "$T" >/dev/null 2>&1
check "--check exits 0 once aligned" "[ \$? -eq 0 ]"
rm -rf "$T"

# 4. No-op when target == canonical (the canonical repo must never be rewritten).
req_fixture
"$PREFLIGHT" --owner insulahq/insula --root "$T" >/dev/null 2>&1
check "target==canonical leaves overlays untouched" \
  "[ \$(grep -rl '$CANONICAL/backend' '$T/k8s/overlays' | wc -l) -eq 3 ]"
rm -rf "$T"

# 5. Owner resolves from IMAGE_REGISTRY_OWNER env when --owner is omitted.
req_fixture
IMAGE_REGISTRY_OWNER=envorg/envrepo "$PREFLIGHT" --root "$T" >/dev/null 2>&1
check "owner taken from IMAGE_REGISTRY_OWNER env" \
  "grep -rq 'ghcr.io/envorg/envrepo/backend' '$T/k8s/overlays'"
rm -rf "$T"

# 5b. Owner resolves from `git remote get-url origin` when --owner/env absent.
req_fixture
git -C "$T" init -q
git -C "$T" remote add origin git@github.com:gitorg/gitrepo.git
( unset IMAGE_REGISTRY_OWNER; "$PREFLIGHT" --root "$T" >/dev/null 2>&1 )
check "owner derived from git origin url (ssh form, .git stripped)" \
  "grep -rq 'ghcr.io/gitorg/gitrepo/backend' '$T/k8s/overlays'"
rm -rf "$T"

echo "== ci-image-org-check.sh =="

# 6. Guard passes against the real repo (after the PR's workflow edits).
"$GUARD" >/dev/null 2>&1
check "guard PASSES on the real repo" "[ \$? -eq 0 ]"

# 7. Guard fails when an overlay carries a non-canonical org.
req_tmp
mkdir -p "$T/k8s/overlays/dev" "$T/.github/workflows" "$T/scripts"
cp "$PREFLIGHT" "$T/scripts/preflight-image-org.sh"
echo "images: [{name: ghcr.io/evilorg/x/backend}]" > "$T/k8s/overlays/dev/kustomization.yaml"
echo "env: { IMAGE: ghcr.io/\${{ github.repository }}/x }" > "$T/.github/workflows/ci-x.yml"
REPO_ROOT="$T" "$GUARD" >/dev/null 2>&1
check "guard FAILS on a non-canonical overlay org" "[ \$? -ne 0 ]"
rm -rf "$T"

# 8. Guard fails when a workflow hardcodes the canonical org instead of deriving it.
req_tmp
mkdir -p "$T/k8s/overlays/dev" "$T/.github/workflows" "$T/scripts"
cp "$PREFLIGHT" "$T/scripts/preflight-image-org.sh"
echo "images: [{name: $CANONICAL/backend}]" > "$T/k8s/overlays/dev/kustomization.yaml"
echo "env: { IMAGE: $CANONICAL/x }" > "$T/.github/workflows/ci-x.yml"
REPO_ROOT="$T" "$GUARD" >/dev/null 2>&1
check "guard FAILS on a workflow hardcoding the canonical org" "[ \$? -ne 0 ]"
rm -rf "$T"

# 9. Guard FAILS on a committed k8s/base repoint (guard scope == preflight scope).
req_tmp
mkdir -p "$T/k8s/base/sidecar" "$T/scripts"
cp "$PREFLIGHT" "$T/scripts/preflight-image-org.sh"
echo "image: ghcr.io/forkorg/forkrepo/firewall-reconciler:latest" > "$T/k8s/base/sidecar/ds.yaml"
REPO_ROOT="$T" "$GUARD" >/dev/null 2>&1
check "guard FAILS on a repointed k8s/base manifest" "[ \$? -ne 0 ]"
rm -rf "$T"

# 10. Guard PASSES with canonical + a known third-party org (allowlist works).
req_tmp
mkdir -p "$T/k8s/base/db" "$T/.github/workflows" "$T/scripts"
cp "$PREFLIGHT" "$T/scripts/preflight-image-org.sh"
printf 'image: %s/backend:latest\nimage: ghcr.io/cloudnative-pg/postgresql:16\n' \
  "$CANONICAL" > "$T/k8s/base/db/a.yaml"
echo "env: { IMAGE: ghcr.io/\${{ github.repository }}/x }" > "$T/.github/workflows/ci-x.yml"
REPO_ROOT="$T" "$GUARD" >/dev/null 2>&1
check "guard PASSES with canonical + allowlisted third-party org" "[ \$? -eq 0 ]"
rm -rf "$T"

echo
echo "image-org tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
