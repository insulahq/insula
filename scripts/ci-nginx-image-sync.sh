#!/usr/bin/env bash
# ci-nginx-image-sync.sh — every nginx the platform runs is the panels' nginx.
#
# WHY THIS EXISTS
# ---------------
# The admin and tenant panels build on a digest-pinned nginx (the runtime stage
# of their Dockerfiles), which Dependabot keeps fresh and the image build's
# Trivy gate checks. The platform's other nginx pods — the tenant error pages,
# the suspended and bandwidth-exceeded pages, Roundcube's nginx — named a
# floating tag instead. They fell a minor line behind when the panels moved to
# mainline, and under one tag each server ran whichever build it had pulled
# first: production ran three different nginx:1.30-alpine images side by side.
#
# Checked:
#   1. Both panel Dockerfiles build on the same nginx reference, pinned by
#      digest. That reference is the source of truth.
#   2. Every nginx `image:` line under k8s/ (base, overlays, components) names
#      exactly that reference. Any spelling of the official image counts: a
#      registry or mirror prefix, quotes, no tag at all.
#   3. Every overlay, rendered, runs only that nginx. This catches what no
#      `image:` line shows: a JSON patch, a kustomize `images:` transformer, a
#      folded scalar.
#
# After bumping the panels' nginx (by hand or in a Dependabot base-image PR),
# carry the pods along with:
#   scripts/ci-nginx-image-sync.sh --write
#
# Deliberately NOT checked: the backend's manifest-export fallback (a tenant
# workload, not a platform pod), test fixtures, and the catalog-images/ copy of
# static-nginx, which nothing builds (tenants run the Official Catalog's build).
#
# Needs kustomize or kubectl (for `kubectl kustomize`) on PATH.
# Usage: scripts/ci-nginx-image-sync.sh [--write] [repo-root]
set -euo pipefail

WRITE=0
if [ "${1:-}" = "--write" ]; then WRITE=1; shift; fi
ROOT="${1:-$(git rev-parse --show-toplevel)}"
cd "$ROOT"

PANELS=(frontend/admin-panel/Dockerfile frontend/tenant-panel/Dockerfile)
# The official image under any registry or mirror prefix, with or without a tag
# or digest — but not an image that merely has nginx in its name
# (owasp/modsecurity-crs:…-nginx-alpine, nginxinc/nginx-unprivileged).
NGINX_IMAGE="([a-z0-9.:-]+/)*(library/)?nginx([:@][^\"'[:space:]]*)?"
IMAGE_LINE="image:[[:space:]]*[\"']?${NGINX_IMAGE}([\"'[:space:]]|$)"
COMMENT_LINE='^[[:space:]]*#'

fail=0

# The image an `image:` line names, without quotes or a trailing comment.
image_of() { sed -E "s/^.*image:[[:space:]]*[\"']?//; s/[\"'[:space:]].*$//"; }

# ── 1. The panels agree on one digest-pinned nginx ───────────────────────────
ref=""
for f in "${PANELS[@]}"; do
  if [ ! -f "$f" ]; then
    echo "nginx-image-sync: FAIL — $f not found; did the panel move?"
    exit 1
  fi
  mapfile -t froms < <(grep -oE "^FROM[[:space:]]+${NGINX_IMAGE}([[:space:]]|$)" "$f" \
    | sed -E 's/^FROM[[:space:]]+//; s/[[:space:]]+$//')
  if [ "${#froms[@]}" -ne 1 ]; then
    echo "nginx-image-sync: FAIL — $f has ${#froms[@]} nginx FROM lines; expected exactly one (the runtime stage)."
    exit 1
  fi
  if ! [[ "${froms[0]}" =~ ^[^@]+:[^@]+@sha256:[0-9a-f]{64}$ ]]; then
    echo "nginx-image-sync: FAIL — $f builds on ${froms[0]}, which is not pinned by tag and digest."
    fail=1
  fi
  if [ -z "$ref" ]; then
    ref="${froms[0]}"
  elif [ "${froms[0]}" != "$ref" ]; then
    echo "nginx-image-sync: FAIL — the panels build on different nginx images:"
    echo "  ${PANELS[0]}: $ref"
    echo "  $f: ${froms[0]}"
    echo "  Bump both Dockerfiles together."
    fail=1
  fi
done
[ "$fail" -ne 0 ] && exit 1

# ── 2. --write: carry the panel reference to every k8s nginx image line ──────
if [ "$WRITE" -eq 1 ]; then
  mapfile -t files < <(grep -rlE --include='*.yaml' --include='*.yml' "$IMAGE_LINE" k8s || true)
  for f in "${files[@]}"; do
    # The terminator is captured (group 5) so nginxinc/nginx-unprivileged and the
    # like are left alone, exactly as the check leaves them.
    sed -i -E "/${COMMENT_LINE}/! s#(image:[[:space:]]*[\"']?)${NGINX_IMAGE}([\"'[:space:]]|\$)#\1${ref}\5#" "$f"
    echo "  wrote $ref to $f"
  done
fi

# ── 3. Every k8s nginx image line is the panel reference ─────────────────────
mapfile -t lines < <(grep -rnE --include='*.yaml' --include='*.yml' "$IMAGE_LINE" k8s \
  | grep -vE "^[^:]+:[0-9]+:${COMMENT_LINE#^}" || true)
if [ "${#lines[@]}" -eq 0 ]; then
  echo "nginx-image-sync: FAIL — no nginx image found under k8s/; did the manifests move?"
  exit 1
fi
for l in "${lines[@]}"; do
  file="${l%%:*}"; rest="${l#*:}"; lineno="${rest%%:*}"
  img=$(printf '%s\n' "${rest#*:}" | image_of)
  if [ "$img" != "$ref" ]; then
    echo "nginx-image-sync: FAIL — $file:$lineno runs $img"
    fail=1
  fi
done

# ── 4. Every rendered overlay runs only the panel reference ──────────────────
if command -v kustomize >/dev/null 2>&1; then render() { kustomize build "$1"; }
elif command -v kubectl >/dev/null 2>&1; then render() { kubectl kustomize "$1"; }
else
  echo "nginx-image-sync: FAIL — neither kustomize nor kubectl is on PATH; cannot render the overlays."
  exit 1
fi
rendered=0
lines_fail=$fail
for k in k8s/overlays/*/kustomization.yaml; do
  [ -f "$k" ] || continue
  o="${k%/kustomization.yaml}"
  if ! out=$(render "$o" 2>&1); then
    echo "nginx-image-sync: FAIL — $o does not render:"
    printf '%s\n' "$out" | tail -3 | sed 's/^/    /'
    fail=1; continue
  fi
  rendered=$((rendered+1))
  while IFS= read -r img; do
    if [ "$img" != "$ref" ]; then
      echo "nginx-image-sync: FAIL — $o renders $img"
      # With every image: line right, the overlay itself must change the pin.
      [ "$lines_fail" -eq 0 ] && echo "  A patch or an images: transformer in that overlay changes it."
      fail=1
    fi
  done < <(printf '%s\n' "$out" | grep -E "$IMAGE_LINE" | image_of | sort -u)
done
if [ "$rendered" -eq 0 ] && [ "$fail" -eq 0 ]; then
  echo "nginx-image-sync: FAIL — no overlay under k8s/overlays/ rendered; did they move?"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "  Every nginx the platform runs must be the panels' image: $ref"
  echo "  Fix with: scripts/ci-nginx-image-sync.sh --write"
  exit 1
fi
echo "ci-nginx-image-sync: OK — ${#lines[@]} k8s nginx image line(s) and $rendered rendered overlay(s) on the panels' $ref"
