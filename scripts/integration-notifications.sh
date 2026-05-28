#!/usr/bin/env bash
# integration-notifications.sh — E2E harness for the notification
# system (Phase 1).
#
# Phases:
#   A — Boot health
#     A1. notification_categories table populated (≥22 rows seeded)
#     A2. notification_templates table populated for every (category,
#         channel) pair the seed declares
#     A3. notifications module advertises Stalwart-internal SMTP relay
#         (smtp_relay_configs row with provider_type='stalwart-internal'
#         and from_address='notifications@<apex>')
#
#   B — Admin API
#     B1. GET /api/v1/admin/notifications/categories returns ≥22
#     B2. GET /api/v1/admin/notifications/templates returns multiple
#     B3. POST /api/v1/admin/notifications/templates/<id>/preview
#         returns rendered subject + body
#     B4. PATCH /api/v1/admin/notifications/categories/<id> records
#         audit_logs row with resource_type='notification_category'
#
#   C — Tenant API
#     C1. GET /api/v1/notifications/preferences returns the full matrix
#         (every active category × every channel) with isMandatory flag
#     C2. PATCH /api/v1/notifications/preferences accepts toggle for a
#         non-mandatory category and rejects implicit changes on
#         mandatory categories (return preserved as 'enabled=true')
#     C3. GET + PATCH /api/v1/notifications/settings round-trips
#
#   D — Dispatcher integration
#     D1. emitEvent({categoryId='security.password_changed', scope=user})
#         writes a notifications row AND a notification_deliveries row
#         AND respects mandatory bypass for both in_app + email
#     D2. emitEvent for a non-mandatory category with user opt-out
#         writes a 'muted' delivery row, no notifications row
#     D3. emitEvent throws when PLATFORM_ENCRYPTION_KEY is missing
#
#   E — Lifecycle hook
#     E1. Triggering tenant.suspended on a test tenant emits the
#         notification (delivery row written, in_app row written)
#     E2. Triggering tenant.suspended with suppressTenantNotification
#         writes NO delivery rows (admin override)
#
#   F — GDPR erasure
#     F1. DELETE /api/v1/admin/users/:id removes the user's notifications
#         AND notification_deliveries rows atomically
#
# Usage:
#   ./scripts/integration-notifications.sh                # all phases
#   ./scripts/integration-notifications.sh --phase A,B    # subset
#
# Environment:
#   API_BASE          — platform-api root URL (default: http://platform-api.platform.svc:3000)
#   ADMIN_TOKEN       — super_admin JWT (auto-acquired if ADMIN_EMAIL + ADMIN_PASSWORD set)
#   ADMIN_EMAIL       — default: admin@k8s-platform.test
#   ADMIN_PASSWORD    — default: admin
#   K3S_CONTAINER     — Docker container name running k3s (default: hosting-platform-k3s-server-1)

set -euo pipefail

K3S_CONTAINER="${K3S_CONTAINER:-hosting-platform-k3s-server-1}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@k8s-platform.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
PHASES="${PHASES:-A,B,C,D,E,F}"

# Use kubectl-via-docker to talk to the API service inside k3s.
kx() { docker exec "$K3S_CONTAINER" kubectl -n platform "$@"; }
psql_ro() { kx exec system-db-1 -c postgres -- psql -U postgres -d hosting_platform -t -A -c "$@"; }

pass_count=0
fail_count=0

pass() { echo "  ✓ $1"; ((pass_count++)) || true; }
fail() { echo "  ✗ $1" >&2; ((fail_count++)) || true; }
section() { echo; echo "── $1 ──"; }

run_phase() {
  local phase="$1"
  [[ ",${PHASES}," == *",${phase},"* ]]
}

# ─── Acquire admin token via platform-api login (executed in-cluster) ──
# Node-based HTTP wrapper run inside the platform-api pod. curl isn't
# installed in the Alpine image but Node is. Pass the body through env to
# avoid shell-escaping headaches.
_node_http() {
  local method="$1" path="$2" auth="$3" body="${4:-}"
  kx exec deploy/platform-api -- env \
    HTTP_METHOD="$method" HTTP_PATH="$path" HTTP_AUTH="$auth" HTTP_BODY="$body" \
    node -e '
const http=require("http");
const opts={hostname:"localhost",port:3000,path:process.env.HTTP_PATH,method:process.env.HTTP_METHOD,headers:{"Content-Type":"application/json"}};
if(process.env.HTTP_AUTH) opts.headers.Authorization="Bearer "+process.env.HTTP_AUTH;
const r=http.request(opts,res=>{let s="";res.on("data",c=>s+=c);res.on("end",()=>process.stdout.write(s))});
r.on("error",e=>{process.stderr.write(String(e));process.exit(1)});
if(process.env.HTTP_BODY) r.write(process.env.HTTP_BODY);
r.end();
'
}

acquire_admin_token() {
  if [[ -n "${ADMIN_TOKEN:-}" ]]; then
    return 0
  fi
  local raw
  raw=$(_node_http POST /api/v1/auth/login '' "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}")
  ADMIN_TOKEN=$(printf %s "$raw" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(s).data.token)}catch{console.log("")}})')
  if [[ -z "$ADMIN_TOKEN" ]]; then
    fail "could not acquire admin token (email=${ADMIN_EMAIL}): $raw"
    return 1
  fi
}

api() {
  local method="$1" path="$2" body="${3:-}"
  _node_http "$method" "$path" "$ADMIN_TOKEN" "$body"
}

# ─── Phase A: Boot health ──
phase_a() {
  section "Phase A — Boot health"
  local cat_count
  cat_count=$(psql_ro "SELECT count(*) FROM notification_categories WHERE is_active = TRUE;" | tr -d ' \r')
  if [[ "$cat_count" -ge 22 ]]; then
    pass "A1 notification_categories has $cat_count active rows (≥22)"
  else
    fail "A1 notification_categories has only $cat_count active rows (expected ≥22)"
  fi

  local tpl_count
  tpl_count=$(psql_ro "SELECT count(*) FROM notification_templates WHERE is_active = TRUE;" | tr -d ' \r')
  if [[ "$tpl_count" -ge 30 ]]; then
    pass "A2 notification_templates has $tpl_count active rows (≥30)"
  else
    fail "A2 notification_templates has only $tpl_count active rows"
  fi

  local relay_count
  relay_count=$(psql_ro "SELECT count(*) FROM smtp_relay_configs WHERE \"providerType\" = 'stalwart-internal' AND from_address LIKE 'notifications@%';" | tr -d ' \r')
  if [[ "$relay_count" -ge 1 ]]; then
    pass "A3 stalwart-internal SMTP relay provisioned (from=notifications@<apex>)"
  else
    fail "A3 stalwart-internal SMTP relay missing"
  fi
}

# ─── Phase B: Admin API ──
phase_b() {
  section "Phase B — Admin API"
  acquire_admin_token || return 1

  local raw n
  raw=$(api GET /api/v1/admin/notifications/categories)
  n=$(printf %s "$raw" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(s).data.length)}catch{console.log(0)}})')
  if [[ "$n" -ge 22 ]]; then
    pass "B1 GET /admin/notifications/categories returned $n entries"
  else
    fail "B1 GET /admin/notifications/categories returned $n entries (expected ≥22)"
  fi

  raw=$(api GET /api/v1/admin/notifications/templates)
  n=$(printf %s "$raw" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(s).data.length)}catch{console.log(0)}})')
  if [[ "$n" -ge 30 ]]; then
    pass "B2 GET /admin/notifications/templates returned $n entries"
  else
    fail "B2 GET /admin/notifications/templates returned $n entries"
  fi

  # Pick the in_app template for tenant.suspended and call preview
  local tpl_id
  tpl_id=$(psql_ro "SELECT id FROM notification_templates WHERE category_id='tenant.suspended' AND channel='in_app' AND is_active=TRUE LIMIT 1;" | tr -d ' \r')
  if [[ -n "$tpl_id" ]]; then
    local preview
    preview=$(api POST "/api/v1/admin/notifications/templates/${tpl_id}/preview" '{"variables":{"tenantName":"Acme Corp","platformName":"Phoenix"}}')
    if printf %s "$preview" | grep -q '"body"'; then
      pass "B3 preview endpoint rendered template"
    else
      fail "B3 preview endpoint returned no body: $preview"
    fi
  else
    fail "B3 no tenant.suspended/in_app template available to preview"
  fi

  local before_count
  before_count=$(psql_ro "SELECT count(*) FROM audit_logs WHERE resource_type='notification_category';" | tr -d ' \r')
  api PATCH /api/v1/admin/notifications/categories/tasks.scheduled_failure '{"defaultChannels":["in_app","email"]}' >/dev/null
  local after_count
  after_count=$(psql_ro "SELECT count(*) FROM audit_logs WHERE resource_type='notification_category';" | tr -d ' \r')
  if [[ "$after_count" -gt "$before_count" ]]; then
    pass "B4 PATCH /categories/:id wrote audit_logs entry"
  else
    fail "B4 PATCH /categories/:id did not write audit_logs ($before_count → $after_count)"
  fi
}

# ─── Phase C: Tenant/user API ──
phase_c() {
  section "Phase C — Tenant/user API"
  acquire_admin_token || return 1

  local raw n
  raw=$(api GET /api/v1/notifications/preferences)
  n=$(printf %s "$raw" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const d=JSON.parse(s).data;console.log(d.preferences.length+":"+d.preferences.filter(p=>p.isMandatory).length)}catch{console.log("0:0")}})')
  local total mandatory
  total="${n%:*}"; mandatory="${n##*:}"
  if [[ "$total" -ge 30 && "$mandatory" -ge 4 ]]; then
    pass "C1 preferences matrix has $total entries ($mandatory mandatory)"
  else
    fail "C1 preferences matrix: total=$total mandatory=$mandatory"
  fi

  # Toggle a non-mandatory category. tasks.scheduled_failure is non-mandatory.
  api PATCH /api/v1/notifications/preferences '{"updates":[{"categoryId":"tasks.scheduled_failure","channel":"email","enabled":false}]}' >/dev/null
  local stored
  stored=$(psql_ro "SELECT enabled FROM user_notification_preferences WHERE category_id='tasks.scheduled_failure' AND channel='email' LIMIT 1;" | tr -d ' \r')
  if [[ "$stored" == "f" ]]; then
    pass "C2 non-mandatory category opt-out persisted (enabled=false)"
  else
    fail "C2 expected stored=false, got stored=$stored"
  fi

  # PATCH on a mandatory category SHOULD still persist a row but the
  # GET response keeps enabled=true (gate enforces). Verify GET semantics.
  api PATCH /api/v1/notifications/preferences '{"updates":[{"categoryId":"security.password_changed","channel":"email","enabled":false}]}' >/dev/null
  raw=$(api GET /api/v1/notifications/preferences)
  local mandatory_check
  mandatory_check=$(printf %s "$raw" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const p=JSON.parse(s).data.preferences.find(x=>x.categoryId=="security.password_changed"&&x.channel=="email");console.log(p?p.enabled:"missing")}catch{console.log("error")}})')
  if [[ "$mandatory_check" == "true" ]]; then
    pass "C2 mandatory category still reports enabled=true via GET (gate active)"
  else
    fail "C2 mandatory category enabled mis-reported: $mandatory_check"
  fi

  # Settings round-trip
  api PATCH /api/v1/notifications/settings '{"quietHoursStart":"22:00","quietHoursEnd":"07:00","digestMode":"immediate"}' >/dev/null
  raw=$(api GET /api/v1/notifications/settings)
  if printf %s "$raw" | grep -q '"quietHoursStart":"22:00"'; then
    pass "C3 settings round-trip preserves quiet hours"
  else
    fail "C3 settings round-trip failed: $raw"
  fi
}

# ─── Phase D + E + F: deferred — require fixture data not present in default cluster
#       D needs a script in the API pod (out of scope for this harness)
#       E needs a test tenant set up
#       F needs a test user; cannot delete admin@ self
# Implementing only A-C in V1; D-F deferred.

# ─── Driver ──
run_phase A && phase_a
run_phase B && phase_b
run_phase C && phase_c

echo
echo "═══════════════════════════════════════════"
echo "Notifications harness: $pass_count passed, $fail_count failed"
echo "═══════════════════════════════════════════"
exit $(( fail_count == 0 ? 0 : 1 ))
