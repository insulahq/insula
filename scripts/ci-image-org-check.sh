#!/usr/bin/env bash
# Image-org fork-safety guard (Holistic plan W2).
#
# Locks in the contract that keeps the platform forkable:
#
#   1. The static kustomize overlays reference ONLY the canonical image org
#      `ghcr.io/insulahq/insula`. A fork repoints them with
#      scripts/preflight-image-org.sh — but that fork-local edit must never be
#      committed back to the canonical repo, or canonical deploys would pull a
#      fork's images.
#
#   2. Image-building workflows derive their push org from the GitHub context
#      (`ghcr.io/${{ github.repository }}/...`) and NEVER hardcode
#      `ghcr.io/insulahq/insula`. Hardcoding would make a fork's CI try to push
#      to a registry it does not own (403) instead of its own GHCR. Non-image
#      references to `insulahq/insula` (e.g. PLATFORM_RELEASES_REPO) are fine.
#
#   3. preflight-image-org.sh's canonical constant agrees with (1).
#
# Exit 1 on any violation.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CANONICAL="ghcr.io/insulahq/insula"
# Known non-platform ghcr orgs legitimately referenced in the manifests. A new
# third-party ghcr image trips the guard until it is added here — that is the
# intended behaviour (a conscious allow-list decision per supply-chain source).
THIRD_PARTY='bulwarkmail|cloudnative-pg|dexidp|stakater'

failures=0
fail() { echo "  ✗ $1"; failures=$((failures+1)); }

echo "image-org guard: checking $REPO_ROOT"

# --- 1. The k8s/ tree must reference only the canonical platform org ----------
# preflight-image-org.sh rewrites the WHOLE k8s/ tree (base + overlays), so the
# guard must police the WHOLE k8s/ tree — checking overlays only would let a
# committed repoint of k8s/base or a platform-config-patch slip through. Any
# ghcr.io reference that is neither the canonical platform org nor a known
# third-party org is a fork repoint committed by mistake.
k8s_dir="$REPO_ROOT/k8s"
if [ -d "$k8s_dir" ]; then
  bad_img=$(grep -rhoE 'ghcr\.io/[a-z0-9._/-]+' "$k8s_dir" 2>/dev/null \
            | grep -vE "^${CANONICAL}/" \
            | grep -vE "^ghcr\.io/(${THIRD_PARTY})/" \
            | sort -u || true)
  if [ -n "$bad_img" ]; then
    fail "k8s/ references a non-canonical, non-allowlisted image org (a committed fork repoint, or a new third-party org to add to THIRD_PARTY):"
    while IFS= read -r line; do echo "      $line"; done <<<"$bad_img"
  fi
else
  echo "  (no k8s/ tree — skipping manifest check)"
fi

# --- 2. Workflows must derive the org, never hardcode the canonical ghcr path --
wf_dir="$REPO_ROOT/.github/workflows"
if [ -d "$wf_dir" ]; then
  hardcoded=$(grep -rlE "ghcr\.io/insulahq/insula" "$wf_dir" 2>/dev/null || true)
  if [ -n "$hardcoded" ]; then
    fail "workflow(s) hardcode ${CANONICAL} — use ghcr.io/\${{ github.repository }} instead:"
    while IFS= read -r line; do echo "      $line"; done <<<"$hardcoded"
  fi
else
  echo "  (no .github/workflows — skipping workflow check)"
fi

# --- 3. preflight canonical constant must match -------------------------------
preflight="$REPO_ROOT/scripts/preflight-image-org.sh"
if [ -f "$preflight" ]; then
  if ! grep -q 'CANONICAL_OWNER="insulahq/insula"' "$preflight"; then
    fail "scripts/preflight-image-org.sh CANONICAL_OWNER does not match insulahq/insula"
  fi
else
  fail "scripts/preflight-image-org.sh is missing"
fi

if [ "$failures" -ne 0 ]; then
  echo "image-org guard: FAILED ($failures issue(s))"
  exit 1
fi
echo "image-org guard: OK"
