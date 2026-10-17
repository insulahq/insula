#!/usr/bin/env bash
# ci-traefik-compress-check.sh — every Traefik `compress` Middleware in k8s/
# must stay memory-bounded:
#
#   1. encodings is exactly [gzip]. The CLIENT picks the encoding: with br or
#      zstd anywhere in the list, `Accept-Encoding: br` alone selects it.
#      Measured on traefik:v3.7.6, a response in flight costs ~2.4 MiB under
#      zstd and ~2.7 MiB under brotli (Go reserves ~11 MiB per brotli writer)
#      against ~0.6 MiB under gzip.
#   2. includedContentTypes is set (an ALLOWLIST) and lists only text-like
#      types. Images, archives, PDFs and mail attachments are already
#      compressed, and text/event-stream would pin a writer for the life of
#      every open push stream.
#
# On a production cluster the br-first, compress-everything Middleware
# OOM-killed the Traefik DaemonSet on two nodes 9 s apart while one webmail
# page loaded dozens of inline images. See
# k8s/base/traefik/middlewares-global.yaml for the measurements.
#
# CI_TRAEFIK_COMPRESS_ROOT overrides the scanned tree (tests only).
# Exit: 0 ok · 1 violation · 2 tooling missing.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCAN="${CI_TRAEFIK_COMPRESS_ROOT:-$ROOT/k8s}"

command -v yq >/dev/null 2>&1 && yq --version 2>/dev/null | grep -q mikefarah \
  || { echo "::error::ci-traefik-compress-check: mikefarah yq v4 required" >&2; exit 2; }

# Text-like media types that are worth compressing. Anything else — including
# a new text type nobody thought about — fails until it is added here on purpose.
ALLOWED_RE='^(text/(html|css|plain|javascript|xml|csv|markdown)|application/(javascript|x-javascript|wasm|json|xml|manifest\+json|ld\+json|problem\+json|rss\+xml|atom\+xml|xhtml\+xml)|image/svg\+xml)$'

fail=0; found=0
while IFS= read -r -d '' f; do
  # One line per compress Middleware document: name|encodings|included. Not
  # TSV: `read` collapses consecutive tabs, so an EMPTY encodings field would
  # shift the allowlist into its place.
  while IFS='|' read -r name enc inc; do
    [[ -n "$name" ]] || continue
    found=$((found + 1))
    where="${f#"$ROOT"/}: Middleware ${name}"
    if [[ "$enc" != "gzip" ]]; then
      echo "::error::${where}: compress.encodings must be exactly [gzip], got [${enc}] — a client that sends only 'Accept-Encoding: br' (or zstd) selects the encoder that costs ~4x the memory per response."
      fail=1
    fi
    if [[ -z "$inc" ]]; then
      echo "::error::${where}: compress.includedContentTypes is missing — without an allowlist every image and attachment is re-compressed, one writer each."
      fail=1
      continue
    fi
    IFS=',' read -r -a types <<<"$inc"
    for t in "${types[@]}"; do
      if [[ ! "$t" =~ $ALLOWED_RE ]]; then
        echo "::error::${where}: compress.includedContentTypes lists '${t}', which is not a text type this guard allows (already-compressed binaries waste a writer per response; text/event-stream pins one per open stream). Add it to ALLOWED_RE in this script only if it really is compressible text."
        fail=1
      fi
    done
  done < <(yq -N '
      select(.kind == "Middleware" and .spec.compress != null)
      | [ .metadata.name,
          ((.spec.compress.encodings // []) | join(",")),
          ((.spec.compress.includedContentTypes // []) | join(",")) ] | join("|")' "$f" 2>/dev/null || true)
  # A compress block with excludedContentTypes instead is still a deny-list.
  if yq -e 'select(.kind == "Middleware" and .spec.compress.excludedContentTypes != null) | .metadata.name' "$f" >/dev/null 2>&1; then
    echo "::error::${f#"$ROOT"/}: compress.excludedContentTypes is a deny-list — use includedContentTypes (an allowlist) instead."
    fail=1
  fi
done < <(grep -rlZ --include='*.yaml' --include='*.yml' -E '^[[:space:]]+compress:' "$SCAN" 2>/dev/null || true)

if [[ "$found" -eq 0 ]]; then
  echo "::error::ci-traefik-compress-check: found no compress Middleware under ${SCAN#"$ROOT"/} — the extraction matched nothing, so this guard would pass anything." >&2
  exit 1
fi
[[ "$fail" -eq 0 ]] && echo "ci-traefik-compress-check: ${found} compress Middleware(s) gzip-only with a text allowlist — OK."
exit "$fail"
