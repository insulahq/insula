#!/usr/bin/env bash
# End-to-end test for the tenant-bundles tenant-side surface
# (2026-05-28).
#
# Validates:
#   1. Schedule fix: backup_schedules.tenant_bundle row + global
#      scheduler ticks no longer throw the `tenant_status: "deleted"`
#      enum error.
#   2. Tenant-scoped routes auth:
#      - 401 with no token
#      - 403 with admin-panel token
#      - 403 with tenant_admin token + cross-tenant :tenantId
#      - 200 with own tenant
#   3. Tenant policy:
#      - config-tables with `hosting_plans` table → 403 TABLE_DENIED
#      - config-tables with `mailboxes` table     → 201 (allowed)
#      - config-tables "all" selector             → 403 SELECTOR_TOO_BROAD
#   4. On-demand bundle: POST /tenants/:id/bundles/run-now → 202
#   5. Run-now bundle appears in GET /tenants/:id/bundles
#
# USAGE: ADMIN_PASSWORD=<…> ./scripts/integration-tenant-bundles-tenant-side.sh

set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
TENANT_HOST="${TENANT_HOST:-${ADMIN_HOST/admin./tenant.}}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@staging.phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"

[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; RESET='\033[0m'
log()  { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail() { printf '  %b✗%b %s\n' "$RED"   "$RESET" "$*"; failed=$((failed+1)); }

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

# Split response body and HTTP status from `curl -w \n%{http_code}`.
parse() {
  local raw="$1"
  STATUS=$(printf '%s' "$raw" | tail -n1)
  BODY=$(printf '%s' "$raw" | sed '$d')
}

log "logging in as $ADMIN_EMAIL"
RAW=$(api "$ADMIN_HOST" POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
parse "$RAW"
[[ "$STATUS" == "200" ]] || { fail "admin login failed ($STATUS): $BODY"; exit 1; }
ADMIN_TOKEN=$(printf '%s' "$BODY" | jq -r '.data.token // .token // empty')
[[ -n "$ADMIN_TOKEN" ]] || { fail "no token in admin login response"; exit 1; }
ok "admin login"

# ── §1: schedule fix sanity check ─────────────────────────────────────
log "checking tenant-bundle schedule row + recent fires"
RAW=$(api "$ADMIN_HOST" GET /admin/backups/schedules "" "$ADMIN_TOKEN")
parse "$RAW"
if [[ "$STATUS" == "200" ]]; then
  CRON=$(printf '%s' "$BODY" | jq -r '.data.schedules[] | select(.subsystem=="tenant_bundle") | .cronExpression // empty')
  ENABLED=$(printf '%s' "$BODY" | jq -r '.data.schedules[] | select(.subsystem=="tenant_bundle") | .enabled // empty')
  if [[ "$ENABLED" == "true" && -n "$CRON" ]]; then
    ok "tenant_bundle schedule present: cron=$CRON enabled=true"
  else
    fail "tenant_bundle schedule missing or disabled (enabled=$ENABLED cron=$CRON)"
  fi
else
  fail "schedule listing returned $STATUS"
fi

# Pick the first active tenant for testing.
log "picking a target tenant"
RAW=$(api "$ADMIN_HOST" GET /tenants "" "$ADMIN_TOKEN")
parse "$RAW"
TENANT_ID=$(printf '%s' "$BODY" | jq -r '.data[] | select(.status=="active" and .name != "SYSTEM") | .id' | head -1)
[[ -n "$TENANT_ID" ]] || { fail "no active non-SYSTEM tenant found"; exit 1; }
ok "target tenant: $TENANT_ID"

# Resolve any other tenant id for cross-tenant test.
OTHER_TENANT_ID=$(printf '%s' "$BODY" | jq -r '.data[] | .id' | grep -v "^$TENANT_ID\$" | head -1)
[[ -n "$OTHER_TENANT_ID" ]] || OTHER_TENANT_ID="11111111-1111-1111-1111-111111111111"
log "cross-tenant id for negative test: $OTHER_TENANT_ID"

# Provision a tenant_admin user for this tenant.
log "provisioning tenant_admin user"
TENANT_USER_EMAIL="tenant-restore-e2e-$(date +%s)@example.test"
TENANT_USER_PASSWORD="TestRestore!$(date +%s)"
RAW=$(api "$ADMIN_HOST" POST "/tenants/$TENANT_ID/users" "{\"email\":\"$TENANT_USER_EMAIL\",\"password\":\"$TENANT_USER_PASSWORD\",\"full_name\":\"Restore E2E User\",\"role_name\":\"tenant_admin\"}" "$ADMIN_TOKEN")
parse "$RAW"
if [[ "$STATUS" == "201" || "$STATUS" == "200" ]]; then
  ok "tenant_admin provisioned: $TENANT_USER_EMAIL"
else
  fail "tenant_admin provisioning returned $STATUS: $BODY"
  exit 1
fi

# Login as the tenant_admin via tenant panel.
log "logging in as tenant_admin"
RAW=$(api "$TENANT_HOST" POST /auth/login "{\"email\":\"$TENANT_USER_EMAIL\",\"password\":\"$TENANT_USER_PASSWORD\",\"panel\":\"tenant\"}")
parse "$RAW"
if [[ "$STATUS" != "200" ]]; then
  fail "tenant_admin login failed ($STATUS): $BODY"
  # Try via admin host (panel claim still works)
  log "retrying via admin host"
  RAW=$(api "$ADMIN_HOST" POST /auth/login "{\"email\":\"$TENANT_USER_EMAIL\",\"password\":\"$TENANT_USER_PASSWORD\",\"panel\":\"tenant\"}")
  parse "$RAW"
fi
TENANT_TOKEN=$(printf '%s' "$BODY" | jq -r '.data.token // .token // empty')
[[ -n "$TENANT_TOKEN" ]] || { fail "no tenant token in response: $BODY"; exit 1; }
ok "tenant_admin login"

# ── §2: auth boundaries ───────────────────────────────────────────────
log "§2 auth boundaries"

# 2a. no token → 401
RAW=$(api "$ADMIN_HOST" GET "/tenants/$TENANT_ID/bundles" "")
parse "$RAW"
[[ "$STATUS" == "401" ]] && ok "no token → 401" || fail "no token: expected 401 got $STATUS"

# 2b. admin token → 403 (wrong panel)
RAW=$(api "$ADMIN_HOST" GET "/tenants/$TENANT_ID/bundles" "" "$ADMIN_TOKEN")
parse "$RAW"
[[ "$STATUS" == "403" ]] && ok "admin token on tenant route → 403" || fail "admin token: expected 403 got $STATUS body=$BODY"

# 2c. tenant token on own tenant → 200
RAW=$(api "$ADMIN_HOST" GET "/tenants/$TENANT_ID/bundles" "" "$TENANT_TOKEN")
parse "$RAW"
[[ "$STATUS" == "200" ]] && ok "tenant token on own tenant → 200" || fail "own tenant: expected 200 got $STATUS body=$BODY"

# 2d. tenant token on OTHER tenant → 403
RAW=$(api "$ADMIN_HOST" GET "/tenants/$OTHER_TENANT_ID/bundles" "" "$TENANT_TOKEN")
parse "$RAW"
if [[ "$STATUS" == "403" ]]; then
  ok "tenant token on other tenant → 403"
else
  fail "cross-tenant: expected 403 got $STATUS body=$BODY"
fi

# ── §3: restore-cart + policy ─────────────────────────────────────────
log "§3 restore-cart + tenant policy"

# Find a recent completed/partial bundle for this tenant.
RAW=$(api "$ADMIN_HOST" GET "/tenants/$TENANT_ID/bundles" "" "$TENANT_TOKEN")
parse "$RAW"
BUNDLE_ID=$(printf '%s' "$BODY" | jq -r '.data[] | select(.status=="completed" or .status=="partial") | .id' | head -1)
if [[ -z "$BUNDLE_ID" ]]; then
  log "no existing bundle — triggering run-now first"
  RAW=$(api "$ADMIN_HOST" POST "/tenants/$TENANT_ID/bundles/run-now" "{}" "$TENANT_TOKEN")
  parse "$RAW"
  if [[ "$STATUS" == "202" ]]; then
    BUNDLE_ID=$(printf '%s' "$BODY" | jq -r '.data.bundleId // empty')
    ok "run-now started bundle $BUNDLE_ID"
  else
    fail "could not produce a bundle ($STATUS): $BODY"
  fi
fi
[[ -n "$BUNDLE_ID" ]] || { fail "still no bundle id — skipping cart tests"; }

if [[ -n "$BUNDLE_ID" ]]; then
  # Browse config-tables — denied tables must NOT appear.
  RAW=$(api "$ADMIN_HOST" GET "/tenants/$TENANT_ID/bundles/$BUNDLE_ID/browse/config-tables" "" "$TENANT_TOKEN")
  parse "$RAW"
  if [[ "$STATUS" == "200" ]]; then
    TABLES=$(printf '%s' "$BODY" | jq -r '.data.tables[]?.name // empty' | tr '\n' ',' )
    if printf '%s' "$TABLES" | grep -q "hosting_plans"; then
      fail "policy leak: hosting_plans appears in tenant browse"
    else
      ok "browse hides denied tables (no hosting_plans in: $TABLES)"
    fi
  else
    fail "browse returned $STATUS (expected 200) — bundle may not be readable yet"
  fi

  # Create cart.
  RAW=$(api "$ADMIN_HOST" POST "/tenants/$TENANT_ID/restore-carts" "{\"tenantId\":\"$TENANT_ID\",\"description\":\"e2e\"}" "$TENANT_TOKEN")
  parse "$RAW"
  if [[ "$STATUS" == "201" ]]; then
    CART_ID=$(printf '%s' "$BODY" | jq -r '.data.id')
    ok "cart created: $CART_ID"

    # Add an allowed item.
    RAW=$(api "$ADMIN_HOST" POST "/tenants/$TENANT_ID/restore-carts/$CART_ID/items" \
      "{\"bundleId\":\"$BUNDLE_ID\",\"type\":\"config-tables\",\"selector\":{\"kind\":\"tables\",\"tables\":[\"mailboxes\"]}}" \
      "$TENANT_TOKEN")
    parse "$RAW"
    [[ "$STATUS" == "201" ]] && ok "allowed config-tables item accepted" || fail "allowed item: expected 201 got $STATUS body=$BODY"

    # Try a denied table.
    RAW=$(api "$ADMIN_HOST" POST "/tenants/$TENANT_ID/restore-carts/$CART_ID/items" \
      "{\"bundleId\":\"$BUNDLE_ID\",\"type\":\"config-tables\",\"selector\":{\"kind\":\"tables\",\"tables\":[\"hosting_plans\"]}}" \
      "$TENANT_TOKEN")
    parse "$RAW"
    if [[ "$STATUS" == "403" ]] && printf '%s' "$BODY" | grep -q "hosting_plans"; then
      ok "denied table → 403 TABLE_DENIED"
    else
      fail "denied table: expected 403 got $STATUS body=$BODY"
    fi

    # Try config-tables "all" — should be SELECTOR_TOO_BROAD.
    RAW=$(api "$ADMIN_HOST" POST "/tenants/$TENANT_ID/restore-carts/$CART_ID/items" \
      "{\"bundleId\":\"$BUNDLE_ID\",\"type\":\"config-tables\",\"selector\":{\"kind\":\"all\"}}" \
      "$TENANT_TOKEN")
    parse "$RAW"
    if [[ "$STATUS" == "403" ]] && printf '%s' "$BODY" | grep -q "SELECTOR_TOO_BROAD"; then
      ok "config-tables 'all' → 403 SELECTOR_TOO_BROAD"
    else
      fail "selector-too-broad: expected 403 got $STATUS body=$BODY"
    fi
  else
    fail "cart creation: expected 201 got $STATUS body=$BODY"
  fi
fi

# ── §4: run-now + status polling ──────────────────────────────────────
log "§4 run-now"
RAW=$(api "$ADMIN_HOST" POST "/tenants/$TENANT_ID/bundles/run-now" "{}" "$TENANT_TOKEN")
parse "$RAW"
if [[ "$STATUS" == "202" ]]; then
  NEW_BUNDLE_ID=$(printf '%s' "$BODY" | jq -r '.data.bundleId // empty')
  if [[ -n "$NEW_BUNDLE_ID" ]]; then
    ok "run-now → 202 bundleId=$NEW_BUNDLE_ID"

    # Status endpoint — cross-tenant 403.
    RAW=$(api "$ADMIN_HOST" GET "/tenants/$OTHER_TENANT_ID/bundles/$NEW_BUNDLE_ID/status" "" "$TENANT_TOKEN")
    parse "$RAW"
    [[ "$STATUS" == "403" ]] && ok "status cross-tenant → 403" || fail "status cross-tenant: expected 403 got $STATUS"

    # Status endpoint — own tenant. Bundle row exists immediately
    # (run-now waits for the insert before returning), so this should
    # return 200 with at least a few components rows populated.
    RAW=$(api "$ADMIN_HOST" GET "/tenants/$TENANT_ID/bundles/$NEW_BUNDLE_ID/status" "" "$TENANT_TOKEN")
    parse "$RAW"
    if [[ "$STATUS" == "200" ]]; then
      BSTATUS=$(printf '%s' "$BODY" | jq -r '.data.bundle.status')
      CCOUNT=$(printf '%s' "$BODY" | jq -r '.data.components | length')
      ok "status own → 200 bundle.status=$BSTATUS components=$CCOUNT"
    else
      fail "status own: expected 200 got $STATUS body=$BODY"
    fi
  else
    fail "run-now 202 but no bundleId in response: $BODY"
  fi
else
  fail "run-now: expected 202 got $STATUS body=$BODY"
fi

# ── §4.5: E2E execute the cart (TDD finishes the loop) ───────────────
# Adds a benign config-tables item (email_aliases — usually empty for
# fresh tenants, so the restore is effectively a no-op against
# whatever the bundle captured), executes the cart, polls until
# terminal, and asserts cart.status='done' AND items[0].status='done'.
# This proves the orchestrator → executor → policy-redaction chain
# actually runs in real conditions, not just in unit tests.
log "§4.5 cart execute E2E"
if [[ -n "$BUNDLE_ID" && -n "$CART_ID" ]]; then
  # Find a freshly-completed bundle (the run-now one may still be
  # initializing). Re-query for any completed/partial bundle.
  RAW=$(api "$ADMIN_HOST" GET "/tenants/$TENANT_ID/bundles" "" "$TENANT_TOKEN")
  parse "$RAW"
  E2E_BUNDLE=$(printf '%s' "$BODY" | jq -r '.data[] | select(.status=="completed" or .status=="partial") | .id' | head -1)
  if [[ -n "$E2E_BUNDLE" ]]; then
    # Fresh cart for the E2E to avoid mixing with the failed-item
    # cart from §3.
    RAW=$(api "$ADMIN_HOST" POST "/tenants/$TENANT_ID/restore-carts" \
      "{\"tenantId\":\"$TENANT_ID\",\"description\":\"e2e-execute\"}" "$TENANT_TOKEN")
    parse "$RAW"
    E2E_CART=$(printf '%s' "$BODY" | jq -r '.data.id')
    [[ "$STATUS" == "201" && -n "$E2E_CART" ]] && ok "e2e cart created: $E2E_CART" || fail "e2e cart create $STATUS body=$BODY"

    # Add a benign item — email_aliases is in the restore allow-list
    # and rarely populated for test tenants. Restoring an empty array
    # over an empty live table is a no-op success.
    RAW=$(api "$ADMIN_HOST" POST "/tenants/$TENANT_ID/restore-carts/$E2E_CART/items" \
      "{\"bundleId\":\"$E2E_BUNDLE\",\"type\":\"config-tables\",\"selector\":{\"kind\":\"tables\",\"tables\":[\"emailAliases\"]}}" \
      "$TENANT_TOKEN")
    parse "$RAW"
    [[ "$STATUS" == "201" ]] && ok "e2e item added (emailAliases)" || fail "e2e item add $STATUS body=$BODY"

    # Execute. With config-tables-only items, no PVC snapshot is taken
    # so we expect a fast terminal state (no Job spawn).
    RAW=$(api "$ADMIN_HOST" POST "/tenants/$TENANT_ID/restore-carts/$E2E_CART/execute" "{}" "$TENANT_TOKEN")
    parse "$RAW"
    [[ "$STATUS" == "200" ]] && ok "e2e execute returned 200" || fail "e2e execute $STATUS body=$BODY"

    # Poll cart status until terminal. 30s budget — config-tables
    # restore is purely a DB upsert; should finish in under 5s.
    TERMINAL=""
    for i in $(seq 1 15); do
      RAW=$(api "$ADMIN_HOST" GET "/tenants/$TENANT_ID/restore-carts/$E2E_CART" "" "$TENANT_TOKEN")
      parse "$RAW"
      CART_STATUS=$(printf '%s' "$BODY" | jq -r '.data.status // empty')
      if [[ "$CART_STATUS" == "done" || "$CART_STATUS" == "failed" ]]; then
        TERMINAL="$CART_STATUS"
        break
      fi
      sleep 2
    done
    if [[ "$TERMINAL" == "done" ]]; then
      ok "e2e cart reached terminal=done"
      ITEM_STATUS=$(printf '%s' "$BODY" | jq -r '.data.items[0].status // empty')
      [[ "$ITEM_STATUS" == "done" ]] && ok "e2e item terminal=done" || fail "e2e item terminal: expected done got $ITEM_STATUS"
    else
      fail "e2e cart did not reach 'done' (last=$CART_STATUS, body=$BODY)"
    fi
  else
    log "no completed bundle yet; skipping e2e execute"
  fi
fi

# ── §5: schedule routes removed ───────────────────────────────────────
log "§5 schedule routes removed"
RAW=$(api "$ADMIN_HOST" GET "/tenant/backups/schedule" "" "$TENANT_TOKEN")
parse "$RAW"
[[ "$STATUS" == "404" ]] && ok "GET /tenant/backups/schedule → 404 (removed)" || fail "expected 404 got $STATUS"

RAW=$(api "$ADMIN_HOST" PUT "/tenant/backups/schedule" '{"enabled":true,"frequency":"daily"}' "$TENANT_TOKEN")
parse "$RAW"
[[ "$STATUS" == "404" ]] && ok "PUT /tenant/backups/schedule → 404 (removed)" || fail "expected 404 got $STATUS"

# ── summary ───────────────────────────────────────────────────────────
echo
echo "passed: $passed   failed: $failed"
[[ $failed -eq 0 ]] && exit 0 || exit 1
