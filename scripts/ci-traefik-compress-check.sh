#!/usr/bin/env bash
# ci-traefik-compress-check.sh — every Traefik `compress` Middleware in k8s/
# must stay memory-bounded:
#
#   1. encodings is exactly [gzip]. The CLIENT picks the encoding: with br or
#      zstd anywhere in the list, `Accept-Encoding: br` alone selects it.
#      Measured on traefik:v3.7.6, a response in flight costs ~2.4 MiB under
#      Traefik's own zstd and ~2.7 MiB under brotli (Go reserves ~11 MiB per
#      brotli writer); the gzip path — which answers browsers with gzhttp's
#      small-window zstd — costs ~1 MiB for a slow text response.
#   2. includedContentTypes is set (an ALLOWLIST) and lists only text-like
#      types. Images, archives, PDFs and mail attachments are already
#      compressed, and text/event-stream would pin a writer for the life of
#      every open push stream.
#   3. every middlewares list that contains `compress` puts
#      `inflight-per-client` (namespace traefik) DIRECTLY before it — the
#      same place the platform API's boot converger puts it — and that
#      Middleware caps a client at <= 300 requests in flight, keyed by the
#      connection's remote address (IPv6 grouped by subnet) — never by Host
#      header (Traefik's default: one budget shared by every user) or by a
#      forwarded header a client could choose — and is never pruned by Flux
#      (disowned routes reference it across a rollback). Checked as TEXT, so
#      a route embedded in a kustomize patch string is covered too; files
#      that do not parse fail rather than being skipped.
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
ALLOWED_RE='^(text/(html|css|plain|javascript|xml|csv|markdown|calendar|vcard)|application/(javascript|x-javascript|wasm|json|xml|manifest\+json|ld\+json|problem\+json|rss\+xml|atom\+xml|xhtml\+xml)|image/svg\+xml)$'

fail=0; found=0
# Every file this guard reasons about must parse: a yq error below would
# otherwise read as "no Middleware here" and the file would be skipped.
while IFS= read -r -d '' f; do
  if ! err="$(yq eval-all '.' "$f" 2>&1 >/dev/null)"; then
    echo "::error::${f#"$ROOT"/}: not parseable YAML, so this guard cannot vouch for its compress/inflight settings: ${err}"
    fail=1
  fi
done < <(grep -rlZ --include='*.yaml' --include='*.yml' -E 'compress|inflight-per-client|inFlightReq' "$SCAN" 2>/dev/null || true)
while IFS= read -r -d '' f; do
  # One line per compress Middleware document: name|encodings|included. Not
  # TSV: `read` collapses consecutive tabs, so an EMPTY encodings field would
  # shift the allowlist into its place.
  while IFS='|' read -r name enc inc; do
    [[ -n "$name" ]] || continue
    found=$((found + 1))
    where="${f#"$ROOT"/}: Middleware ${name}"
    if [[ "$enc" != "gzip" ]]; then
      echo "::error::${where}: compress.encodings must be exactly [gzip], got [${enc}] — a client that sends only 'Accept-Encoding: br' (or zstd) selects an encoder that costs several times the memory per response."
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
  while IFS='|' read -r name amount has_ip depth n_excl v6 req_host req_hdr prune; do
    [[ -n "$name" ]] || continue
    inflight_specs=$((inflight_specs + 1))
    where="${f#"$ROOT"/}: Middleware ${name}"
    if [[ ! "$amount" =~ ^[0-9]+$ ]] || (( amount < 1 || amount > 300 )); then
      echo "::error::${where}: inFlightReq.amount must be 1-300, got '${amount}' — above that one address can hold ~1 MiB per slow response past what Traefik's 1Gi limit absorbs."
      fail=1
    fi
    if [[ "$prune" != disabled ]]; then
      echo "::error::${where}: needs annotation kustomize.toolkit.fluxcd.io/prune: disabled — the Flux-disowned routes keep referencing it after a rollback, and Traefik drops a router whose Middleware is gone (webmail would 404)."
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
          (.spec.inFlightReq.sourceCriterion.requestHeaderName // "" | tostring),
          (.metadata.annotations["kustomize.toolkit.fluxcd.io/prune"] // "" | tostring) ] | join("|")' "$f" 2>/dev/null || true)
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
done < <(grep -rlZ --include='*.yaml' --include='*.yml' -E "name:[[:space:]]*[\"']?compress[\"']?([[:space:],}#]|\$)" "$SCAN" 2>/dev/null \
  | xargs -0 -r awk -v q="'" '
      # Name of a block-style list item ("- name: x", quotes and trailing
      # comment stripped), or "" when the line is not one.
      function item(line,   v) {
        if (line !~ /^[[:space:]]*-[[:space:]]*name:/) return ""
        v = line
        sub(/^[[:space:]]*-[[:space:]]*name:[[:space:]]*/, "", v)
        sub(/[[:space:]]+#.*$/, "", v)
        gsub("[\"" q "[:space:]]", "", v)
        return v
      }
      FNR == 1 { prev = ""; pend = ""; nsline = 0 }
      /^[[:space:]]*#/ { next }
      /^[[:space:]]*middlewares:[[:space:]]*(#.*)?$/ { prev = ""; next }
      $0 ~ ("-[[:space:]]*[{][^}]*name:[[:space:]]*[\"" q "]?(compress|inflight-per-client)[\"" q "]?[[:space:]]*[,}]") {
        print FILENAME ":" FNR ": flow-style middleware entry — write it block-style (- name: … / namespace: …) so this guard can check its order."
        next
      }
      pend != "" && FNR == nsline {
        ns = $0; sub(/^[[:space:]]*namespace:[[:space:]]*/, "", ns); sub(/[[:space:]]+#.*$/, "", ns); gsub("[\"" q "[:space:]]", "", ns)
        if ($0 ~ /^[[:space:]]*namespace:/ && ns == "traefik") prev = "inflight-ok"
        else print pend ": inflight-per-client must carry namespace: traefik on the next line"
        pend = ""
      }
      {
        it = item($0)
        if (it == "inflight-per-client") { prev = "inflight"; pend = FILENAME ":" FNR; nsline = FNR + 1; next }
        if (it == "compress") {
          print "ROUTE"
          if (prev != "inflight-ok") print FILENAME ":" FNR ": compress is not directly preceded by inflight-per-client (namespace traefik) in its middlewares list — one client could hold any number of compressed responses open."
          prev = "compress"; next
        }
        if (it != "") prev = "other"
      }
    ')
if [[ "$route_lists" -eq 0 ]]; then
  echo "::error::ci-traefik-compress-check: no middlewares list references compress — the route extraction matched nothing." >&2
  fail=1
fi

if [[ "$found" -eq 0 ]]; then
  echo "::error::ci-traefik-compress-check: found no compress Middleware under ${SCAN#"$ROOT"/} — the extraction matched nothing, so this guard would pass anything." >&2
  exit 1
fi
[[ "$fail" -eq 0 ]] && echo "ci-traefik-compress-check: ${found} compress Middleware(s) gzip-only with a text allowlist; ${route_lists} route(s) capped per client directly before compress — OK."
exit "$fail"
