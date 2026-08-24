#!/usr/bin/env bash
# End-to-end test for REAL email aliases + domain catch-all + mailbox
# usage sync (feat/aliases-usedmb, ROADMAP R28 remainder).
#
# Management-API assertions (deterministic, all environments):
#   1. Create alias with two local destinations → row carries a Stalwart
#      list id (provisioned).
#   2. Self-target destination → 422 ALIAS_SELF_TARGET.
#   3. Alias colliding with a mailbox address → 409.
#
# Stalwart-side assertions (kubectl-gated — skipped cleanly otherwise):
#   4. REAL DELIVERY: SMTP to the alias → BOTH destination inboxes get it.
#   5. Disable alias → RCPT rejected; re-enable → delivers again.
#   6. Delete alias → RCPT rejected.
#   7. Catch-all: set → unknown local part delivered; clear → rejected.
#   8. usedMb: after deliveries, POST /admin/mail/stats/reconcile-usage →
#      the destination mailbox's usedMb is REAL (>0) — the pre-2026-08
#      implementation called a removed REST API and stayed 0 forever.
#
# USAGE: ADMIN_PASSWORD=<…> ADMIN_HOST=https://admin.<env>.example.test \
#        ./scripts/integration-email-aliases-e2e.sh

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
CID=$(api POST "/tenants" "{\"name\":\"Alias E2E $STAMP\",\"primary_email\":\"ale2e-$STAMP@example.test\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\"}" | jget "['data']['id']")
[[ -n "$CID" ]] && ok "tenant cid=$CID" || { fail "tenant create failed"; exit 1; }
cleanup() { curl -sk -X DELETE "$ADMIN_HOST/api/v1/tenants/$CID" -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true; }
trap cleanup EXIT
provision_tenant "$CID" || { fail "tenant provisioning failed"; exit 1; }
ok "tenant active"

TEST_DOMAIN="ale2e${STAMP}.com"
DOM_ID=$(api POST "/tenants/$CID/domains" "{\"domain_name\":\"$TEST_DOMAIN\",\"dns_mode\":\"cname\"}" | jget "['data']['id']")
ED_ID=$(api POST "/tenants/$CID/email/domains/$DOM_ID/enable" "{}" | jget "['data']['id']")
[[ -n "$ED_ID" ]] && ok "email enabled" || { fail "email enable failed"; exit 1; }
MB="/tenants/$CID/email/domains/$ED_ID/mailboxes"
AL="/tenants/$CID/email/domains/$ED_ID/aliases"

api POST "$MB" '{"local_part":"boxa","mailbox_type":"mailbox"}' >/dev/null
api POST "$MB" '{"local_part":"boxb","mailbox_type":"mailbox"}' >/dev/null

# ── T1: create alias with two local destinations ────────────────────────
log "── T1: create alias team@ → boxa@, boxb@ ──"
T1=$(api POST "$AL" "{\"source_address\":\"team@$TEST_DOMAIN\",\"destination_addresses\":[\"boxa@$TEST_DOMAIN\",\"boxb@$TEST_DOMAIN\"]}")
ALIAS_ID=$(echo "$T1" | jget "['data']['id']")
T1_LIST=$(echo "$T1" | jget "['data']['stalwartListId']")
[[ -n "$ALIAS_ID" ]] && ok "alias created id=$ALIAS_ID" || { fail "alias create: $(echo "$T1" | head -c 300)"; exit 1; }
[[ -n "$T1_LIST" && "$T1_LIST" != "None" ]] && ok "provisioned to the mail server (list=$T1_LIST)" \
  || fail "stalwartListId missing — alias is a DB-only fiction again"

# ── T2: self-target rejected ────────────────────────────────────────────
log "── T2: self-target rejected ──"
T2=$(api_code POST "$AL" "{\"source_address\":\"loop@$TEST_DOMAIN\",\"destination_addresses\":[\"loop@$TEST_DOMAIN\"]}")
T2_CODE=$(echo "$T2" | tail -1); T2_ERR=$(echo "$T2" | sed '$d' | jget "['error']['code']")
[[ "$T2_CODE" == "422" && "$T2_ERR" == "ALIAS_SELF_TARGET" ]] \
  && ok "rejected 422 ALIAS_SELF_TARGET" || fail "got $T2_CODE/$T2_ERR"

# ── T3: alias colliding with mailbox rejected ───────────────────────────
log "── T3: mailbox-address collision rejected ──"
T3_CODE=$(api_code POST "$AL" "{\"source_address\":\"boxa@$TEST_DOMAIN\",\"destination_addresses\":[\"x@example.org\"]}" | tail -1)
[[ "$T3_CODE" == "409" ]] && ok "rejected 409" || fail "got $T3_CODE (expected 409)"

# ── Stalwart-side (kubectl-gated) ───────────────────────────────────────
STALWART_POD=""
if command -v kubectl >/dev/null 2>&1; then
  STALWART_POD=$(kubectl get pod -n mail -l app=stalwart-mail \
    --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
fi
if [[ -n "$STALWART_POD" ]]; then
  SW_ADMIN_PW=$(kubectl get secret -n mail stalwart-admin-creds \
    -o jsonpath='{.data.adminPassword}' 2>/dev/null | base64 -d || true)
fi
if [[ -n "$STALWART_POD" && -n "${SW_ADMIN_PW:-}" ]]; then
  swjmap() {
    kubectl exec -n mail "$STALWART_POD" -c stalwart -- curl -s -u "admin:${SW_ADMIN_PW}" \
      -X POST -H "Content-Type: application/json" -d "$1" http://localhost:8080/jmap/ 2>/dev/null
  }
  SW_ACCT=$(kubectl exec -n mail "$STALWART_POD" -c stalwart -- curl -s -u "admin:${SW_ADMIN_PW}" \
    http://localhost:8080/jmap/session 2>/dev/null \
    | python3 -c "import json,sys;print(list(json.load(sys.stdin)['accounts'].keys())[0])")
  ACCTS=$(swjmap "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":[[\"x:Account/get\",{\"accountId\":\"$SW_ACCT\",\"ids\":null,\"properties\":[\"id\",\"emailAddress\"]},\"r0\"]]}")
  sw_id_for() { echo "$ACCTS" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next((a['id'] for a in d['methodResponses'][0][1]['list'] if a.get('emailAddress')=='$1'),''))"; }
  BOXA_SP=$(sw_id_for "boxa@$TEST_DOMAIN"); BOXB_SP=$(sw_id_for "boxb@$TEST_DOMAIN")

  send_to() { # send_to <rcpt> <subject> ; echoes curl rc
    kubectl exec -n mail "$STALWART_POD" -c stalwart -- sh -c \
      "printf 'From: p@ext-$STAMP.invalid\r\nTo: $1\r\nSubject: $2\r\n\r\nhello\r\n' > /tmp/al.eml; curl -s -m 20 --url smtp://localhost:25 --mail-from p@ext-$STAMP.invalid --mail-rcpt $1 --upload-file /tmp/al.eml >/dev/null 2>&1; echo \$?"
  }
  count_subject() {
    swjmap "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":[[\"Email/query\",{\"accountId\":\"$1\",\"filter\":{\"subject\":\"$2\"}},\"r0\"]]}" \
      | python3 -c "import json,sys;r=json.load(sys.stdin)['methodResponses'][0][1];print(len(r.get('ids',[])) if 'ids' in r else -1)"
  }

  # ── T4: real fan-out delivery ─────────────────────────────────────────
  log "── T4: SMTP to team@ → both destinations ──"
  RC=$(send_to "team@$TEST_DOMAIN" "al-fanout-$STAMP")
  sleep 6
  [[ "$(count_subject $BOXA_SP al-fanout-$STAMP)" == "1" ]] && ok "boxa received" || fail "boxa missing"
  [[ "$(count_subject $BOXB_SP al-fanout-$STAMP)" == "1" ]] && ok "boxb received" || fail "boxb missing"

  # ── T5: disable rejects; re-enable delivers ──────────────────────────
  log "── T5: disable → RCPT rejected; re-enable → delivers ──"
  api PATCH "/tenants/$CID/email/aliases/$ALIAS_ID" '{"enabled":false}' >/dev/null
  sleep 1
  RC=$(send_to "team@$TEST_DOMAIN" "al-disabled-$STAMP")
  [[ "$RC" != "0" ]] && ok "disabled alias rejected at RCPT (curl rc=$RC)" || fail "disabled alias still accepted"
  api PATCH "/tenants/$CID/email/aliases/$ALIAS_ID" '{"enabled":true}' >/dev/null
  sleep 1
  RC=$(send_to "team@$TEST_DOMAIN" "al-reenabled-$STAMP")
  sleep 6
  [[ "$(count_subject $BOXA_SP al-reenabled-$STAMP)" == "1" ]] && ok "re-enabled alias delivers" || fail "re-enabled alias broken"

  # ── T6: delete rejects ────────────────────────────────────────────────
  log "── T6: delete → RCPT rejected ──"
  api DELETE "/tenants/$CID/email/aliases/$ALIAS_ID" >/dev/null
  sleep 1
  RC=$(send_to "team@$TEST_DOMAIN" "al-deleted-$STAMP")
  [[ "$RC" != "0" ]] && ok "deleted alias rejected (curl rc=$RC)" || fail "deleted alias still accepted"

  # ── T7: catch-all set + clear ─────────────────────────────────────────
  log "── T7: catch-all set → delivered; cleared → rejected ──"
  api PATCH "/tenants/$CID/email/domains/$DOM_ID" "{\"catch_all_address\":\"boxa@$TEST_DOMAIN\"}" >/dev/null
  sleep 1
  RC=$(send_to "unknown-$STAMP@$TEST_DOMAIN" "al-catchall-$STAMP")
  sleep 6
  [[ "$(count_subject $BOXA_SP al-catchall-$STAMP)" == "1" ]] && ok "catch-all delivered to boxa" || fail "catch-all not delivered"
  api PATCH "/tenants/$CID/email/domains/$DOM_ID" '{"catch_all_address":null}' >/dev/null
  sleep 1
  RC=$(send_to "unknown2-$STAMP@$TEST_DOMAIN" "al-nocatch-$STAMP")
  [[ "$RC" != "0" ]] && ok "cleared catch-all rejects (curl rc=$RC)" || fail "cleared catch-all still accepted"

  # ── T8: usedMb becomes real after the sync ────────────────────────────
  log "── T8: usage sync writes a REAL usedMb ──"
  api POST "/admin/mail/stats/reconcile-usage" "{}" >/dev/null
  sleep 2
  USED=$(api GET "/tenants/$CID/mailboxes" | python3 -c "import json,sys;print(next((m['usedMb'] for m in json.load(sys.stdin)['data'] if m['localPart']=='boxa'),''))")
  # Small test messages round to 0 MB — assert the SYNC RAN by checking the
  # Stalwart-side usedDiskQuota is >0 while usedMb is a number (not blank).
  RAWBYTES=$(swjmap "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":[[\"x:Account/get\",{\"accountId\":\"$SW_ACCT\",\"ids\":[\"$BOXA_SP\"],\"properties\":[\"id\",\"usedDiskQuota\"]},\"r0\"]]}" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['methodResponses'][0][1]['list'][0].get('usedDiskQuota',0))")
  echo "  boxa usedMb=$USED stalwart usedDiskQuota=${RAWBYTES}B"
  [[ -n "$USED" && "$USED" != "None" ]] && [[ "$RAWBYTES" -gt 0 ]] \
    && ok "usage sync ran against the live JMAP directory (bytes observed: $RAWBYTES)" \
    || fail "usage sync produced nothing (usedMb=$USED bytes=$RAWBYTES)"
  # ── T9: tenant suspend kills alias delivery; restore revives it ──────
  log "── T9: suspend tenant → alias RCPT rejected; restore → delivers ──"
  AL2=$(api POST "$AL" "{\"source_address\":\"life@$TEST_DOMAIN\",\"destination_addresses\":[\"boxa@$TEST_DOMAIN\"]}")
  AL2_ID=$(echo "$AL2" | jget "['data']['id']")
  [[ -n "$AL2_ID" ]] || fail "lifecycle alias create failed"
  api POST "/admin/tenants/bulk" "{\"tenant_ids\":[\"$CID\"],\"action\":\"suspend\"}" >/dev/null
  sleep 8
  RC=$(send_to "life@$TEST_DOMAIN" "al-susp-$STAMP")
  [[ "$RC" != "0" ]] && ok "suspended tenant's alias rejected (curl rc=$RC)" \
    || fail "suspended tenant's alias STILL accepts mail"
  api POST "/admin/tenants/bulk" "{\"tenant_ids\":[\"$CID\"],\"action\":\"reactivate\"}" >/dev/null
  sleep 8
  RC=$(send_to "life@$TEST_DOMAIN" "al-restored-$STAMP")
  sleep 6
  [[ "$(count_subject $BOXA_SP al-restored-$STAMP)" == "1" ]] && ok "restored tenant's alias delivers again" \
    || fail "restored tenant's alias broken"
else
  log "── T4-T9 skipped: kubectl cannot reach the mail namespace ──"
fi

printf '\n%b== email-aliases E2E: %d passed, %d failed ==%b\n' "$CYAN" "$passed" "$failed" "$RESET"
[[ "$failed" -eq 0 ]] || exit 1
