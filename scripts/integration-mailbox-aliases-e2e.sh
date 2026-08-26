#!/usr/bin/env bash
# End-to-end test for PER-MAILBOX ALIASES (receive + send-as; 2026-08-25).
#
# Management-API assertions (deterministic, all environments):
#   1. Create alias info@ on a mailbox → 201, enabled=1.
#   2. Alias colliding with an existing mailbox address → 409.
#   3. Alias colliding with a mailing-list source address → 409.
#   4. Mailbox list rows carry the enabled alias in `aliases`.
#   5. Invalid local part (embedded '@') → 400.
#
# Stalwart-side assertions (kubectl-gated — skipped cleanly otherwise):
#   6. REAL DELIVERY: SMTP to the alias → lands in the parent mailbox.
#   7. SEND-AS: authenticated parent submits MAIL FROM the alias →
#      accepted + delivered with the alias From; MAIL FROM an unowned
#      address → rejected (Stalwart-side enforcement).
#   8. IDENTITY: the parent account has a JMAP Identity for the alias
#      (what Bulwark's From selector consumes).
#   9. Disable → RCPT rejected AND send-as rejected; re-enable → both work.
#  10. Delete → RCPT rejected; identity gone.
#  11. Tenant SUSPENSION = full mail shutdown (2026-08-26): primary
#      inbound ereject-bounced (nothing stored), alias RCPT 550,
#      authentication refused (no submission).
#  12. Reactivation restores primary delivery, alias delivery, send-as.
#
# USAGE: ADMIN_PASSWORD=<…> ADMIN_HOST=https://admin.<env>.example.test \
#        ./scripts/integration-mailbox-aliases-e2e.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/integration-env.sh
[[ -f "$SCRIPT_DIR/lib/integration-env.sh" ]] && source "$SCRIPT_DIR/lib/integration-env.sh" && load_integration_env

ADMIN_HOST="${ADMIN_HOST:-https://admin.$(resolve_platform_apex)}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"

[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; RESET='\033[0m'
log()  { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail() { printf '  %b✗%b %s\n' "$RED"   "$RESET" "$*"; failed=$((failed+1)); }
passed=0; failed=0

kctl() {
  # shellcheck disable=SC2086
  ${KUBECTL:-kubectl} "$@"
}

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -z "$body" ]]; then
    curl -sk --max-time 60 --retry 2 --retry-all-errors --retry-delay 2 \
      -X "$method" "$ADMIN_HOST/api/v1$path" -H "Authorization: Bearer $TOKEN"
  else
    curl -sk --max-time 60 --retry 2 --retry-all-errors --retry-delay 2 \
      -X "$method" "$ADMIN_HOST/api/v1$path" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$body"
  fi
}
api_code() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -z "$body" ]]; then
    curl -sk --max-time 60 -w '\n%{http_code}' \
      -X "$method" "$ADMIN_HOST/api/v1$path" -H "Authorization: Bearer $TOKEN"
  else
    curl -sk --max-time 60 -w '\n%{http_code}' \
      -X "$method" "$ADMIN_HOST/api/v1$path" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$body"
  fi
}
jget() { python3 -c "import json,sys;d=json.load(sys.stdin);print(eval(\"d$1\") if d else '')" 2>/dev/null; }

log "logging in"
TOKEN=$(curl -sk -X POST "$ADMIN_HOST/api/v1/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])")
[[ -n "$TOKEN" ]] || { echo "login failed" >&2; exit 1; }

PLAN_ID=$(api GET "/plans" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'][0]['id'])")
REGION_ID=$(api GET "/regions" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'][0]['id'])")

STAMP=$(date +%s)
log "── creating tenant ──"
CID=$(api POST "/tenants" "{\"name\":\"MbAlias E2E $STAMP\",\"primary_email\":\"mba-$STAMP@example.test\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\"}" | jget "['data']['id']")
[[ -n "$CID" ]] && ok "tenant cid=$CID" || { fail "tenant create failed"; exit 1; }
cleanup() { curl -sk -X DELETE "$ADMIN_HOST/api/v1/tenants/$CID" -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true; }
trap cleanup EXIT
provision_tenant "$CID" || { fail "tenant provisioning failed"; exit 1; }
ok "tenant active"

TEST_DOMAIN="mba${STAMP}.com"
DOM_ID=$(api POST "/tenants/$CID/domains" "{\"domain_name\":\"$TEST_DOMAIN\",\"dns_mode\":\"cname\"}" | jget "['data']['id']")
ED_ID=$(api POST "/tenants/$CID/email/domains/$DOM_ID/enable" "{}" | jget "['data']['id']")
[[ -n "$ED_ID" ]] && ok "email enabled" || { fail "email enable failed"; exit 1; }
MB="/tenants/$CID/email/domains/$ED_ID/mailboxes"

# Parent mailbox (capture the auto-issued login password for send-as) +
# a second mailbox as the send-as recipient.
PARENT_RES=$(api POST "$MB" '{"local_part":"myname","mailbox_type":"mailbox"}')
PARENT_ID=$(echo "$PARENT_RES" | jget "['data']['id']")
PARENT_PW=$(echo "$PARENT_RES" | jget "['data']['initialLoginPassword']['secret']")
[[ -n "$PARENT_ID" ]] && ok "parent mailbox myname@" || { fail "parent create failed"; exit 1; }
api POST "$MB" '{"local_part":"peer","mailbox_type":"mailbox"}' >/dev/null

MA_BASE="/tenants/$CID/email/mailboxes/$PARENT_ID/aliases"
MA_ITEM="/tenants/$CID/email/mailbox-aliases"

# ── T1: create alias info@ on the parent mailbox ────────────────────────
log "── T1: create alias info@ on myname@ ──"
T1=$(api POST "$MA_BASE" '{"local_part":"info"}')
AL_ID=$(echo "$T1" | jget "['data']['id']")
AL_EN=$(echo "$T1" | jget "['data']['enabled']")
[[ -n "$AL_ID" && "$AL_EN" == "1" ]] && ok "alias created id=$AL_ID enabled=1" \
  || { fail "alias create: $(echo "$T1" | head -c 300)"; exit 1; }

# ── T2: collision with an existing mailbox address → 409 ────────────────
log "── T2: mailbox-address collision rejected ──"
T2_CODE=$(api_code POST "$MA_BASE" '{"local_part":"peer"}' | tail -1)
[[ "$T2_CODE" == "409" ]] && ok "rejected 409" || fail "got $T2_CODE (expected 409)"

# ── T3: collision with a mailing-list source → 409 ──────────────────────
log "── T3: mailing-list collision rejected ──"
api POST "/tenants/$CID/email/domains/$ED_ID/aliases" "{\"source_address\":\"list@$TEST_DOMAIN\",\"destination_addresses\":[\"peer@$TEST_DOMAIN\"]}" >/dev/null
T3_CODE=$(api_code POST "$MA_BASE" '{"local_part":"list"}' | tail -1)
[[ "$T3_CODE" == "409" ]] && ok "rejected 409" || fail "got $T3_CODE (expected 409)"

# ── T4: mailbox list rows carry the alias ───────────────────────────────
log "── T4: aliases visible on the mailbox row ──"
ROW_ALIASES=$(api GET "/tenants/$CID/mailboxes" | python3 -c "import json,sys;print(','.join(next((m.get('aliases') or [] for m in json.load(sys.stdin)['data'] if m['localPart']=='myname'),[])))")
[[ "$ROW_ALIASES" == *"info@$TEST_DOMAIN"* ]] && ok "row shows info@$TEST_DOMAIN" \
  || fail "row aliases: '$ROW_ALIASES'"

# ── T5: invalid local part rejected ─────────────────────────────────────
log "── T5: invalid local part rejected ──"
T5_CODE=$(api_code POST "$MA_BASE" '{"local_part":"evil@other.test"}' | tail -1)
[[ "$T5_CODE" == "400" ]] && ok "rejected 400" || fail "got $T5_CODE (expected 400)"

# ── Stalwart-side (kubectl-gated) ───────────────────────────────────────
STALWART_POD=""
if [[ -n "${KUBECTL:-}" ]] || command -v kubectl >/dev/null 2>&1; then
  STALWART_POD=$(kctl get pod -n mail -l app=stalwart-mail \
    --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
fi
if [[ -n "$STALWART_POD" ]]; then
  SW_ADMIN_PW=$(kctl get secret -n mail stalwart-admin-creds \
    -o jsonpath='{.data.adminPassword}' 2>/dev/null | base64 -d || true)
fi
if [[ -n "$STALWART_POD" && -n "${SW_ADMIN_PW:-}" && -n "${PARENT_PW:-}" && "$PARENT_PW" != "None" ]]; then
  swjmap() {
    kctl exec -n mail "$STALWART_POD" -c stalwart -- curl -s -u "admin:${SW_ADMIN_PW}" \
      -X POST -H "Content-Type: application/json" -d "$1" http://localhost:8080/jmap/ 2>/dev/null
  }
  SW_ACCT=$(kctl exec -n mail "$STALWART_POD" -c stalwart -- curl -s -u "admin:${SW_ADMIN_PW}" \
    http://localhost:8080/jmap/session 2>/dev/null \
    | python3 -c "import json,sys;print(list(json.load(sys.stdin)['accounts'].keys())[0])")
  ACCTS=$(swjmap "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":[[\"x:Account/get\",{\"accountId\":\"$SW_ACCT\",\"ids\":null,\"properties\":[\"id\",\"emailAddress\"]},\"r0\"]]}")
  sw_id_for() { echo "$ACCTS" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next((a['id'] for a in d['methodResponses'][0][1]['list'] if a.get('emailAddress')=='$1'),''))"; }
  PARENT_SP=$(sw_id_for "myname@$TEST_DOMAIN"); PEER_SP=$(sw_id_for "peer@$TEST_DOMAIN")

  send_to() { # inbound :25 → curl rc
    kctl exec -n mail "$STALWART_POD" -c stalwart -- sh -c \
      "printf 'From: p@ext-$STAMP.invalid\r\nTo: $1\r\nSubject: $2\r\n\r\nhello\r\n' > /tmp/mba.eml; curl -s -m 20 --url smtp://localhost:25 --mail-from p@ext-$STAMP.invalid --mail-rcpt $1 --upload-file /tmp/mba.eml >/dev/null 2>&1; echo \$?"
  }
  submit_as() { # submit_as <mail-from> <rcpt> <subject> — authed submission on :465 → curl rc
    kctl exec -n mail "$STALWART_POD" -c stalwart -- sh -c \
      "printf 'From: $1\r\nTo: $2\r\nSubject: $3\r\n\r\nsent-as\r\n' > /tmp/mbas.eml; curl -s -m 20 -k --url smtps://localhost:465 --user 'myname@$TEST_DOMAIN:$PARENT_PW' --mail-from $1 --mail-rcpt $2 --upload-file /tmp/mbas.eml >/dev/null 2>&1; echo \$?"
  }
  count_subject() {
    swjmap "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":[[\"Email/query\",{\"accountId\":\"$1\",\"filter\":{\"subject\":\"$2\"}},\"r0\"]]}" \
      | python3 -c "import json,sys;r=json.load(sys.stdin)['methodResponses'][0][1];print(len(r.get('ids',[])) if 'ids' in r else -1)"
  }
  identity_emails() { # admin-read of the parent's identities
    swjmap "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:submission\"],\"methodCalls\":[[\"Identity/get\",{\"accountId\":\"$PARENT_SP\",\"ids\":null},\"r0\"]]}" \
      | python3 -c "import json,sys;print(','.join(i.get('email','') for i in json.load(sys.stdin)['methodResponses'][0][1].get('list',[])))"
  }

  # ── T6: inbound to the alias lands in the parent inbox ────────────────
  log "── T6: SMTP to info@ → myname@ inbox ──"
  RC=$(send_to "info@$TEST_DOMAIN" "mba-inbound-$STAMP")
  sleep 6
  [[ "$(count_subject $PARENT_SP mba-inbound-$STAMP)" == "1" ]] && ok "delivered into parent" || fail "not delivered (rc=$RC)"

  # ── T7: send-as enforcement ───────────────────────────────────────────
  log "── T7: send-as info@ accepted; unowned MAIL FROM rejected ──"
  RC=$(submit_as "info@$TEST_DOMAIN" "peer@$TEST_DOMAIN" "mba-sendas-$STAMP")
  sleep 6
  [[ "$RC" == "0" && "$(count_subject $PEER_SP mba-sendas-$STAMP)" == "1" ]] \
    && ok "sent as the alias, delivered to peer" || fail "send-as failed (rc=$RC)"
  RC=$(submit_as "stranger@$TEST_DOMAIN" "peer@$TEST_DOMAIN" "mba-spoof-$STAMP")
  [[ "$RC" != "0" ]] && ok "unowned MAIL FROM rejected (rc=$RC)" || fail "spoofed sender ACCEPTED"

  # ── T8: identity present for webmail ──────────────────────────────────
  log "── T8: JMAP Identity for the alias exists ──"
  IDS=$(identity_emails)
  [[ "$IDS" == *"info@$TEST_DOMAIN"* ]] && ok "identity present ($IDS)" || fail "identity missing ($IDS)"

  # ── T9: disable stops both directions; re-enable restores ────────────
  log "── T9: disable → 550/501; re-enable → works ──"
  api PATCH "$MA_ITEM/$AL_ID" '{"enabled":false}' >/dev/null
  sleep 1
  RC=$(send_to "info@$TEST_DOMAIN" "mba-disabled-$STAMP")
  [[ "$RC" != "0" ]] && ok "disabled alias rejected inbound (rc=$RC)" || fail "disabled alias still receives"
  RC=$(submit_as "info@$TEST_DOMAIN" "peer@$TEST_DOMAIN" "mba-disabled-send-$STAMP")
  [[ "$RC" != "0" ]] && ok "disabled alias rejected send-as (rc=$RC)" || fail "disabled alias still sends"
  api PATCH "$MA_ITEM/$AL_ID" '{"enabled":true}' >/dev/null
  sleep 1
  RC=$(send_to "info@$TEST_DOMAIN" "mba-reenabled-$STAMP")
  sleep 6
  [[ "$(count_subject $PARENT_SP mba-reenabled-$STAMP)" == "1" ]] && ok "re-enabled alias receives" || fail "re-enabled alias broken"

  # ── T10: delete removes address + identity ────────────────────────────
  log "── T10: delete → rejected; identity gone ──"
  api DELETE "$MA_ITEM/$AL_ID" >/dev/null
  sleep 1
  RC=$(send_to "info@$TEST_DOMAIN" "mba-deleted-$STAMP")
  [[ "$RC" != "0" ]] && ok "deleted alias rejected (rc=$RC)" || fail "deleted alias still accepted"
  IDS=$(identity_emails)
  [[ "$IDS" != *"info@$TEST_DOMAIN"* ]] && ok "identity removed" || fail "identity lingers ($IDS)"

  # ── T11: tenant suspension = FULL mail shutdown (2026-08-26) ──────────
  # Inbound to the PRIMARY is accepted at SMTP then ereject-bounced (the
  # sender gets a DSN) — assert nothing lands in the store. The alias is
  # rejected at RCPT, and the account cannot authenticate to submit.
  log "── T11: suspend → primary bounced, alias 550, AUTH refused ──"
  api POST "$MA_BASE" '{"local_part":"billing"}' >/dev/null
  api POST "/admin/tenants/bulk" "{\"tenant_ids\":[\"$CID\"],\"action\":\"suspend\"}" >/dev/null
  sleep 8
  RC=$(send_to "myname@$TEST_DOMAIN" "mba-susp-primary-$STAMP")
  sleep 6
  [[ "$(count_subject $PARENT_SP mba-susp-primary-$STAMP)" == "0" ]] \
    && ok "suspended primary stored NOTHING (ereject bounce)" \
    || fail "suspended primary still stores mail"
  RC=$(send_to "billing@$TEST_DOMAIN" "mba-susp-alias-$STAMP")
  [[ "$RC" != "0" ]] && ok "suspended alias rejected at RCPT (rc=$RC)" || fail "suspended alias still accepted"
  RC=$(submit_as "myname@$TEST_DOMAIN" "peer@$TEST_DOMAIN" "mba-susp-send-$STAMP")
  [[ "$RC" != "0" ]] && ok "suspended account cannot authenticate/send (rc=$RC)" \
    || fail "suspended account STILL sends"

  # ── T12: reactivate restores primary + alias + sending ────────────────
  log "── T12: reactivate → everything restored ──"
  api POST "/admin/tenants/bulk" "{\"tenant_ids\":[\"$CID\"],\"action\":\"reactivate\"}" >/dev/null
  sleep 8
  RC=$(send_to "myname@$TEST_DOMAIN" "mba-react-primary-$STAMP")
  sleep 6
  [[ "$(count_subject $PARENT_SP mba-react-primary-$STAMP)" == "1" ]] \
    && ok "reactivated primary receives" || fail "reactivated primary broken"
  RC=$(send_to "billing@$TEST_DOMAIN" "mba-react-alias-$STAMP")
  sleep 6
  [[ "$(count_subject $PARENT_SP mba-react-alias-$STAMP)" == "1" ]] \
    && ok "reactivated alias receives" || fail "reactivated alias broken"
  RC=$(submit_as "billing@$TEST_DOMAIN" "peer@$TEST_DOMAIN" "mba-react-send-$STAMP")
  sleep 6
  [[ "$RC" == "0" && "$(count_subject $PEER_SP mba-react-send-$STAMP)" == "1" ]] \
    && ok "reactivated account sends as its alias again" || fail "reactivated send-as broken (rc=$RC)"
else
  log "── T6-T10 skipped: kubectl cannot reach the mail namespace (or no initial login password) ──"
fi

printf '\n%b== mailbox-aliases E2E: %d passed, %d failed ==%b\n' "$CYAN" "$passed" "$failed" "$RESET"
[[ "$failed" -eq 0 ]] || exit 1
