#!/usr/bin/env bash
# integration-stalwart-webadmin-auth.sh — the Stalwart web-admin is reachable
# through the admin-auth-cookie gate on its OWN subdomain.
#
# Regression guard for the "stalwart.<apex> → 401 for every operator" bug: the
# admin panel iframes/opens the Stalwart web-admin at stalwart.<apex>, gated by
# the admin-auth-cookie auth_request. That request lands on stalwart.<apex>, NOT
# admin.<apex>. If platform_session is issued host-only (scoped to admin.<apex>),
# a browser never sends it cross-subdomain and the gate 401s — the web-admin is
# unusable. The fix is SESSION_COOKIE_DOMAIN=.<apex> → Domain=.<apex>;
# SameSite=None (wired via platform-config `session-cookie-domain`).
#
# The prior mail suites only asserted the IngressRoute Host / cert followed a
# rename — never that the endpoint was actually REACHABLE through the gate with
# a browser-accurate cookie. This drives the real path.
#
# Env (profile-loaded via lib/integration-env.sh):
#   API_URL          required — https://admin.<apex>
#   ADMIN_EMAIL      required
#   ADMIN_PASSWORD   required
#   STALWART_URL     optional — default https://stalwart.<apex> (derived from API_URL)
#
# Skip (exit 77): stalwart.<apex> not reachable at all (mail stack not deployed).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/integration-env.sh"
load_integration_env
source "$SCRIPT_DIR/lib/integration-lib.sh"

require_env API_URL ADMIN_EMAIL ADMIN_PASSWORD

# Derive the apex from API_URL (admin.<apex>) → stalwart.<apex>.
APEX="$(printf '%s' "$API_URL" | sed -E 's#^https?://##; s#/.*$##; s#^admin\.##')"
STALWART_URL="${STALWART_URL:-https://stalwart.$APEX}"

COOKIE_JAR="$(mktemp /tmp/integration-stalwart-webadmin.XXXXXX.cookies)"
HDRS="$(mktemp /tmp/integration-stalwart-webadmin.XXXXXX.hdrs)"
cleanup() { rm -f "$COOKIE_JAR" "$HDRS"; }
trap cleanup EXIT

code_of() { curl -sk -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }

# ── Pre-flight: is stalwart.<apex> even serving? (skip if the mail stack isn't up) ──
ANON="$(code_of "$STALWART_URL/")"
if [[ "$ANON" == "000" ]]; then
  echo "SKIP: $STALWART_URL not reachable (mail stack not deployed here)" >&2
  exit 77
fi

il_phase_begin "gate is active (anonymous is rejected)"
# No cookie → the admin-auth-cookie gate must reject (401/403), NOT serve.
case "$ANON" in
  401|403) il_ok "anonymous stalwart.<apex>/ rejected by the gate ($ANON)" ;;
  *)       il_fail "anonymous stalwart.<apex>/ returned $ANON (expected 401/403 — gate not enforcing)" ;;
esac
il_phase_end

il_phase_begin "login issues a subdomain-spanning session cookie"
curl -sk -c "$COOKIE_JAR" -D "$HDRS" -o /dev/null --max-time 20 \
  -X POST "$API_URL/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}"
grep -q "platform_session" "$COOKIE_JAR" \
  && il_ok "login set platform_session" \
  || il_fail "login did not set platform_session"
# The invariant that fixes the bug: the cookie must span the apex (Domain=.<apex>)
# and be SameSite=None so a browser sends it on the cross-subdomain iframe load.
SC="$(grep -i '^set-cookie: platform_session' "$HDRS" || true)"
echo "$SC" | grep -qiE "Domain=\.$(printf '%s' "$APEX" | sed 's/\./\\./g')" \
  && il_ok "platform_session carries Domain=.<apex> (spans subdomains)" \
  || il_fail "platform_session is host-only — missing Domain=.<apex> (SESSION_COOKIE_DOMAIN unset?)"
echo "$SC" | grep -qi "SameSite=None" \
  && il_ok "platform_session is SameSite=None (sent on cross-subdomain loads)" \
  || il_fail "platform_session is not SameSite=None — browser won't send it to stalwart.<apex>"
il_phase_end

il_phase_begin "web-admin reachable through the gate with the cookie"
# WITH the real cookie jar (browser-accurate domain scoping) the gate must pass
# and reach Stalwart — anything but 401/403 means the cookie crossed the subdomain.
AUTH="$(code_of -b "$COOKIE_JAR" "$STALWART_URL/")"
case "$AUTH" in
  401|403) il_fail "stalwart.<apex>/ WITH cookie still $AUTH — cookie did not cross the subdomain" ;;
  000)     il_fail "stalwart.<apex>/ WITH cookie failed to connect" ;;
  *)       il_ok "stalwart.<apex>/ reachable through the gate with the cookie ($AUTH)" ;;
esac
il_phase_end

il_summary "integration-stalwart-webadmin-auth"
