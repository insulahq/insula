#!/usr/bin/env bash
# End-to-end test for per-mailbox quota + per-plan max-mailbox-size
# (feat/mailbox-quota-enforce).
#
# Covers the new enforcement, all against the real management API:
#   1. A mailbox created with NO quota DEFAULTS to the tenant's effective
#      max mailbox size (plan limit).
#   2. A create quota BELOW the max is accepted as-is.
#   3. A create quota ABOVE the max is rejected 409 MAILBOX_QUOTA_EXCEEDS_LIMIT.
#   4. A quota UPDATE above the max is rejected 409; below is accepted.
#   5. GET /mail/mailbox-usage surfaces maxMailboxSizeMb + source.
#   6. A per-tenant override (tenants.max_mailbox_size_mb_override) below the
#      plan tightens the cap: usage flips to source=tenant_override, an
#      over-override create is rejected, an under-override create is accepted.
#
# The Stalwart-side `quota/storage` set at CREATE (fix #1) is verified
# separately in the live E2E run (query the principal) — this suite asserts
# the deterministic, user-visible management-API behaviour.
#
# USAGE: ADMIN_PASSWORD=<…> ADMIN_HOST=https://admin.<env>.example.test \
#        ./scripts/integration-mailbox-quota-e2e.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/integration-env.sh
[[ -f "$SCRIPT_DIR/lib/integration-env.sh" ]] && source "$SCRIPT_DIR/lib/integration-env.sh" && load_integration_env

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.example.test}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"

[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; RESET='\033[0m'
log()  { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail() { printf '  %b✗%b %s\n' "$RED"   "$RESET" "$*"; failed=$((failed+1)); }
passed=0; failed=0

# api METHOD PATH [BODY] — returns the response body; path is under /api/v1.
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

# api_code METHOD PATH [BODY] — prints "<http_code>\n<body>"; for asserting
# status codes (e.g. the 409 rejection paths).
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

# Premium plan = 2048 MB cap → headroom for under/over tests.
PLANS=$(api GET "/plans")
PLAN_ID=$(echo "$PLANS" | python3 -c "import json,sys;print(next((p['id'] for p in json.load(sys.stdin)['data'] if p['name']=='Premium'),''))")
PLAN_MAX=$(echo "$PLANS" | python3 -c "import json,sys;print(next((p['maxMailboxSizeMb'] for p in json.load(sys.stdin)['data'] if p['name']=='Premium'),''))")
REGION_ID=$(api GET "/regions" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'][0]['id'])")
[[ -n "$PLAN_ID" && -n "$REGION_ID" ]] || { echo "no Premium plan / region (PLAN_ID=$PLAN_ID)" >&2; exit 1; }
[[ "$PLAN_MAX" == "2048" ]] && ok "Premium plan maxMailboxSizeMb=2048" \
  || fail "Premium maxMailboxSizeMb=$PLAN_MAX (expected 2048 — migration 0064 / seed)"

STAMP=$(date +%s)
log "── creating tenant on Premium plan ──"
RESP=$(api POST "/tenants" "{\"name\":\"MboxQuota E2E $STAMP\",\"primary_email\":\"mqe2e-$STAMP@example.test\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\"}")
CID=$(echo "$RESP" | jget "['data']['id']")
[[ -n "$CID" ]] && ok "tenant cid=$CID" || { fail "create failed: $(echo "$RESP" | head -c 300)"; exit 1; }
cleanup() { curl -sk -X DELETE "$ADMIN_HOST/api/v1/tenants/$CID" -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "── waiting for provisioning ──"
STATUS=""
for _ in $(seq 1 90); do
  STATUS=$(api GET "/tenants/$CID" | jget "['data'].get('provisioningStatus') or ''")
  [[ "$STATUS" == "provisioned" ]] && break
  sleep 2
done
[[ "$STATUS" == "provisioned" ]] && ok "provisioned" || { fail "stuck at provisioningStatus=$STATUS"; exit 1; }

TEST_DOMAIN="mqe2e${STAMP}.com"
log "── attaching + enabling email domain $TEST_DOMAIN ──"
DOM_ID=$(api POST "/tenants/$CID/domains" "{\"domain_name\":\"$TEST_DOMAIN\",\"dns_mode\":\"cname\"}" | jget "['data']['id']")
[[ -n "$DOM_ID" ]] && ok "domain attached id=$DOM_ID" || { fail "domain create failed"; exit 1; }
ENABLE=$(api POST "/tenants/$CID/email/domains/$DOM_ID/enable" "{}")
EMAIL_DOMAIN_ID=$(echo "$ENABLE" | jget "['data']['id']")
[[ -n "$EMAIL_DOMAIN_ID" ]] && ok "email enabled email_domain_id=$EMAIL_DOMAIN_ID" \
  || { fail "enable email failed: $(echo "$ENABLE" | head -c 300)"; exit 1; }

MB="/tenants/$CID/email/domains/$EMAIL_DOMAIN_ID/mailboxes"

# ── T1: create with NO quota → defaults to the plan max (2048) ──────────
log "── T1: create without quota → defaults to plan max ──"
T1=$(api POST "$MB" "{\"local_part\":\"defaultmax\",\"mailbox_type\":\"mailbox\"}")
T1_Q=$(echo "$T1" | jget "['data']['quotaMb']")
[[ "$T1_Q" == "2048" ]] && ok "defaulted quotaMb=2048 (plan max)" \
  || fail "quotaMb=$T1_Q (expected 2048) — body: $(echo "$T1" | head -c 200)"

# ── T2: create BELOW the max → accepted as-is ───────────────────────────
log "── T2: create with quota below max → accepted ──"
T2=$(api POST "$MB" "{\"local_part\":\"under\",\"quota_mb\":500,\"mailbox_type\":\"mailbox\"}")
T2_Q=$(echo "$T2" | jget "['data']['quotaMb']")
[[ "$T2_Q" == "500" ]] && ok "quotaMb=500 accepted" || fail "quotaMb=$T2_Q (expected 500)"

# ── T3: create ABOVE the max → 409 MAILBOX_QUOTA_EXCEEDS_LIMIT ───────────
log "── T3: create with quota above max → 409 ──"
T3=$(api_code POST "$MB" "{\"local_part\":\"toobig\",\"quota_mb\":9999,\"mailbox_type\":\"mailbox\"}")
T3_CODE=$(echo "$T3" | tail -1); T3_BODY=$(echo "$T3" | sed '$d')
T3_ERR=$(echo "$T3_BODY" | jget "['error']['code']")
[[ "$T3_CODE" == "409" && "$T3_ERR" == "MAILBOX_QUOTA_EXCEEDS_LIMIT" ]] \
  && ok "rejected 409 MAILBOX_QUOTA_EXCEEDS_LIMIT" \
  || fail "got code=$T3_CODE err=$T3_ERR (expected 409/MAILBOX_QUOTA_EXCEEDS_LIMIT)"

# ── T4: update quota above max → 409; below → accepted ──────────────────
log "── T4: update quota above max → 409, below → accepted ──"
U_ID=$(api GET "/tenants/$CID/mailboxes" | python3 -c "import json,sys;print(next((m['id'] for m in json.load(sys.stdin)['data'] if m['localPart']=='under'),''))")
U1=$(api_code PATCH "/tenants/$CID/mailboxes/$U_ID" "{\"quota_mb\":9999}")
U1_CODE=$(echo "$U1" | tail -1); U1_ERR=$(echo "$U1" | sed '$d' | jget "['error']['code']")
[[ "$U1_CODE" == "409" && "$U1_ERR" == "MAILBOX_QUOTA_EXCEEDS_LIMIT" ]] \
  && ok "update over max rejected 409" || fail "update over max: code=$U1_CODE err=$U1_ERR"
U2_Q=$(api PATCH "/tenants/$CID/mailboxes/$U_ID" "{\"quota_mb\":1500}" | jget "['data']['quotaMb']")
[[ "$U2_Q" == "1500" ]] && ok "update to 1500 accepted" || fail "update under max: quotaMb=$U2_Q (expected 1500)"

# ── T5: usage endpoint surfaces the cap ─────────────────────────────────
log "── T5: mailbox-usage surfaces maxMailboxSizeMb ──"
USAGE=$(api GET "/tenants/$CID/mail/mailbox-usage")
U_MAX=$(echo "$USAGE" | jget "['data']['maxMailboxSizeMb']")
U_SRC=$(echo "$USAGE" | jget "['data']['maxMailboxSizeSource']")
[[ "$U_MAX" == "2048" && "$U_SRC" == "plan" ]] && ok "usage maxMailboxSizeMb=2048 source=plan" \
  || fail "usage maxMailboxSizeMb=$U_MAX source=$U_SRC (expected 2048/plan)"

# ── T6: per-tenant override tightens the cap ────────────────────────────
log "── T6: per-tenant override (800) tightens the cap ──"
api PATCH "/tenants/$CID" "{\"max_mailbox_size_mb_override\":800}" >/dev/null
USAGE2=$(api GET "/tenants/$CID/mail/mailbox-usage")
O_MAX=$(echo "$USAGE2" | jget "['data']['maxMailboxSizeMb']")
O_SRC=$(echo "$USAGE2" | jget "['data']['maxMailboxSizeSource']")
[[ "$O_MAX" == "800" && "$O_SRC" == "tenant_override" ]] \
  && ok "usage flips to 800 / tenant_override" || fail "usage maxMailboxSizeMb=$O_MAX source=$O_SRC (expected 800/tenant_override)"
O1=$(api_code POST "$MB" "{\"local_part\":\"overoverride\",\"quota_mb\":1000,\"mailbox_type\":\"mailbox\"}")
O1_CODE=$(echo "$O1" | tail -1)
[[ "$O1_CODE" == "409" ]] && ok "create 1000 > override 800 rejected 409" || fail "expected 409, got $O1_CODE"
O2_Q=$(api POST "$MB" "{\"local_part\":\"underoverride\",\"quota_mb\":700,\"mailbox_type\":\"mailbox\"}" | jget "['data']['quotaMb']")
[[ "$O2_Q" == "700" ]] && ok "create 700 <= override 800 accepted" || fail "quotaMb=$O2_Q (expected 700)"

printf '\n%b== mailbox-quota E2E: %d passed, %d failed ==%b\n' "$CYAN" "$passed" "$failed" "$RESET"
[[ "$failed" -eq 0 ]] || exit 1
