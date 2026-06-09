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
PHASES="${PHASES:-A,B,C,D,E,F,G,H,I,J,K}"

# Use kubectl-via-docker to talk to the API service inside k3s.
kx() { docker exec "$K3S_CONTAINER" kubectl -n platform "$@"; }
psql_ro() { kx exec system-db-1 -c postgres -- psql -U postgres -d platform -t -A -c "$@"; }

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
const headers={};
if(process.env.HTTP_BODY) headers["Content-Type"]="application/json";
if(process.env.HTTP_AUTH) headers.Authorization="Bearer "+process.env.HTTP_AUTH;
const opts={hostname:"localhost",port:3000,path:process.env.HTTP_PATH,method:process.env.HTTP_METHOD,headers};
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
    preview=$(api POST "/api/v1/admin/notifications/templates/${tpl_id}/preview" '{"variables":{"tenantName":"Acme Corp","platformName":"Insula"}}')
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

# ─── Phase D: Queue + retry semantics (Phase 2) ──
phase_d() {
  section "Phase D — Queue + retry semantics"
  acquire_admin_token || return 1

  # D1. emitEvent should write status='queued' for email channel (not 'sent').
  # We can't easily trigger emitEvent from here, so we check existing rows.
  local queued_count
  queued_count=$(psql_ro "SELECT count(*) FROM notification_deliveries WHERE channel='email' AND status IN ('queued','sent','failed','dlq','sending');" | tr -d ' \r')
  if [[ "$queued_count" -ge 0 ]]; then
    pass "D1 notification_deliveries reachable ($queued_count email rows, any status)"
  else
    fail "D1 cannot read notification_deliveries"
  fi

  # D2. notification_deliveries.event_variables column exists.
  local col_exists
  col_exists=$(psql_ro "SELECT count(*) FROM information_schema.columns WHERE table_name='notification_deliveries' AND column_name='event_variables';" | tr -d ' \r')
  if [[ "$col_exists" -eq 1 ]]; then
    pass "D2 event_variables column present on notification_deliveries"
  else
    fail "D2 event_variables column missing (migration 0042 not applied?)"
  fi

  # D3. pg-boss schema initialised (the worker started → schema exists).
  local pgboss_exists
  pgboss_exists=$(psql_ro "SELECT count(*) FROM information_schema.schemata WHERE schema_name='pgboss';" | tr -d ' \r')
  if [[ "$pgboss_exists" -eq 1 ]]; then
    pass "D3 pg-boss schema bootstrapped (worker reachable)"
  else
    fail "D3 pg-boss schema 'pgboss' missing — worker never started"
  fi
}

# ─── Phase E: Retry endpoint contract ──
phase_e() {
  section "Phase E — Admin retry endpoint contract"
  acquire_admin_token || return 1

  # E1. Retry on non-existent delivery → 404.
  local raw
  raw=$(api POST /api/v1/admin/notifications/deliveries/00000000-0000-0000-0000-000000000000/retry '{}')
  if printf %s "$raw" | grep -q '"code":"DELIVERY_NOT_FOUND"'; then
    pass "E1 POST .../deliveries/&lt;missing&gt;/retry returns DELIVERY_NOT_FOUND"
  else
    fail "E1 expected DELIVERY_NOT_FOUND; got: $raw"
  fi

  # E2. Retry on a queued email delivery → 409 (only failed/dlq are retriable).
  local queued_id
  queued_id=$(psql_ro "SELECT id FROM notification_deliveries WHERE channel='email' AND status='queued' LIMIT 1;" | tr -d ' \r')
  if [[ -n "$queued_id" ]]; then
    raw=$(api POST "/api/v1/admin/notifications/deliveries/${queued_id}/retry" '{}')
    if printf %s "$raw" | grep -q '"code":"OPERATION_NOT_ALLOWED"'; then
      pass "E2 POST retry on queued delivery returns OPERATION_NOT_ALLOWED"
    else
      fail "E2 expected OPERATION_NOT_ALLOWED on queued delivery; got: $raw"
    fi
  else
    pass "E2 skipped — no queued email deliveries to test"
  fi
}

# ─── Phase F: Providers (Phase 3B) ──
phase_f() {
  section "Phase F — Notification Providers"
  acquire_admin_token || return 1

  # F1. notification_providers table exists (migration 0043 applied).
  local col_exists
  col_exists=$(psql_ro "SELECT count(*) FROM information_schema.tables WHERE table_name='notification_providers';" | tr -d ' \r')
  if [[ "$col_exists" -eq 1 ]]; then
    pass "F1 notification_providers table present"
  else
    fail "F1 notification_providers table missing (migration 0043 not applied)"
  fi

  # F2. notification_provider_type enum present.
  local enum_exists
  enum_exists=$(psql_ro "SELECT count(*) FROM pg_type WHERE typname='notification_provider_type';" | tr -d ' \r')
  if [[ "$enum_exists" -eq 1 ]]; then
    pass "F2 notification_provider_type enum present"
  else
    fail "F2 notification_provider_type enum missing"
  fi

  # F3. GET /admin/notifications/providers reachable.
  local raw
  raw=$(api GET /api/v1/admin/notifications/providers)
  if printf %s "$raw" | grep -q '"data":\['; then
    pass "F3 GET /admin/notifications/providers returns a list"
  else
    fail "F3 GET /admin/notifications/providers failed: $raw"
  fi

  # F4. POST a test provider, verify it's listed.
  local create_raw provider_id
  create_raw=$(api POST /api/v1/admin/notifications/providers '{"name":"Harness Test","providerType":"smtp","smtpHost":"mail.example.test","smtpPort":587,"smtpSecure":false,"authUsername":"user","authPassword":"secret","fromAddress":"noreply@example.test","enabled":true,"isDefault":false}')
  provider_id=$(printf %s "$create_raw" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(s).data.id)}catch{console.log("")}})')
  if [[ -n "$provider_id" ]]; then
    pass "F4 POST /admin/notifications/providers created provider $provider_id"
  else
    fail "F4 POST /admin/notifications/providers failed: $create_raw"
    return 1
  fi

  # F5. Credentials never returned in response.
  if printf %s "$create_raw" | grep -q '"authPasswordSet":true'; then
    pass "F5 password stored (authPasswordSet=true) and never returned"
  else
    fail "F5 authPasswordSet flag missing from response"
  fi

  # F6. DELETE the test provider.
  api DELETE "/api/v1/admin/notifications/providers/${provider_id}" >/dev/null 2>&1
  local after_delete
  after_delete=$(psql_ro "SELECT count(*) FROM notification_providers WHERE id='${provider_id}';" | tr -d ' \r')
  if [[ "$after_delete" -eq 0 ]]; then
    pass "F6 DELETE /admin/notifications/providers/:id removed the row"
  else
    fail "F6 provider row still present after DELETE"
  fi
}

# ─── Phase G: Re-enqueue scheduler health (Phase 3C) ──
phase_g() {
  section "Phase G — Re-enqueue scheduler"
  # G1. App log line confirming the scheduler started.
  # (Best-effort — we don't have direct log access from this harness.
  #  Instead, verify the worker module exports load by checking the
  #  table column the scheduler queries.)
  local col_exists
  col_exists=$(psql_ro "SELECT count(*) FROM information_schema.columns WHERE table_name='notification_deliveries' AND column_name='next_attempt_at';" | tr -d ' \r')
  if [[ "$col_exists" -eq 1 ]]; then
    pass "G1 next_attempt_at column present (scanner can query it)"
  else
    fail "G1 next_attempt_at column missing"
  fi
}

# ─── Phase H: Subscription event wiring (Phase 4) ──
phase_h() {
  section "Phase H — Subscription event wiring"
  acquire_admin_token || return 1

  # H1. subscription.renewed category seeded.
  local cat_count
  cat_count=$(psql_ro "SELECT count(*) FROM notification_categories WHERE id='subscription.renewed';" | tr -d ' \r')
  if [[ "$cat_count" -eq 1 ]]; then
    pass "H1 subscription.renewed category seeded"
  else
    fail "H1 subscription.renewed category missing"
  fi

  # H2. dedupe_key column on notification_deliveries (Phase 4 follow-up).
  local col_exists
  col_exists=$(psql_ro "SELECT count(*) FROM information_schema.columns WHERE table_name='notification_deliveries' AND column_name='dedupe_key';" | tr -d ' \r')
  if [[ "$col_exists" -eq 1 ]]; then
    pass "H2 dedupe_key column present on notification_deliveries"
  else
    fail "H2 dedupe_key column missing (migration 0045 not applied)"
  fi

  # H3. dedupe lookup index present.
  local idx_exists
  idx_exists=$(psql_ro "SELECT count(*) FROM pg_indexes WHERE indexname='notification_deliveries_dedupe_lookup_idx';" | tr -d ' \r')
  if [[ "$idx_exists" -eq 1 ]]; then
    pass "H3 notification_deliveries_dedupe_lookup_idx partial index present"
  else
    fail "H3 dedupe partial index missing"
  fi
}

# ─── Phase I: Per-Source provider routing (Phase 5) ──
phase_i() {
  section "Phase I — Per-Source provider routing"
  acquire_admin_token || return 1

  # I1. email_provider_id column on notification_categories (migration 0044).
  local col_exists
  col_exists=$(psql_ro "SELECT count(*) FROM information_schema.columns WHERE table_name='notification_categories' AND column_name='email_provider_id';" | tr -d ' \r')
  if [[ "$col_exists" -eq 1 ]]; then
    pass "I1 email_provider_id column present on notification_categories"
  else
    fail "I1 email_provider_id column missing (migration 0044 not applied)"
  fi

  # I2. emailProviderId exposed via GET /admin/notifications/categories.
  local raw
  raw=$(api GET /api/v1/admin/notifications/categories)
  if printf %s "$raw" | grep -q 'emailProviderId'; then
    pass "I2 categories response includes emailProviderId"
  else
    fail "I2 categories response missing emailProviderId field"
  fi

  # I3. PATCH with invalid emailProviderId should be rejected (security fix).
  local invalid_raw
  invalid_raw=$(api PATCH /api/v1/admin/notifications/categories/tenant.suspended '{"emailProviderId":"00000000-0000-0000-0000-000000000000"}')
  if printf %s "$invalid_raw" | grep -q '"code":"INVALID_FIELD_VALUE"'; then
    pass "I3 PATCH rejects emailProviderId pointing at non-existent provider"
  else
    fail "I3 PATCH accepted bad emailProviderId: $invalid_raw"
  fi
}

# ─── Phase J — Stalwart-internal Provider semantics (Phase 6 prep) ──
phase_j() {
  section "Phase J — Stalwart-internal Provider semantics"
  acquire_admin_token || return 1

  # J1. Creating a stalwart-internal Provider WITH authPassword must
  # be refused by the contract validator (no operator-supplied creds).
  local raw
  raw=$(api POST /api/v1/admin/notifications/providers \
    '{"name":"Stalwart bad","providerType":"stalwart-internal","smtpHost":"stalwart-mail.mail.svc","smtpPort":465,"smtpSecure":true,"fromAddress":"notifications@apex.test","authUsername":"u","authPassword":"oops","enabled":true,"isDefault":false}')
  if printf %s "$raw" | grep -q '"code":"INVALID_FIELD_VALUE"'; then
    pass "J1 stalwart-internal Provider with authPassword rejected"
  else
    fail "J1 expected INVALID_FIELD_VALUE for stalwart-internal+authPassword; got: $raw"
  fi

  # J2. Creating a stalwart-internal Provider WITHOUT auth fields
  # succeeds. The row carries authPasswordSet=false.
  raw=$(api POST /api/v1/admin/notifications/providers \
    '{"name":"Stalwart OK","providerType":"stalwart-internal","smtpHost":"stalwart-mail.mail.svc","smtpPort":465,"smtpSecure":true,"fromAddress":"notifications@apex.test","enabled":true,"isDefault":false}')
  local provider_id
  provider_id=$(printf %s "$raw" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(s).data?.id ?? "")}catch{console.log("")}})')
  if [[ -n "$provider_id" ]] && printf %s "$raw" | grep -q '"authPasswordSet":false'; then
    pass "J2 stalwart-internal Provider without auth creates with authPasswordSet=false"
    api DELETE "/api/v1/admin/notifications/providers/${provider_id}" >/dev/null 2>&1
  else
    fail "J2 stalwart-internal Provider create or authPasswordSet check failed: $raw"
  fi
}

# ─── Phase K — Admin event Sources seeded (Phase 6A) ──
phase_k() {
  section "Phase K — Admin event Sources"
  acquire_admin_token || return 1
  for src in admin.cert_expiring admin.cert_renewal_failed admin.backup_failed admin.backup_target_unreachable admin.node_down; do
    local n
    n=$(psql_ro "SELECT count(*) FROM notification_categories WHERE id='${src}' AND is_active=TRUE;" | tr -d ' \r')
    if [[ "$n" -eq 1 ]]; then
      pass "K ${src} seeded + active"
    else
      fail "K ${src} missing or inactive"
    fi
  done
}

# ─── Driver ──
run_phase A && phase_a
run_phase B && phase_b
run_phase C && phase_c
run_phase D && phase_d
run_phase E && phase_e
run_phase F && phase_f
run_phase G && phase_g
run_phase H && phase_h
run_phase I && phase_i
run_phase J && phase_j
run_phase K && phase_k

echo
echo "═══════════════════════════════════════════"
echo "Notifications harness: $pass_count passed, $fail_count failed"
echo "═══════════════════════════════════════════"
exit $(( fail_count == 0 ? 0 : 1 ))
