#!/usr/bin/env bash
# Shared admin-token helper for the integration suites.
#
# WHY: every suite used to mint its own super_admin Bearer via /auth/login.
# In ALL mode the long (60-90 min) serial run outlived a single token's
# 30-min TTL, so late suites hit 401; in single-test mode, running several
# suites back-to-back tripped the auth rate limit (429 → "Could not obtain
# ADMIN_TOKEN"). Both are harness problems, not platform bugs.
#
# get_admin_token() returns a valid token shared across processes via a
# cache file keyed by (ADMIN_HOST, ADMIN_EMAIL). It re-mints ONLY when the
# cached token is within 120s of expiry, and backs off on HTTP 429. So the
# whole ALL run and any number of rapid single runs reuse ONE token and
# only ever re-login when it genuinely expires.
#
# Usage in a suite (replaces a bespoke /auth/login block):
#   source "$(dirname "${BASH_SOURCE[0]}")/integration-token.sh"
#   TOKEN="$(get_admin_token)" || { echo "login failed" >&2; exit 1; }
#
# Requires: ADMIN_HOST, ADMIN_EMAIL, ADMIN_PASSWORD (or a pre-set
# INTEGRATION_TOKEN, which seeds the cache for siblings).

_itoken_cache_file() {
  local key
  key=$(printf '%s|%s' "${ADMIN_HOST:-}" "${ADMIN_EMAIL:-}" | cksum | cut -d' ' -f1)
  printf '%s/insula-itoken-%s' "${TMPDIR:-/tmp}" "$key"
}

# _itoken_mint: POST /auth/login, echo "<expiry-epoch>|<token>" on success.
# Honors HTTP 429 with exponential backoff; tolerates a transient blip.
_itoken_mint() {
  local body code resp tok exp attempt
  body=$(ADMIN_EMAIL="${ADMIN_EMAIL:-}" ADMIN_PASSWORD="${ADMIN_PASSWORD:-}" python3 -c \
    'import json,os;print(json.dumps({"email":os.environ.get("ADMIN_EMAIL",""),"password":os.environ.get("ADMIN_PASSWORD","")}))' 2>/dev/null)
  for attempt in 1 2 3 4 5 6; do
    resp=$(curl -sk -w $'\n%{http_code}' --max-time 25 -X POST "$ADMIN_HOST/api/v1/auth/login" \
      -H 'Content-Type: application/json' -d "$body" 2>/dev/null)
    code="${resp##*$'\n'}"; resp="${resp%$'\n'*}"
    if [[ "$code" == "200" ]]; then
      tok=$(printf '%s' "$resp" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["token"])' 2>/dev/null)
      exp=$(printf '%s' "$resp" | python3 -c 'import json,sys;print(int(json.load(sys.stdin)["data"].get("expiresIn",1800)))' 2>/dev/null)
      [[ -n "$tok" ]] || return 1
      printf '%s|%s\n' "$(( $(date +%s) + ${exp:-1800} ))" "$tok"
      return 0
    fi
    # 429 (rate limit) or transient 5xx/000 → back off and retry.
    if [[ "$code" == "429" ]]; then
      sleep $(( attempt * attempt * 2 ))
    else
      sleep "$attempt"
    fi
  done
  return 1
}

# api_curl: a drop-in for `curl` that transparently retries the two TRANSIENT
# control-plane failures the full ALL run hits, so neither fails a suite:
#   1. the GLOBAL API rate limiter (HTTP 429 / @fastify/rate-limit) — the
#      parallel batch's request burst trips it on creates (observed 2026-06-25);
#   2. a brief control-plane BLIP — empty body, connection refused (000), or 5xx
#      — the platform is momentarily unavailable during system-db maintenance /
#      a platform-api roll (root-caused 2026-06-26: a CNPG snapshot-recovery
#      recreates system-db + rolls the API). The parallel suites were dying on
#      empty bodies (JSONDecodeError) from these windows.
# Both are LEGITIMATE platform behaviour, so back off + retry (up to ~105s total)
# rather than fail. A PERSISTENT error still surfaces — after the retries we
# return the last body, so a real 4xx/5xx/empty reaches the caller's assertion.
#
# Pass the SAME args you'd pass curl (including -s/-k); api_curl appends its own
# -w to capture the status code, then emits ONLY the response body on stdout —
# so callers parse JSON exactly as with a bare curl.
api_curl() {
  local _resp _code _body _attempt
  for _attempt in 1 2 3 4 5 6 7 8 9 10; do
    _resp=$(curl -w $'\n%{http_code}' "$@" 2>/dev/null)
    _code="${_resp##*$'\n'}"; _body="${_resp%$'\n'*}"
    [[ "$_code" =~ ^[0-9]+$ ]] || _code=000
    if [[ "$_code" == "429" || "$_code" == "000" || "$_code" -ge 500 || -z "$_body" ]]; then
      sleep $(( _attempt < 5 ? _attempt * 3 : 15 ))
      continue
    fi
    printf '%s' "$_body"
    return 0
  done
  printf '%s' "$_body"   # exhausted retries — return the last body so the caller can report it
  return 0
}

# get_admin_token: echo a valid Bearer, reusing the shared cache when fresh.
get_admin_token() {
  local cache exp tok now line
  cache="$(_itoken_cache_file)"; now=$(date +%s)

  # 1) Fresh cache wins (the common case: every sibling suite reuses it).
  if [[ -r "$cache" ]]; then
    IFS='|' read -r exp tok < "$cache" 2>/dev/null || true
    if [[ -n "$tok" && "${exp:-0}" =~ ^[0-9]+$ && "${exp:-0}" -gt $((now + 120)) ]]; then
      printf '%s\n' "$tok"; return 0
    fi
  fi

  # 2) A caller-supplied INTEGRATION_TOKEN with no cache yet → trust it once
  #    and seed the cache (conservative 20-min lifetime) so siblings reuse it.
  if [[ -n "${INTEGRATION_TOKEN:-}" && ! -r "$cache" ]]; then
    ( umask 077; printf '%s|%s\n' "$((now + 1200))" "$INTEGRATION_TOKEN" > "$cache" ) 2>/dev/null
    printf '%s\n' "$INTEGRATION_TOKEN"; return 0
  fi

  # 3) Mint fresh (429-aware) and cache for everyone else.
  line="$(_itoken_mint)" || {
    echo "get_admin_token: /auth/login failed (rate-limited or bad creds)" >&2
    return 1
  }
  # Atomic write (temp + rename) so a concurrent reader/refresher never sees a
  # half-written cache line.
  ( umask 077; local t="${cache}.$$"; printf '%s\n' "$line" > "$t" && mv -f "$t" "$cache" ) 2>/dev/null
  printf '%s\n' "${line#*|}"
}

# Drop the cache so the next get_admin_token re-mints — call on a 401 mid-run.
invalidate_admin_token() { rm -f "$(_itoken_cache_file)" 2>/dev/null || true; }

# force_mint_token: ALWAYS mint a FRESH, full-TTL token, ignoring + refreshing
# the shared cache. get_admin_token reuses a cached token while it is still
# >120s from expiry, so calling it "to refresh" before a LONG phase (e.g. the
# 30-min parallel group) returns a near-dead token — the group then inherits a
# token that dies mid-flight (the INVALID_TOKEN cascade). Use this instead at
# phase boundaries so each long phase starts with a full token.
#
# Unsets INTEGRATION_TOKEN inside this (sub)shell so get_admin_token cannot
# short-circuit on the stale inherited value (branch 2). The caller captures
# the printed fresh token and re-exports it.
force_mint_token() {
  invalidate_admin_token
  unset INTEGRATION_TOKEN
  get_admin_token
}
