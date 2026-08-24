#!/usr/bin/env bash
# End-to-end test for send-only mail accounts + per-mailbox forwarding
# (feat/mailbox-sendonly-forwarding).
#
# Management-API assertions (deterministic, all environments):
#   1. Create a send-only account → mailboxType=send_only, quotaMb=0.
#   2. Create send-only WITH quota_mb → 400 (contract superRefine).
#   3. Forwarding to the mailbox's own address → 422 FORWARDING_SELF_TARGET.
#   4. Set forwarding on a normal mailbox → forwardingAddresses persisted
#      (normalized: lowercased, deduped).
#   5. Quota edit on a send-only account → 409 SEND_ONLY_MAILBOX.
#   6. IMAP-migration into a send-only account → 409 SEND_ONLY_MAILBOX.
#   7. Clear forwarding with [] → forwardingAddresses null.
#
# Stalwart-side assertions (run when kubectl can reach the mail namespace —
# skipped cleanly otherwise):
#   8. The forwarding mailbox has an ACTIVE `platform-mail-rules` Sieve script.
#   9. REAL DELIVERY: SMTP a message to the forwarding mailbox → the copy
#      lands in the forward target's inbox AND stays in the source (redirect
#      :copy). SMTP to the send-only account (no forwarding) → nothing stored.
#
# (The webmail-token send-only guard needs a TENANT-user JWT and is covered
# by backend unit tests — an admin token has no tenant mailbox access.)
#
# USAGE: ADMIN_PASSWORD=<…> ADMIN_HOST=https://admin.<env>.example.test \
#        ./scripts/integration-mailbox-forwarding-e2e.sh

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
[[ -n "$PLAN_ID" && -n "$REGION_ID" ]] || { echo "no plan / region" >&2; exit 1; }

STAMP=$(date +%s)
log "── creating tenant ──"
RESP=$(api POST "/tenants" "{\"name\":\"MboxFwd E2E $STAMP\",\"primary_email\":\"mfe2e-$STAMP@example.test\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\"}")
CID=$(echo "$RESP" | jget "['data']['id']")
[[ -n "$CID" ]] && ok "tenant cid=$CID" || { fail "create failed: $(echo "$RESP" | head -c 300)"; exit 1; }
cleanup() { curl -sk -X DELETE "$ADMIN_HOST/api/v1/tenants/$CID" -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "── provisioning tenant ──"
provision_tenant "$CID" || { fail "mailbox-forwarding: tenant provisioning failed"; exit 1; }
ok "tenant active"

TEST_DOMAIN="mfe2e${STAMP}.com"
log "── attaching + enabling email domain $TEST_DOMAIN ──"
DOM_ID=$(api POST "/tenants/$CID/domains" "{\"domain_name\":\"$TEST_DOMAIN\",\"dns_mode\":\"cname\"}" | jget "['data']['id']")
[[ -n "$DOM_ID" ]] && ok "domain attached id=$DOM_ID" || { fail "domain create failed"; exit 1; }
ENABLE=$(api POST "/tenants/$CID/email/domains/$DOM_ID/enable" "{}")
EMAIL_DOMAIN_ID=$(echo "$ENABLE" | jget "['data']['id']")
[[ -n "$EMAIL_DOMAIN_ID" ]] && ok "email enabled email_domain_id=$EMAIL_DOMAIN_ID" \
  || { fail "enable email failed: $(echo "$ENABLE" | head -c 300)"; exit 1; }

MB="/tenants/$CID/email/domains/$EMAIL_DOMAIN_ID/mailboxes"

# ── T1: send-only create → mailboxType=send_only, quotaMb=0 ─────────────
log "── T1: create send-only account ──"
T1=$(api POST "$MB" "{\"local_part\":\"no-reply\",\"mailbox_type\":\"send_only\"}")
T1_TYPE=$(echo "$T1" | jget "['data']['mailboxType']")
T1_Q=$(echo "$T1" | jget "['data']['quotaMb']")
T1_PW=$(echo "$T1" | jget "['data']['initialLoginPassword']['secret']")
[[ "$T1_TYPE" == "send_only" && "$T1_Q" == "0" ]] \
  && ok "send-only created (type=$T1_TYPE quotaMb=$T1_Q)" \
  || fail "type=$T1_TYPE quotaMb=$T1_Q — body: $(echo "$T1" | head -c 300)"
[[ -n "$T1_PW" ]] && ok "initial login password issued (SMTP credential)" \
  || fail "no initial login password on send-only create"

# ── T2: send-only + quota_mb → contract rejection (400) ─────────────────
log "── T2: send-only with quota_mb rejected by contract ──"
T2=$(api_code POST "$MB" "{\"local_part\":\"no-reply2\",\"mailbox_type\":\"send_only\",\"quota_mb\":500}")
T2_CODE=$(echo "$T2" | tail -1)
[[ "$T2_CODE" == "400" ]] && ok "rejected $T2_CODE (quota_mb not applicable)" \
  || fail "expected 400, got $T2_CODE"

# ── T3: forwarding to self → 422 FORWARDING_SELF_TARGET ─────────────────
log "── T3: self-forwarding rejected ──"
T3=$(api_code POST "$MB" "{\"local_part\":\"selfloop\",\"mailbox_type\":\"mailbox\",\"forwarding_addresses\":[\"selfloop@$TEST_DOMAIN\"]}")
T3_CODE=$(echo "$T3" | tail -1); T3_ERR=$(echo "$T3" | sed '$d' | jget "['error']['code']")
[[ "$T3_CODE" == "422" && "$T3_ERR" == "FORWARDING_SELF_TARGET" ]] \
  && ok "rejected 422 FORWARDING_SELF_TARGET" \
  || fail "got code=$T3_CODE err=$T3_ERR (expected 422/FORWARDING_SELF_TARGET)"

# ── T4: forwarding on a normal mailbox, normalized ──────────────────────
log "── T4: create source + target, set forwarding ──"
TGT=$(api POST "$MB" "{\"local_part\":\"fwd-target\",\"mailbox_type\":\"mailbox\"}")
TGT_ID=$(echo "$TGT" | jget "['data']['id']")
SRC=$(api POST "$MB" "{\"local_part\":\"fwd-source\",\"mailbox_type\":\"mailbox\"}")
SRC_ID=$(echo "$SRC" | jget "['data']['id']")
[[ -n "$SRC_ID" && -n "$TGT_ID" ]] || { fail "mailbox creates failed"; exit 1; }
T4=$(api PATCH "/tenants/$CID/mailboxes/$SRC_ID" \
  "{\"forwarding_addresses\":[\"FWD-Target@$TEST_DOMAIN\",\"fwd-target@$TEST_DOMAIN\"]}")
T4_FWD=$(echo "$T4" | jget "['data']['forwardingAddresses']")
[[ "$T4_FWD" == "['fwd-target@$TEST_DOMAIN']" ]] \
  && ok "forwarding persisted + normalized: $T4_FWD" \
  || fail "forwardingAddresses=$T4_FWD (expected single lowercase target)"

# ── T5: quota edit on send-only → 409 SEND_ONLY_MAILBOX ─────────────────
log "── T5: quota edit on send-only rejected ──"
SO_ID=$(echo "$T1" | jget "['data']['id']")
T5=$(api_code PATCH "/tenants/$CID/mailboxes/$SO_ID" "{\"quota_mb\":500}")
T5_CODE=$(echo "$T5" | tail -1); T5_ERR=$(echo "$T5" | sed '$d' | jget "['error']['code']")
[[ "$T5_CODE" == "409" && "$T5_ERR" == "SEND_ONLY_MAILBOX" ]] \
  && ok "rejected 409 SEND_ONLY_MAILBOX" \
  || fail "got code=$T5_CODE err=$T5_ERR (expected 409/SEND_ONLY_MAILBOX)"

# ── T6: imapsync into send-only → 409 ───────────────────────────────────
log "── T6: IMAP migration into send-only rejected ──"
T6=$(api_code POST "/tenants/$CID/mail/imapsync" \
  "{\"mailbox_id\":\"$SO_ID\",\"source_host\":\"imap.example.net\",\"source_port\":993,\"source_username\":\"x@example.net\",\"source_password\":\"pw\",\"source_ssl\":true}")
T6_CODE=$(echo "$T6" | tail -1); T6_ERR=$(echo "$T6" | sed '$d' | jget "['error']['code']")
[[ "$T6_CODE" == "409" && "$T6_ERR" == "SEND_ONLY_MAILBOX" ]] \
  && ok "rejected 409 SEND_ONLY_MAILBOX" \
  || fail "got code=$T6_CODE err=$T6_ERR (expected 409/SEND_ONLY_MAILBOX)"

# ── Stalwart-side verification (kubectl-gated) ──────────────────────────
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
  swjmap() { # swjmap <json-body>
    kubectl exec -n mail "$STALWART_POD" -c stalwart -- curl -s -u "admin:${SW_ADMIN_PW}" \
      -X POST -H "Content-Type: application/json" -d "$1" http://localhost:8080/jmap/ 2>/dev/null
  }
  # Resolve the three principals' Stalwart ids by address (one listing).
  SW_ACCT=$(kubectl exec -n mail "$STALWART_POD" -c stalwart -- curl -s -u "admin:${SW_ADMIN_PW}" \
    http://localhost:8080/jmap/session 2>/dev/null \
    | python3 -c "import json,sys;print(list(json.load(sys.stdin)['accounts'].keys())[0])")
  SW_ACCOUNTS=$(swjmap "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":[[\"x:Account/get\",{\"accountId\":\"$SW_ACCT\",\"ids\":null,\"properties\":[\"id\",\"emailAddress\"]},\"r0\"]]}")
  sw_id_for() { echo "$SW_ACCOUNTS" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next((a['id'] for a in d['methodResponses'][0][1]['list'] if a.get('emailAddress')=='$1'),''))"; }
  SRC_SP=$(sw_id_for "fwd-source@$TEST_DOMAIN")
  TGT_SP=$(sw_id_for "fwd-target@$TEST_DOMAIN")
  SO_SP=$(sw_id_for "no-reply@$TEST_DOMAIN")

  # ── T7: active platform-mail-rules script on the forwarding source ─────
  log "── T7: Sieve script active on fwd-source ──"
  T7=$(swjmap "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:sieve\"],\"methodCalls\":[[\"SieveScript/get\",{\"accountId\":\"$SRC_SP\",\"ids\":null},\"r0\"]]}" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);l=d['methodResponses'][0][1].get('list',[]);print(next((str(s.get('isActive')) for s in l if s.get('name')=='platform-mail-rules'),'missing'))")
  [[ "$T7" == "True" ]] && ok "platform-mail-rules active on fwd-source" \
    || fail "platform-mail-rules on fwd-source: $T7 (expected active)"

  # ── T8: REAL delivery — forward + keep copy; send-only stores nothing ──
  log "── T8: real SMTP delivery through the forwarding path ──"
  kubectl exec -n mail "$STALWART_POD" -c stalwart -- sh -c \
    "printf 'From: probe@ext-$STAMP.invalid\r\nTo: fwd-source@$TEST_DOMAIN\r\nSubject: fwd-probe-$STAMP\r\n\r\nbody\r\n' > /tmp/fwd.eml; curl -s -m 20 --url smtp://localhost:25 --mail-from probe@ext-$STAMP.invalid --mail-rcpt fwd-source@$TEST_DOMAIN --upload-file /tmp/fwd.eml" >/dev/null 2>&1 || true
  kubectl exec -n mail "$STALWART_POD" -c stalwart -- sh -c \
    "printf 'From: probe@ext-$STAMP.invalid\r\nTo: no-reply@$TEST_DOMAIN\r\nSubject: so-probe-$STAMP\r\n\r\nbody\r\n' > /tmp/so.eml; curl -s -m 20 --url smtp://localhost:25 --mail-from probe@ext-$STAMP.invalid --mail-rcpt no-reply@$TEST_DOMAIN --upload-file /tmp/so.eml" >/dev/null 2>&1 || true
  sleep 6
  count_subject() { # count_subject <principal> <subject>
    swjmap "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":[[\"Email/query\",{\"accountId\":\"$1\",\"filter\":{\"subject\":\"$2\"}},\"r0\"]]}" \
      | python3 -c "import json,sys;r=json.load(sys.stdin)['methodResponses'][0][1];print(len(r.get('ids',[])) if 'ids' in r else -1)"
  }
  C_TGT=$(count_subject "$TGT_SP" "fwd-probe-$STAMP")
  C_SRC=$(count_subject "$SRC_SP" "fwd-probe-$STAMP")
  C_SO=$(count_subject "$SO_SP" "so-probe-$STAMP")
  [[ "$C_TGT" == "1" ]] && ok "forward target received the message" \
    || fail "forward target count=$C_TGT (expected 1)"
  [[ "$C_SRC" == "1" ]] && ok "source kept a local copy (redirect :copy)" \
    || fail "source copy count=$C_SRC (expected 1)"
  [[ "$C_SO" == "0" ]] && ok "send-only stored nothing (ereject bounce)" \
    || fail "send-only stored count=$C_SO (expected 0)"
else
  log "── T7/T8 skipped: kubectl cannot reach the mail namespace ──"
fi

# ── T9: clear forwarding ────────────────────────────────────────────────
log "── T9: clear forwarding with [] ──"
T9=$(api PATCH "/tenants/$CID/mailboxes/$SRC_ID" "{\"forwarding_addresses\":[]}")
T9_FWD=$(echo "$T9" | jget "['data']['forwardingAddresses']")
[[ "$T9_FWD" == "None" || -z "$T9_FWD" ]] && ok "forwarding cleared (null)" \
  || fail "forwardingAddresses=$T9_FWD (expected null)"

printf '\n%b== mailbox-forwarding E2E: %d passed, %d failed ==%b\n' "$CYAN" "$passed" "$failed" "$RESET"
[[ "$failed" -eq 0 ]] || exit 1
