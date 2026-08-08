#!/usr/bin/env bash
# pin-config-image.sh CONFIG_KEY IMAGE_REF — pin ONE runtime-resolved image to an
# immutable reference in the development overlay's platform-config patch, then
# commit + push to development.
#
# WHY THIS EXISTS ALONGSIDE pin-image-tag.sh
#   pin-image-tag.sh rewrites the kustomization `images:` newTag. That transformer
#   only rewrites `image:` fields in pod specs, so it cannot reach an image the
#   BACKEND builds at runtime from an env var — Job/initContainer images like
#   rocksdb-secondary-checkpoint, file-manager, migration-tools. Those resolve
#   through platform-config → configMapKeyRef → env, so the pin has to land on the
#   ConfigMap key instead. Same problem, same fix, different file.
#
#   Timing is identical and deliberate: run this from the image's OWN build
#   workflow, AFTER the push. build-deploy.yml is a different workflow, so pinning
#   there could point the cluster at a tag that had not finished pushing — the
#   2026-06-06 security-probe / firewall-reconciler pull race that pin-image-tag.sh
#   was written to kill.
#
# REFERENCE FORMAT: repo:<tag>@sha256:<digest>
#   Both halves on purpose. The digest is what containerd actually resolves — it
#   is authoritative and a re-pushed tag cannot change it. The tag rides along as
#   a human-readable label so `kubectl get pod -o wide` and an overlay diff stay
#   readable instead of being a wall of hex.
#
#   Verified on a real cluster (k3s v1.31.4, 2026-08-07), not assumed: a Pod with
#   `busybox:1.36@<digest-of-1.37>` started and reported `BusyBox v1.37.0`, with
#   `.status.containerStatuses[0].imageID` equal to the 1.37 digest. The digest
#   wins; a wrong tag is cosmetic, never a different image.
#
# Usage (from a build workflow, after the push step):
#   .github/scripts/pin-config-image.sh rocksdb-secondary-checkpoint-image \
#     "ghcr.io/owner/repo/img:20260807103130-abc1234@sha256:<digest>"
#
# Env:
#   ROOT         repo root (default: `git rev-parse --show-toplevel`)
#   PIN_PUSH=0   apply + commit but DO NOT push (tests)
#
# Exit: 0 ok (pinned + pushed, or already-pinned no-op) · 1 error · 2 usage
set -euo pipefail

CONFIG_KEY="${1:-}"
IMAGE_REF="${2:-}"
[ -n "$CONFIG_KEY" ] && [ -n "$IMAGE_REF" ] || {
  echo "usage: pin-config-image.sh <config-key> <image-ref>" >&2; exit 2; }

# Both values are CI-produced, but validate anyway: they are interpolated into a
# sed program and a git ref, so a malformed value must never get that far.
printf '%s' "$CONFIG_KEY" | grep -qE '^[a-z0-9]+(-[a-z0-9]+)*$' || {
  echo "pin-config-image: bad config key '$CONFIG_KEY'" >&2; exit 2; }
# registry/path:tag@sha256:<64 hex> — the digest is REQUIRED. A tag-only ref would
# silently give up the property this script exists to provide.
printf '%s' "$IMAGE_REF" | grep -qE '^[A-Za-z0-9._/-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$' || {
  echo "pin-config-image: image ref must be repo:tag@sha256:<64-hex>, got '$IMAGE_REF'" >&2
  exit 2; }

ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
PATCH="$ROOT/k8s/overlays/development/platform-config-patch.yaml"
[ -f "$PATCH" ] || { echo "pin-config-image: $PATCH not found" >&2; exit 1; }

# The key MUST already exist (added once, by hand, together with the env wiring in
# backend-deployment.yaml). Refuse rather than silently no-op: a missing key means
# the backend is still falling back to its in-code `:latest` default and this pin
# would be doing nothing at all.
if ! grep -qE "^[[:space:]]*${CONFIG_KEY}:" "$PATCH"; then
  echo "pin-config-image: no '${CONFIG_KEY}:' key in $PATCH" >&2
  echo "  add it (and the matching configMapKeyRef env in k8s/base/backend-deployment.yaml)" >&2
  echo "  before pinning — see file-manager-image for the shape." >&2
  exit 1
fi

apply_pin() {
  # Rewrite only the value on that key's line, preserving indentation.
  sed -i -E "s|^([[:space:]]*${CONFIG_KEY}:[[:space:]]*).*|\1\"${IMAGE_REF}\"|" "$PATCH"
}

apply_pin
if git -C "$ROOT" diff --quiet -- "$PATCH"; then
  echo "pin-config-image: ${CONFIG_KEY} already at ${IMAGE_REF} — nothing to do."
  exit 0
fi
echo "pinned ${CONFIG_KEY} → ${IMAGE_REF}"

if [ "${PIN_PUSH:-1}" = "0" ]; then
  echo "(PIN_PUSH=0 — staged the edit, skipping commit/push)"
  exit 0
fi

git -C "$ROOT" config user.name  "github-actions[bot]"
git -C "$ROOT" config user.email "41898282+github-actions[bot]@users.noreply.github.com"

commit() {
  git -C "$ROOT" add "$PATCH"
  git -C "$ROOT" commit -qm "chore(development): pin ${CONFIG_KEY} to ${IMAGE_REF##*/}"
}
commit

# Race-recovery loop — same shape as pin-image-tag.sh. On a rejected push: reset
# to origin/development (picking up any concurrent pin), re-apply ONLY this key's
# line, recommit, retry. Each pin touches a single distinct line, so it converges.
# ADR-053: pins land directly on `development` (the DEV cluster's Flux source).
for attempt in 1 2 3 4; do
  if git -C "$ROOT" push origin HEAD:development; then
    echo "push succeeded on attempt $attempt"
    exit 0
  fi
  echo "push attempt $attempt rejected — reset to origin/development + re-apply pin"
  git -C "$ROOT" fetch origin development
  git -C "$ROOT" reset --hard origin/development
  apply_pin
  if git -C "$ROOT" diff --quiet -- "$PATCH"; then
    echo "after reset+reapply ${CONFIG_KEY} already at ${IMAGE_REF} on origin/development — done."
    exit 0
  fi
  commit
done
echo "::error::pin-config-image: push failed after 4 attempts for ${CONFIG_KEY}" >&2
exit 1
