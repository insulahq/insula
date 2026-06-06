#!/usr/bin/env bash
# pin-image-tag.sh IMAGE_SHORT TAG — pin ONE internal image to an immutable tag
# in the development overlay, then commit + push to main.
#
# WHY: the platform Deployments (backend/admin/tenant) are pinned to an
# immutable <timestamp>-<sha> tag in k8s/overlays/development/kustomization.yaml
# (rewritten by .github/scripts/apply-development-pin.sh), so Flux only ever
# rolls to a tag that is GUARANTEED already pushed. The internal DaemonSet
# images (security-probe, firewall-reconciler, …) used `:latest` + a deploy-rev
# annotation bump instead — and that bump lives in build-deploy.yml, a DIFFERENT
# workflow than the one that builds+pushes the image, so the roll could fire
# before the new `:latest` finished pushing → pods pull a STALE digest (the
# 2026-06-06 security-probe / firewall-reconciler pull-race). Pinning the
# newTag from inside the image's OWN build workflow, AFTER the push, removes the
# race: the tag exists before the rewrite that points Flux at it.
#
# Usage (from a build workflow, on main, after the push step):
#   .github/scripts/pin-image-tag.sh firewall-reconciler "${TIMESTAMP_TAG}"
#
# Required positional args:
#   IMAGE_SHORT  short image name as it appears after the ghcr path in the
#                kustomization `images:` block (e.g. firewall-reconciler)
#   TAG          immutable tag to pin (e.g. 20260606003441-74760f5)
#
# Env:
#   ROOT         repo root (default: `git rev-parse --show-toplevel`)
#   PIN_PUSH=0   apply + commit but DO NOT push (tests)
#
# Exit: 0 ok (pinned + pushed, or already-pinned no-op) · 1 error · 2 usage
set -euo pipefail

IMAGE_SHORT="${1:-}"
TAG="${2:-}"
[ -n "$IMAGE_SHORT" ] && [ -n "$TAG" ] || { echo "usage: pin-image-tag.sh <image-short> <tag>" >&2; exit 2; }
# Image short name + tag are CI-produced; validate so a malformed value can
# never be sed-injected into the kustomization or produce a bad git ref.
printf '%s' "$IMAGE_SHORT" | grep -qE '^[a-z0-9]+(-[a-z0-9]+)*$' || { echo "pin-image-tag: bad image short name '$IMAGE_SHORT'" >&2; exit 2; }
printf '%s' "$TAG" | grep -qE '^[A-Za-z0-9._-]+$' || { echo "pin-image-tag: bad tag '$TAG'" >&2; exit 2; }

ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
KUST="$ROOT/k8s/overlays/development/kustomization.yaml"
[ -f "$KUST" ] || { echo "pin-image-tag: $KUST not found" >&2; exit 1; }

# The image MUST already have an `images:` entry (added once, by hand). Refuse
# rather than silently no-op if it's missing — that would mean the deploy still
# tracks the base `:latest` and the pin is doing nothing.
if ! grep -qE "name: ghcr\.io.*/${IMAGE_SHORT}\$" "$KUST"; then
  echo "pin-image-tag: no 'images:' entry for ghcr.io/.../${IMAGE_SHORT} in $KUST" >&2
  echo "  add one (name + newTag) before pinning — see backend/admin-panel for the shape." >&2
  exit 1
fi

# Rewrite the newTag on the line AFTER the matching `name:` line, preserving any
# trailing comment. Same proven sed as apply-development-pin.sh's pin().
apply_pin() {
  sed -i -e "/name: ghcr\.io.*\/${IMAGE_SHORT}\$/{N;s/newTag: \"[^\"]*\"/newTag: \"${TAG}\"/}" "$KUST"
}

apply_pin
if git -C "$ROOT" diff --quiet -- "$KUST"; then
  echo "pin-image-tag: ${IMAGE_SHORT} already at ${TAG} — nothing to do."
  exit 0
fi
echo "pinned ${IMAGE_SHORT} → ${TAG}"

if [ "${PIN_PUSH:-1}" = "0" ]; then
  echo "(PIN_PUSH=0 — staged the edit, skipping commit/push)"
  exit 0
fi

git -C "$ROOT" config user.name  "github-actions[bot]"
git -C "$ROOT" config user.email "41898282+github-actions[bot]@users.noreply.github.com"

commit() {
  git -C "$ROOT" add "$KUST"
  git -C "$ROOT" commit -qm "chore(development): pin ${IMAGE_SHORT} to ${TAG}"
}
commit

# Race-recovery loop (same shape as build-deploy.yml's pin push). On a rejected
# push: reset to origin/main (picking up any concurrent pin), re-apply ONLY
# this image's newTag line, recommit, retry. Each pin touches a single distinct
# line, so this always converges; the shared `pin-development-*` concurrency
# group on the caller job makes a collision rare in the first place.
for attempt in 1 2 3 4; do
  if git -C "$ROOT" push origin HEAD:main; then
    echo "push succeeded on attempt $attempt"
    exit 0
  fi
  echo "push attempt $attempt rejected — reset to origin/main + re-apply pin"
  git -C "$ROOT" fetch origin main
  git -C "$ROOT" reset --hard origin/main
  apply_pin
  if git -C "$ROOT" diff --quiet -- "$KUST"; then
    echo "after reset+reapply ${IMAGE_SHORT} already at ${TAG} on origin/main — done."
    exit 0
  fi
  commit
done
echo "::error::pin-image-tag: push failed after 4 attempts for ${IMAGE_SHORT}" >&2
exit 1
