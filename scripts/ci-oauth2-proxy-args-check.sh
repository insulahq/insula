#!/usr/bin/env bash
# Guard: every oauth2-proxy `args` list must carry the flags that make
# two-panel sign-in work.
#
# WHY THIS EXISTS
#
# A Kustomize strategic-merge patch REPLACES a list of scalars wholesale. So an
# overlay that patches `args:` — which every environment overlay does, to point
# oauth2-proxy at a cluster-internal Dex — silently drops anything added to the
# base args. On 2026-09-05 `--cookie-domain` / `--whitelist-domain` were added to
# k8s/base/oauth2-proxy/deployment.yaml, Flux reported the revision applied, and
# the live Deployment still did not have them. Nothing failed; the tenant panel
# simply could not complete an oauth2-proxy sign-in.
#
# The failure mode is invisible from the base manifest, invisible from Flux, and
# only shows up if you read the running Deployment — so it gets a guard.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Flags that must appear in EVERY oauth2-proxy args list.
#
#  --cookie-domain    session cookie must span both panel subdomains, or a
#                     session established on one is invisible to the other
#  --whitelist-domain oauth2-proxy refuses a post-auth redirect to a host that
#                     is not listed, so the tenant panel could never finish
REQUIRED_FLAGS=(--cookie-domain --whitelist-domain)

mapfile -t FILES < <(grep -rl 'oauth2-proxy' k8s/base k8s/overlays --include='*.yaml' 2>/dev/null | sort)

checked=0
fail=0

for f in "${FILES[@]}"; do
  # Only files that actually declare an args list for the oauth2-proxy
  # container are in scope; a Service or NetworkPolicy naming it is not.
  grep -q -- '--http-address=' "$f" 2>/dev/null || continue
  checked=$((checked + 1))
  for flag in "${REQUIRED_FLAGS[@]}"; do
    if ! grep -q -- "$flag" "$f"; then
      echo "::error file=$f::oauth2-proxy args in $f are missing $flag" >&2
      echo "  A strategic-merge patch REPLACES the whole args list, so this file must" >&2
      echo "  repeat every flag it needs — inheriting from the base does NOT happen." >&2
      fail=1
    fi
  done
done

if (( checked == 0 )); then
  # Anti-vacuity: a guard that matched nothing must fail, not report success.
  echo "::error::ci-oauth2-proxy-args-check: found NO oauth2-proxy args lists to check — the detector is broken, not the repo clean" >&2
  exit 1
fi

if (( fail )); then
  exit 1
fi

echo "ci-oauth2-proxy-args-check: ${checked} oauth2-proxy args list(s) carry ${REQUIRED_FLAGS[*]} — OK."
