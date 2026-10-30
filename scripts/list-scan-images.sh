#!/usr/bin/env bash
# list-scan-images.sh — emit the unique UPSTREAM container images deployed by
# k8s/base and created at runtime by platform-api, for the weekly Trivy
# image-CVE scan (ADR-050 / image-cve-scan.yml).
#
# Source of truth is the rendered base manifests (what actually ships), not a
# hand-maintained list — so a new upstream image is scanned automatically.
# First-party images (ghcr.io/insulahq/*) are EXCLUDED: they're already
# Trivy-scanned in their own per-component build CI. Local dev tags (bare
# `name:latest` with no registry) are excluded too.
#
# Usage: scripts/list-scan-images.sh   → one image ref per line
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"

# Plus the images platform-api creates at runtime — string literals in the
# backend that no manifest shows (scripts/lib/runtime-images.py): the route
# sign-in ran an oauth2-proxy with published authentication bypasses that this
# scan never saw — and the ones bootstrap.sh and the host migrations write into
# manifests and Helm values (scripts/lib/script-images.py).
{
  grep -rhoE 'image:[[:space:]]*"?[^"[:space:]]+' "$ROOT/k8s/base" 2>/dev/null \
    | sed -E 's/^image:[[:space:]]*"?//'
  python3 "$ROOT/scripts/lib/runtime-images.py" "$ROOT" | cut -f2
  python3 "$ROOT/scripts/lib/script-images.py" "$ROOT" | cut -f2
} \
  | grep -E '[:@]' \
  | grep -vE '^ghcr\.io/insulahq/' \
  | grep -vE '^[a-z0-9._-]+:latest$' \
  | sort -u
