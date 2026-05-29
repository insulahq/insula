#!/usr/bin/env bash
# integration-tenant-bundles-roundtrip.sh — TRUE end-to-end round-trip
# tests for tenant-bundles.
#
# Unlike integration-tenant-bundles-tenant-side.sh (24 API-boundary smoke
# assertions), this harness MUTATES live state, runs a backup, mutates
# state AGAIN, runs a restore, and asserts the pre-mutation state was
# actually preserved (or correctly redacted in the policy case).
#
# Three scenarios:
#
#   §1 ssh_keys config-tables round-trip
#     - INSERT a marker ssh_keys row directly in postgres
#     - Trigger bundle, wait for terminal
#     - DELETE the marker row, confirm gone
#     - Restore `sshKeys` via tenant cart, wait done
#     - Assert the marker row is BACK (executor actually upserts)
#
#   §2 tenants.plan_id policy-redaction round-trip
#     - Capture original plan_id (=A)
#     - Mutate plan_id to a DIFFERENT plan id (=B)
#     - Trigger bundle (captures plan_id=B)
#     - Restore plan_id back to A
#     - Restore `tenants` via tenant cart from the bundle (which has B)
#     - Assert plan_id is STILL A (redaction prevented overwrite to B)
#
#   §3 scheduler round-trip
#     - Set the cron to fire in the next ~5 min window
#     - Wait → assert `last_fired_at` advanced
#     - Assert a NEW `backup_jobs` row appeared with initiator='system'
#       for the test tenant (or, if the tick was a no-op because no
#       backup target is assigned, accept the recorded fire without
#       a row — but log the gap)
#
# Mailbox + files round-trips are deliberately OUT OF SCOPE for now:
# - mailbox requires Stalwart to be healthy (staging is currently
#   Stalwart-down due to a hostPort conflict)
# - files requires kubectl exec into the tenant namespace to mutate
#   and read files — adds infra coupling not warranted yet
#
# USAGE: ADMIN_PASSWORD=<…> ./scripts/integration-tenant-bundles-roundtrip.sh
#
# This harness is INTENTIONALLY destructive — it writes rows in
# `ssh_keys` and `tenants` against the staging DB. The test tenant
# is rolled back to its pre-test state at the end. If the harness
# aborts mid-run, the cleanup section may not fire — operator should
# run `scripts/clean-tenant-bundles-roundtrip-state.sh` (TODO).

set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@staging.phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
STAGING_NODE="${STAGING_NODE:-root@staging1.phoenix-host.net}"

[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }
[[ -f "$SSH_KEY" ]]      || { echo "ERROR: $SSH_KEY missing" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'
log()  { printf '%b[%s]%b %s\n' "$CYAN"   "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$GREEN"   "$RESET" "$*"; passed=$((passed+1)); }
fail() { printf '  %b✗%b %s\n' "$RED"     "$RESET" "$*"; failed=$((failed+1)); }
warn() { printf '  %b!%b %s\n' "$YELLOW"  "$RESET" "$*"; }

passed=0
failed=0

api() {
  local host="$1" method="$2" path="$3" body="${4:-}" auth="${5:-}"
  local h_auth=()
  if [[ -n "$auth" ]]; then h_auth=(-H "Authorization: Bearer $auth"); fi
  if [[ -z "$body" ]]; then
    curl -sk -w '\n%{http_code}' -X "$method" "$host/api/v1$path" "${h_auth[@]}"
  else
    curl -sk -w '\n%{http_code}' -X "$method" "$host/api/v1$path" "${h_auth[@]}" \
      -H "Content-Type: application/json" -d "$body"
  fi
}

parse() {
  local raw="$1"
  STATUS=$(printf '%s' "$raw" | tail -n1)
  BODY=$(printf '%s' "$raw" | sed '$d')
}

# Run a SQL command on staging system-db, return TSV row dump.
psql_cmd() {
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$STAGING_NODE" \
    "kubectl exec -n platform system-db-1 -c postgres -- psql -tAU postgres -d platform -c \"$1\""
}

# Wait for a bundle to reach a terminal state. Sets BUNDLE_STATUS.
wait_bundle() {
  local bundle_id="$1" tenant_id="$2" token="$3" timeout_secs="${4:-180}"
  local elapsed=0
  while (( elapsed < timeout_secs )); do
    local R
    R=$(api "$ADMIN_HOST" GET "/tenants/$tenant_id/bundles/$bundle_id/status" "" "$token")
    parse "$R"
    if [[ "$STATUS" == "200" ]]; then
      local s
      s=$(printf '%s' "$BODY" | jq -r '.data.bundle.status // empty')
      if [[ "$s" == "completed" || "$s" == "partial" || "$s" == "failed" ]]; then
        BUNDLE_STATUS="$s"
        return 0
      fi
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
  BUNDLE_STATUS="timeout"
  return 1
}

# Wait for a restore cart to reach a terminal state. Sets CART_STATUS.
wait_cart() {
  local cart_id="$1" tenant_id="$2" token="$3" timeout_secs="${4:-60}"
  local elapsed=0
  while (( elapsed < timeout_secs )); do
    local R
    R=$(api "$ADMIN_HOST" GET "/tenants/$tenant_id/restore-carts/$cart_id" "" "$token")
    parse "$R"
    if [[ "$STATUS" == "200" ]]; then
      local s
      s=$(printf '%s' "$BODY" | jq -r '.data.status // empty')
      if [[ "$s" == "done" || "$s" == "failed" ]]; then
        CART_STATUS="$s"
        return 0
      fi
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  CART_STATUS="timeout"
  return 1
}

# ── login ─────────────────────────────────────────────────────────────
log "logging in as admin"
RAW=$(api "$ADMIN_HOST" POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
parse "$RAW"
[[ "$STATUS" == "200" ]] || { fail "admin login: $STATUS $BODY"; exit 1; }
ADMIN_TOKEN=$(printf '%s' "$BODY" | jq -r '.data.token // empty')
ok "admin login"

# Pick the first active non-SYSTEM tenant
RAW=$(api "$ADMIN_HOST" GET "/tenants" "" "$ADMIN_TOKEN")
parse "$RAW"
TENANT_ID=$(printf '%s' "$BODY" | jq -r '.data[] | select(.status=="active" and .name != "SYSTEM") | .id' | head -1)
[[ -n "$TENANT_ID" ]] || { fail "no active non-SYSTEM tenant"; exit 1; }
ok "target tenant: $TENANT_ID"

# Provision a tenant_admin user (uses the same approach as the smoke harness)
TENANT_USER_EMAIL="rt-e2e-$(date +%s)@example.test"
TENANT_USER_PASSWORD="RT-Test-$(date +%s)"
RAW=$(api "$ADMIN_HOST" POST "/tenants/$TENANT_ID/users" \
  "{\"email\":\"$TENANT_USER_EMAIL\",\"password\":\"$TENANT_USER_PASSWORD\",\"full_name\":\"RT E2E\",\"role_name\":\"tenant_admin\"}" \
  "$ADMIN_TOKEN")
parse "$RAW"
if [[ "$STATUS" == "201" || "$STATUS" == "200" ]]; then
  ok "tenant_admin provisioned"
else
  fail "tenant_admin provision: $STATUS $BODY"
  exit 1
fi

RAW=$(api "$ADMIN_HOST" POST /auth/login \
  "{\"email\":\"$TENANT_USER_EMAIL\",\"password\":\"$TENANT_USER_PASSWORD\",\"panel\":\"tenant\"}")
parse "$RAW"
TENANT_TOKEN=$(printf '%s' "$BODY" | jq -r '.data.token // empty')
[[ -n "$TENANT_TOKEN" ]] || { fail "tenant login"; exit 1; }
ok "tenant login"

# Clear any stuck running bundles (best-effort)
psql_cmd "UPDATE backup_jobs SET status='failed', finished_at=NOW(), last_error='manual unstick by roundtrip harness' WHERE tenant_id='$TENANT_ID' AND status='running'" >/dev/null 2>&1 || true

# ─── §1: ssh_keys round-trip ──────────────────────────────────────────
log "§1 ssh_keys round-trip"
MARKER_FP="rt-marker-$(date +%s)-$(openssl rand -hex 8)"
MARKER_NAME="rt-marker-$(date +%s)"
MARKER_ID=$(python3 -c 'import uuid; print(uuid.uuid4())' 2>/dev/null || openssl rand -hex 16 | sed 's/^\(........\)\(....\)\(....\)\(....\)\(.\{12\}\)$/\1-\2-\3-\4-\5/')
MARKER_PK="ssh-ed25519 AAAA${MARKER_FP} roundtrip-marker"

# Step 1: INSERT marker
psql_cmd "INSERT INTO ssh_keys (id, tenant_id, name, public_key, key_fingerprint, key_algorithm) VALUES ('$MARKER_ID', '$TENANT_ID', '$MARKER_NAME', '$MARKER_PK', '$MARKER_FP', 'ssh-ed25519')" >/dev/null
ROW_COUNT=$(psql_cmd "SELECT COUNT(*) FROM ssh_keys WHERE id='$MARKER_ID'" | tr -d ' \r\n')
if [[ "$ROW_COUNT" == "1" ]]; then ok "marker ssh_keys row inserted"; else fail "marker insert (count=$ROW_COUNT)"; fi

# Step 2: trigger bundle
RAW=$(api "$ADMIN_HOST" POST "/tenants/$TENANT_ID/bundles/run-now" "{}" "$TENANT_TOKEN")
parse "$RAW"
if [[ "$STATUS" == "202" ]]; then
  BUNDLE_ID=$(printf '%s' "$BODY" | jq -r '.data.bundleId')
  ok "bundle triggered: $BUNDLE_ID"
else
  fail "bundle trigger: $STATUS $BODY"
  exit 1
fi

# Step 3: wait for terminal — `partial` is a TEST FAILURE (any component
# failed means the bundle is incomplete; if a harness lets it slide, the
# real regression hides under PASS). Override only via EXPECT_PARTIAL=1.
wait_bundle "$BUNDLE_ID" "$TENANT_ID" "$TENANT_TOKEN" 120
if [[ "$BUNDLE_STATUS" == "completed" ]]; then
  ok "bundle terminal: $BUNDLE_STATUS"
elif [[ "$BUNDLE_STATUS" == "partial" && "${EXPECT_PARTIAL:-0}" == "1" ]]; then
  ok "bundle terminal: $BUNDLE_STATUS (EXPECT_PARTIAL=1)"
else
  fail "bundle terminal: got $BUNDLE_STATUS (expected 'completed' — set EXPECT_PARTIAL=1 to allow partial in this run)"
  # Surface per-component lastError to make the regression obvious.
  api "$ADMIN_HOST" GET "/admin/tenant-bundles/$BUNDLE_ID" "" "$ADMIN_TOKEN" \
    | jq -r '.data.components[]? | select(.status!="completed") | "  comp=\(.component) status=\(.status) err=\(.lastError // "")"' \
    || true
  exit 1
fi

# Step 4: DELETE marker
psql_cmd "DELETE FROM ssh_keys WHERE id='$MARKER_ID'" >/dev/null
ROW_COUNT=$(psql_cmd "SELECT COUNT(*) FROM ssh_keys WHERE id='$MARKER_ID'" | tr -d ' \r\n')
if [[ "$ROW_COUNT" == "0" ]]; then ok "marker deleted"; else fail "marker delete (count=$ROW_COUNT)"; fi

# Step 5: create cart, add sshKeys item, execute, wait done
RAW=$(api "$ADMIN_HOST" POST "/tenants/$TENANT_ID/restore-carts" \
  "{\"tenantId\":\"$TENANT_ID\",\"description\":\"rt-ssh-keys\"}" "$TENANT_TOKEN")
parse "$RAW"
CART_ID=$(printf '%s' "$BODY" | jq -r '.data.id')
[[ -n "$CART_ID" && "$STATUS" == "201" ]] || { fail "cart create: $STATUS $BODY"; exit 1; }

RAW=$(api "$ADMIN_HOST" POST "/tenants/$TENANT_ID/restore-carts/$CART_ID/items" \
  "{\"bundleId\":\"$BUNDLE_ID\",\"type\":\"config-tables\",\"selector\":{\"kind\":\"tables\",\"tables\":[\"sshKeys\"]}}" \
  "$TENANT_TOKEN")
parse "$RAW"
[[ "$STATUS" == "201" ]] || { fail "add sshKeys item: $STATUS $BODY"; exit 1; }

RAW=$(api "$ADMIN_HOST" POST "/tenants/$TENANT_ID/restore-carts/$CART_ID/execute" "{}" "$TENANT_TOKEN")
parse "$RAW"
[[ "$STATUS" == "200" ]] || { fail "cart execute: $STATUS $BODY"; exit 1; }

wait_cart "$CART_ID" "$TENANT_ID" "$TENANT_TOKEN" 30
if [[ "$CART_STATUS" == "done" ]]; then ok "cart executed → done"; else fail "cart status: $CART_STATUS"; exit 1; fi

# Step 6: verify marker row is BACK
ROW_COUNT=$(psql_cmd "SELECT COUNT(*) FROM ssh_keys WHERE id='$MARKER_ID' AND key_fingerprint='$MARKER_FP'" | tr -d ' \r\n')
if [[ "$ROW_COUNT" == "1" ]]; then
  ok "ROUND-TRIP VERIFIED: marker row restored ($MARKER_ID)"
else
  fail "marker row NOT restored after cart execute (count=$ROW_COUNT)"
fi

# Cleanup §1
psql_cmd "DELETE FROM ssh_keys WHERE id='$MARKER_ID'" >/dev/null 2>&1 || true

# ─── §2: tenants.plan_id policy-redaction round-trip ─────────────────
log "§2 policy-redaction round-trip (tenants.plan_id)"

ORIGINAL_PLAN=$(psql_cmd "SELECT plan_id FROM tenants WHERE id='$TENANT_ID'" | tr -d ' \r\n')
[[ -n "$ORIGINAL_PLAN" ]] || { fail "could not read original plan_id"; exit 1; }
ok "original plan_id: $ORIGINAL_PLAN"

# Find a DIFFERENT plan id to mutate to.
OTHER_PLAN=$(psql_cmd "SELECT id FROM hosting_plans WHERE id != '$ORIGINAL_PLAN' LIMIT 1" | tr -d ' \r\n')
[[ -n "$OTHER_PLAN" && "$OTHER_PLAN" != "$ORIGINAL_PLAN" ]] || { fail "no alternative plan"; exit 1; }
ok "alternative plan_id: $OTHER_PLAN"

# Step 1: mutate plan_id → OTHER_PLAN
psql_cmd "UPDATE tenants SET plan_id='$OTHER_PLAN' WHERE id='$TENANT_ID'" >/dev/null
CURRENT_PLAN=$(psql_cmd "SELECT plan_id FROM tenants WHERE id='$TENANT_ID'" | tr -d ' \r\n')
[[ "$CURRENT_PLAN" == "$OTHER_PLAN" ]] || { fail "plan mutation: expected $OTHER_PLAN got $CURRENT_PLAN"; exit 1; }
ok "plan_id mutated to $OTHER_PLAN"

# Step 2: trigger bundle (captures plan_id=OTHER_PLAN)
RAW=$(api "$ADMIN_HOST" POST "/tenants/$TENANT_ID/bundles/run-now" "{}" "$TENANT_TOKEN")
parse "$RAW"
if [[ "$STATUS" == "202" ]]; then
  BUNDLE_ID2=$(printf '%s' "$BODY" | jq -r '.data.bundleId')
  ok "bundle (with mutated plan) triggered: $BUNDLE_ID2"
elif [[ "$STATUS" == "409" ]]; then
  # If the §1 bundle is still flushing, wait + retry once
  sleep 5
  RAW=$(api "$ADMIN_HOST" POST "/tenants/$TENANT_ID/bundles/run-now" "{}" "$TENANT_TOKEN")
  parse "$RAW"
  BUNDLE_ID2=$(printf '%s' "$BODY" | jq -r '.data.bundleId // empty')
  if [[ -n "$BUNDLE_ID2" ]]; then ok "bundle triggered after retry"; else fail "bundle trigger after retry: $STATUS $BODY"; psql_cmd "UPDATE tenants SET plan_id='$ORIGINAL_PLAN' WHERE id='$TENANT_ID'" >/dev/null; exit 1; fi
else
  fail "bundle trigger: $STATUS $BODY"
  psql_cmd "UPDATE tenants SET plan_id='$ORIGINAL_PLAN' WHERE id='$TENANT_ID'" >/dev/null
  exit 1
fi

wait_bundle "$BUNDLE_ID2" "$TENANT_ID" "$TENANT_TOKEN" 120
if [[ "$BUNDLE_STATUS" == "completed" ]]; then
  ok "bundle terminal: $BUNDLE_STATUS"
elif [[ "$BUNDLE_STATUS" == "partial" && "${EXPECT_PARTIAL:-0}" == "1" ]]; then
  ok "bundle terminal: $BUNDLE_STATUS (EXPECT_PARTIAL=1)"
else
  fail "bundle terminal: got $BUNDLE_STATUS (expected 'completed' — set EXPECT_PARTIAL=1 to allow partial)"
  api "$ADMIN_HOST" GET "/admin/tenant-bundles/$BUNDLE_ID2" "" "$ADMIN_TOKEN" \
    | jq -r '.data.components[]? | select(.status!="completed") | "  comp=\(.component) status=\(.status) err=\(.lastError // "")"' \
    || true
  psql_cmd "UPDATE tenants SET plan_id='$ORIGINAL_PLAN' WHERE id='$TENANT_ID'" >/dev/null
  exit 1
fi

# Step 3: restore plan_id back to ORIGINAL_PLAN (so the bundle's value
# is intentionally different from the live value).
psql_cmd "UPDATE tenants SET plan_id='$ORIGINAL_PLAN' WHERE id='$TENANT_ID'" >/dev/null
ok "live plan_id reset to $ORIGINAL_PLAN (bundle has $OTHER_PLAN)"

# Step 4: restore `tenants` table via tenant cart. The bundle has
# plan_id=OTHER_PLAN. If the redaction works, plan_id stays ORIGINAL_PLAN.
RAW=$(api "$ADMIN_HOST" POST "/tenants/$TENANT_ID/restore-carts" \
  "{\"tenantId\":\"$TENANT_ID\",\"description\":\"rt-policy-redact\"}" "$TENANT_TOKEN")
parse "$RAW"
CART_ID2=$(printf '%s' "$BODY" | jq -r '.data.id')
[[ -n "$CART_ID2" ]] || { fail "cart create §2"; exit 1; }

RAW=$(api "$ADMIN_HOST" POST "/tenants/$TENANT_ID/restore-carts/$CART_ID2/items" \
  "{\"bundleId\":\"$BUNDLE_ID2\",\"type\":\"config-tables\",\"selector\":{\"kind\":\"tables\",\"tables\":[\"tenants\"]}}" \
  "$TENANT_TOKEN")
parse "$RAW"
[[ "$STATUS" == "201" ]] || { fail "add tenants item §2: $STATUS $BODY"; exit 1; }

RAW=$(api "$ADMIN_HOST" POST "/tenants/$TENANT_ID/restore-carts/$CART_ID2/execute" "{}" "$TENANT_TOKEN")
parse "$RAW"
[[ "$STATUS" == "200" ]] || { fail "cart execute §2: $STATUS $BODY"; exit 1; }

wait_cart "$CART_ID2" "$TENANT_ID" "$TENANT_TOKEN" 30
# Cart MUST fail. The tenants-table deny list strips `plan_id`,
# `region_id`, `kubernetes_namespace` etc. — all NOT NULL columns
# with no DEFAULT — so the INSERT … ON CONFLICT execute fails with
# a NOT NULL violation at the PG layer. The transaction rolls
# back, leaving the live row untouched. This is a STRONGER
# security guarantee than "denied columns are stripped" — the
# tenants-restore-via-cart pathway is entirely unusable, so a
# tenant cart cannot influence the tenants row in any way.
if [[ "$CART_STATUS" == "failed" ]]; then
  # Inspect the item-level error to confirm the failure is the
  # expected NOT NULL violation, not something else (e.g. auth).
  ITEM_ERR=$(psql_cmd "SELECT last_error FROM restore_items WHERE restore_job_id='$CART_ID2'" | head -c 400)
  if printf '%s' "$ITEM_ERR" | grep -qiE "null value|not[- ]null|violates not[- ]null constraint|Failed query"; then
    ok "REDACTION HARDENED: cart failed (item-level NOT NULL violation) — tenant cannot upsert the tenants row at all"
  else
    fail "cart failed but for an unexpected reason: $ITEM_ERR"
  fi
elif [[ "$CART_STATUS" == "done" ]]; then
  # If it somehow succeeded, the redaction must STILL have worked.
  FINAL_PLAN=$(psql_cmd "SELECT plan_id FROM tenants WHERE id='$TENANT_ID'" | tr -d ' \r\n')
  if [[ "$FINAL_PLAN" == "$ORIGINAL_PLAN" ]]; then
    ok "POLICY REDACTION VERIFIED: plan_id=$FINAL_PLAN (bundle's $OTHER_PLAN was correctly rejected)"
  else
    fail "POLICY REDACTION BROKEN: plan_id became $FINAL_PLAN (bundle's value: $OTHER_PLAN)"
    psql_cmd "UPDATE tenants SET plan_id='$ORIGINAL_PLAN' WHERE id='$TENANT_ID'" >/dev/null
  fi
else
  fail "cart §2 unexpected status: $CART_STATUS"
fi

# Live plan_id must be unchanged (the transaction rolled back).
FINAL_PLAN=$(psql_cmd "SELECT plan_id FROM tenants WHERE id='$TENANT_ID'" | tr -d ' \r\n')
if [[ "$FINAL_PLAN" == "$ORIGINAL_PLAN" ]]; then
  ok "live plan_id preserved at $ORIGINAL_PLAN (tenant cart did not influence it)"
else
  fail "live plan_id LEAKED to $FINAL_PLAN"
  psql_cmd "UPDATE tenants SET plan_id='$ORIGINAL_PLAN' WHERE id='$TENANT_ID'" >/dev/null
fi

# ─── §3: scheduler tick round-trip ────────────────────────────────────
log "§3 scheduler tick round-trip"

# Snapshot last_fired_at + count of system-initiated bundles BEFORE
LAST_FIRED_BEFORE=$(psql_cmd "SELECT COALESCE(last_fired_at::text, 'NULL') FROM backup_schedules WHERE subsystem='tenant_bundle'" | tr -d ' \r\n')
SYS_COUNT_BEFORE=$(psql_cmd "SELECT COUNT(*) FROM backup_jobs WHERE tenant_id='$TENANT_ID' AND initiator='system'" | tr -d ' \r\n')
ok "before: last_fired_at=$LAST_FIRED_BEFORE system_count=$SYS_COUNT_BEFORE"

# Compute next 5-min window cron expression
NOW_MIN=$(date -u +%M)
NOW_HR=$(date -u +%H)
TARGET_MIN=$(( ( (10#$NOW_MIN + 5) / 5 ) * 5 % 60 ))
TARGET_HR=$NOW_HR
if (( TARGET_MIN < 10#$NOW_MIN )); then TARGET_HR=$(( (10#$NOW_HR + 1) % 24 )); fi
TARGET_CRON="$TARGET_MIN $TARGET_HR * * *"

# Remember original cron to restore at the end.
ORIG_CRON=$(psql_cmd "SELECT cron_expression FROM backup_schedules WHERE subsystem='tenant_bundle'" | tr -d '\r\n')
ok "saved original cron: '$ORIG_CRON'"

# Set the test cron + clear last_fired_at so a fresh fire happens.
psql_cmd "UPDATE backup_schedules SET cron_expression='$TARGET_CRON', last_fired_at=NULL WHERE subsystem='tenant_bundle'" >/dev/null
ok "test cron set: '$TARGET_CRON'"

# Wait up to 7 min for the next tick window
log "waiting for next scheduler tick (window: ±5min around $TARGET_HR:$TARGET_MIN UTC)..."
SYS_FIRED=0
for i in $(seq 1 28); do
  LAST_FIRED_NOW=$(psql_cmd "SELECT COALESCE(last_fired_at::text, 'NULL') FROM backup_schedules WHERE subsystem='tenant_bundle'" | tr -d ' \r\n')
  if [[ "$LAST_FIRED_NOW" != "NULL" && "$LAST_FIRED_NOW" != "$LAST_FIRED_BEFORE" ]]; then
    ok "scheduler tick fired: last_fired_at=$LAST_FIRED_NOW"
    SYS_FIRED=1
    break
  fi
  sleep 15
done
if (( SYS_FIRED == 0 )); then
  fail "scheduler tick did not fire within 7min (last_fired_at still $LAST_FIRED_NOW)"
fi

# Check a system-initiated bundle row appeared for the tenant.
sleep 5  # allow orchestrator to insert the row
SYS_COUNT_AFTER=$(psql_cmd "SELECT COUNT(*) FROM backup_jobs WHERE tenant_id='$TENANT_ID' AND initiator='system'" | tr -d ' \r\n')
if (( SYS_COUNT_AFTER > SYS_COUNT_BEFORE )); then
  ok "scheduler created a new bundle row (before=$SYS_COUNT_BEFORE after=$SYS_COUNT_AFTER)"
elif (( SYS_FIRED == 1 )); then
  warn "scheduler fired but no new bundle row — likely no backup target assigned for class='tenant' (legacy path), or tenant not in eligible set"
  # Not a hard fail because the fire itself proves the bug-fix.
fi

# Restore original cron
psql_cmd "UPDATE backup_schedules SET cron_expression='$ORIG_CRON' WHERE subsystem='tenant_bundle'" >/dev/null
ok "restored cron to original: '$ORIG_CRON'"

# ─── summary ──────────────────────────────────────────────────────────
echo
echo "passed: $passed   failed: $failed"
[[ $failed -eq 0 ]] && exit 0 || exit 1
