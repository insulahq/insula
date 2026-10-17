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
#   3. every middlewares list that contains `compress` puts
#      `inflight-per-client` (namespace traefik) BEFORE it, and that
#      Middleware caps a client at <= 100 requests in flight, keyed by the
#      connection's remote address (IPv6 grouped by subnet) — never by Host
#      header (Traefik's default: one budget shared by every user) or by a
#      forwarded header a client could choose. Checked as TEXT, so a route
#      embedded in a kustomize patch string is covered too.
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

# ── 3a. the concurrency cap itself ─────────────────────────────────────────
inflight_specs=0
while IFS= read -r -d '' f; do
  while IFS='|' read -r name amount has_ip depth n_excl v6 req_host req_hdr; do
    [[ -n "$name" ]] || continue
    inflight_specs=$((inflight_specs + 1))
    where="${f#"$ROOT"/}: Middleware ${name}"
    if [[ ! "$amount" =~ ^[0-9]+$ ]] || (( amount < 1 || amount > 100 )); then
      echo "::error::${where}: inFlightReq.amount must be 1-100, got '${amount}'."
      fail=1
    fi
    if [[ "$has_ip" != true || "$depth" != 0 || "$n_excl" != 0 || ! "$v6" =~ ^[0-9]+$ \
          || "$req_host" == true || -n "$req_hdr" ]]; then
      echo "::error::${where}: inFlightReq.sourceCriterion must be ipStrategy (no depth, no excludedIPs) with ipv6Subnet, and no requestHost/requestHeaderName — got ipStrategy=${has_ip} depth=${depth} excludedIPs=${n_excl} ipv6Subnet='${v6}' requestHost=${req_host} requestHeaderName='${req_hdr}'. Without an ipStrategy Traefik keys by Host header: one budget for every user."
      fail=1
    fi
  done < <(yq -N '
      select(.kind == "Middleware" and .metadata.name == "inflight-per-client")
      | [ .metadata.name,
          (.spec.inFlightReq.amount // "" | tostring),
          (.spec.inFlightReq.sourceCriterion.ipStrategy != null | tostring),
          (.spec.inFlightReq.sourceCriterion.ipStrategy.depth // 0 | tostring),
          (.spec.inFlightReq.sourceCriterion.ipStrategy.excludedIPs // [] | length | tostring),
          (.spec.inFlightReq.sourceCriterion.ipStrategy.ipv6Subnet // "" | tostring),
          (.spec.inFlightReq.sourceCriterion.requestHost // false | tostring),
          (.spec.inFlightReq.sourceCriterion.requestHeaderName // "" | tostring) ] | join("|")' "$f" 2>/dev/null || true)
done < <(grep -rlZ --include='*.yaml' --include='*.yml' -E '^[[:space:]]+inFlightReq:' "$SCAN" 2>/dev/null || true)
if [[ "$inflight_specs" -eq 0 ]]; then
  echo "::error::ci-traefik-compress-check: no 'inflight-per-client' Middleware (inFlightReq) found — the routes that compress have no per-client concurrency cap."
  fail=1
fi

# ── 3b. inflight-per-client before compress, in every middlewares list ────────
route_lists=0
while IFS= read -r line; do
  case "$line" in
    ROUTE*) route_lists=$((route_lists + 1)) ;;
    *) echo "::error::${line#"$ROOT"/}"; fail=1 ;;
  esac
done < <(grep -rlZ --include='*.yaml' --include='*.yml' -E '^[[:space:]]*-[[:space:]]*name:[[:space:]]*compress[[:space:]]*$' "$SCAN" 2>/dev/null \
  | xargs -0 -r awk '
      FNR == 1 { seen = 0; pend = ""; nsline = 0 }
      /^[[:space:]]*#/ { next }
      /^[[:space:]]*middlewares:[[:space:]]*$/ { seen = 0; next }
      pend != "" && FNR == nsline {
        if ($0 ~ /^[[:space:]]*namespace:[[:space:]]*traefik[[:space:]]*$/) seen = 1
        else print pend ": inflight-per-client must carry namespace: traefik on the next line"
        pend = ""
      }
      /^[[:space:]]*-[[:space:]]*name:[[:space:]]*inflight-per-client[[:space:]]*$/ { pend = FILENAME ":" FNR; nsline = FNR + 1; next }
      /^[[:space:]]*-[[:space:]]*name:[[:space:]]*compress[[:space:]]*$/ {
        print "ROUTE"
        if (!seen) print FILENAME ":" FNR ": compress without inflight-per-client (namespace traefik) before it in the same middlewares list — one client could hold any number of compressed responses open."
      }')
if [[ "$route_lists" -eq 0 ]]; then
  echo "::error::ci-traefik-compress-check: no middlewares list references compress — the route extraction matched nothing." >&2
  fail=1
fi

if [[ "$found" -eq 0 ]]; then
  echo "::error::ci-traefik-compress-check: found no compress Middleware under ${SCAN#"$ROOT"/} — the extraction matched nothing, so this guard would pass anything." >&2
  exit 1
fi
[[ "$fail" -eq 0 ]] && echo "ci-traefik-compress-check: ${found} compress Middleware(s) gzip-only with a text allowlist; ${route_lists} route(s) capped per client first — OK."
exit "$fail"
