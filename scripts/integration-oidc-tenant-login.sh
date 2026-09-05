#!/usr/bin/env bash
# Drive a REAL OIDC login through Dex, end to end, without a browser.
#
#   ./scripts/integration-oidc-tenant-login.sh <panel-host> <provider-id> <idp-user> <idp-password>
#
# Prints the account the backend resolved the identity to, or the error the
# callback redirected with:
#
#   RESULT ok    {"id":"…","email":"…","role":"tenant_user","tenantId":"…"}
#   RESULT error oidc_user_not_found&message=…
#
# WHY THIS EXISTS
#
# Three OIDC defects shipped in a row with unit tests behind them and no live
# sign-in (#404, #405). They were all in the part no unit test reaches: which
# ACCOUNT a given IdP identity resolves to. That question needs a real
# authorization-code exchange against a real IdP, and it is now one command.
#
# What it is good for, with a tenant that has two users and matching IdP
# identities (the DEV overlay ships `owner@oidc-e2e.test` / `staff@oidc-e2e.test`):
#
#   * each sub-user resolves to their OWN account, not to whichever one linked
#     the identity first — run it twice and compare `id` and `role`
#   * an identity linked on the ADMIN panel does NOT satisfy a TENANT sign-in
#     (expect `RESULT error oidc_user_not_found`)
#   * an IdP that varies the email casing still finds the existing account
#     rather than provisioning a second tenant
#
# It follows the same redirect chain a browser does and posts Dex's local-login
# form directly. Dex-specific by design: it is a test harness for the platform's
# own bundled IdP, not a generic OIDC client.
set -uo pipefail

HOST="$1"; PID="$2"; USERNAME="$3"; PASSWORD="$4"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
CURL=(curl -sk --cookie-jar "$JAR" --cookie "$JAR")

# 1. Ask the platform to start the flow; it 302s to Dex with PKCE state.
loc=$("${CURL[@]}" -o /dev/null -D- \
  "https://${HOST}/api/v1/auth/oidc/authorize/${PID}?redirect_uri=https%3A%2F%2F${HOST}%2Flogin" \
  | awk 'tolower($1)=="location:"{print $2}' | tr -d '\r')
[ -n "$loc" ] || { echo "FAIL: authorize did not redirect"; exit 1; }

# 2. Follow into Dex until we land on a page carrying the login form.
for _ in 1 2 3; do
  case "$loc" in
    /*) loc="https://dex.${HOST#*.}${loc}" ;;
  esac
  body=$("${CURL[@]}" -L -o - -D /tmp/h.$$ "$loc")
  # Dex renders the local-login form with a `req` parameter in its action.
  action=$(printf '%s' "$body" | grep -oiE 'action="[^"]*"' | head -1 | sed 's/action="//;s/"$//')
  [ -n "$action" ] && break
  loc=$(awk 'tolower($1)=="location:"{print $2}' /tmp/h.$$ | tail -1 | tr -d '\r')
  [ -n "$loc" ] || break
done
rm -f /tmp/h.$$
[ -n "${action:-}" ] || { echo "FAIL: no Dex login form found"; exit 1; }

case "$action" in
  /*) action="https://dex.${HOST#*.}${action}" ;;
esac

# 3. Post the credentials. Dex answers 303 → /approval → callback.
final=$("${CURL[@]}" -L -o /dev/null -w '%{url_effective}' \
  --data-urlencode "login=${USERNAME}" --data-urlencode "password=${PASSWORD}" \
  "$action")

# 4. The callback redirects to the panel with either a token or an error.
case "$final" in
  *token=*)
    user=$(printf '%s' "$final" | sed 's/.*[?&]user=//;s/&.*//')
    printf 'RESULT ok %s\n' "$(printf '%s' "$user" | python3 -c 'import sys,urllib.parse;print(urllib.parse.unquote(sys.stdin.read()))')"
    ;;
  *error=*)
    printf 'RESULT error %s\n' "$(printf '%s' "$final" | sed 's/.*[?&]error=//')"
    ;;
  *)
    printf 'RESULT unknown %s\n' "$final"
    ;;
esac
