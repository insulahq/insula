#!/usr/bin/env bash
# list-scan-images.sh — emit the unique UPSTREAM container images deployed by
# k8s/base, for the weekly Trivy image-CVE scan (ADR-050 / image-cve-scan.yml).
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

grep -rhoE 'image:[[:space:]]*"?[^"[:space:]]+' "$ROOT/k8s/base" 2>/dev/null \
  | sed -E 's/^image:[[:space:]]*"?//' \
  | grep -E '[:@]' \
  | grep -vE '^ghcr\.io/insulahq/' \
  | grep -vE '^[a-z0-9._-]+:latest$' \
  | sort -u
