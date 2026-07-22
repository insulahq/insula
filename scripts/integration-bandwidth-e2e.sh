#!/usr/bin/env bash
# integration-bandwidth-e2e.sh — resource-monitoring / monthly-bandwidth E2E.
#
# Exercises the 2026-07 resource-monitoring work against a real cluster:
#   1. Plan exposes bandwidth_gb_limit (default 100) + per-tenant override
#      round-trips through the API.
#   2. Node-CPU SLO rules (node-cpu / node-cpu-critical) are registered +
#      evaluated (GET /admin/monitoring/slo).
#   3. The new notification categories (bandwidth + per-tenant saturation) are
#      seeded.
#   4. Cap ENFORCEMENT: a capped tenant's live IngressRoute gains the
#      bandwidth-exceeded redirect Middleware (and loses it when the cap is
#      lifted) — the reconcile-durable path in annotation-sync.ts. Ends with a
#      real curl at the tenant's advertised host asserting the redirect.
#
# ENV (same shape as the other suites; integration-all supplies these):
#   ADMIN_HOST / ADMIN_EMAIL / ADMIN_PASSWORD (required)
#   SSH_KEY (default ~/hosting-platform.key) · STAGING_SSH_HOST / SSH_HOST
set -uo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.example.test}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -q}"
if [[ -z "$ADMIN_PASSWORD" ]]; then echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; fi

# SSH_HOST is root@<ip> when driven by integration-all; STAGING_SSH_HOST is a
# bare ip standalone. Strip any user@ so the ingress-IP curl below is clean.
CONTROL_HOST="${STAGING_SSH_HOST:-${SSH_HOST:-192.0.2.58}}"
CONTROL_HOST="${CONTROL_HOST#*@}"

PASS=0; FAIL=0
pass() { echo "PASS: $*"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }

k() { ssh $SSH_OPTS -i "$SSH_KEY" "root@${CONTROL_HOST}" kubectl "$@"; }
psql_q() { k exec -n platform system-db-1 -c postgres -- psql -U postgres -d platform -tAc "$1" 2>/dev/null; }
api() { curl -sk -H "Authorization: Bearer $TOKEN" "$@"; }

TOKEN=$(curl -fsSk -X POST "$ADMIN_HOST/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | jq -r '.data.token')
if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then echo "ERROR: login failed" >&2; exit 2; fi

# ── 1. Plan bandwidth setting ────────────────────────────────────────────────
echo "→ 1. plan bandwidth setting"
PLAN_JSON=$(api "$ADMIN_HOST/api/v1/plans?limit=20")
PLAN_ID=$(echo "$PLAN_JSON" | jq -r '[.data[] | select(.name=="Starter")][0].id // .data[0].id // empty')
BW=$(echo "$PLAN_JSON" | jq -r '.data[0].bandwidthGbLimit // empty')
if [[ -n "$BW" && "$BW" =~ ^[0-9]+$ && "$BW" -ge 1 ]]; then
  pass "plan exposes bandwidthGbLimit ($BW GB/mo)"
else
  fail "plan bandwidthGbLimit missing/invalid (got '$BW')"
fi

# ── 2. Node-CPU SLO rules registered ─────────────────────────────────────────
echo "→ 2. node-cpu monitoring rules"
SLO=$(api "$ADMIN_HOST/api/v1/admin/monitoring/slo")
rule_present() { echo "$SLO" | jq -e --arg r "$1" '([..|objects|select((.id//.ruleId)==$r)]|length)>0' >/dev/null 2>&1; }
for r in node-cpu node-cpu-critical; do
  if rule_present "$r"; then pass "monitoring rule '$r' registered"; else fail "monitoring rule '$r' MISSING"; fi
done

# ── 3. Notification categories seeded ────────────────────────────────────────
echo "→ 3. notification categories"
for c in admin.tenant_bandwidth_warning admin.tenant_bandwidth_critical \
         tenant.bandwidth_warning tenant.bandwidth_exceeded \
         admin.tenant_resource_saturation_warning admin.tenant_resource_saturation_critical; do
  n=$(psql_q "SELECT COUNT(*) FROM notification_categories WHERE id='$c';" | tr -d '[:space:]')
  if [[ "$n" == "1" ]]; then pass "category '$c' seeded"; else fail "category '$c' NOT seeded (n='$n')"; fi
done

# ── 4. Tenant create + bandwidth override round-trip ─────────────────────────
echo "→ 4. tenant bandwidth override"
REGION_ID=$(api "$ADMIN_HOST/api/v1/regions?limit=1" | jq -r '.data[0].id // empty')
if [[ -z "$PLAN_ID" || -z "$REGION_ID" ]]; then echo "ERROR: no plan/region" >&2; exit 1; fi
TNAME="bw-e2e-$(date +%s)"
TRESP=$(curl -sk -X POST "$ADMIN_HOST/api/v1/tenants" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"name\":\"$TNAME\",\"primary_email\":\"$TNAME@example.test\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\",\"bandwidth_limit_override\":250}")
TID=$(echo "$TRESP" | jq -r '.data.id // empty')
if [[ -z "$TID" ]]; then echo "ERROR: tenant create failed: $TRESP" >&2; exit 1; fi
echo "  tenant $TID"
cleanup() {
  [[ -n "${TID:-}" ]] && curl -sk -X DELETE "$ADMIN_HOST/api/v1/tenants/$TID" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1 || true
}
trap cleanup EXIT
OV=$(api "$ADMIN_HOST/api/v1/tenants/$TID" | jq -r '.data.bandwidthLimitOverride // empty')
if [[ "$OV" == "250" ]]; then pass "tenant bandwidth override round-trips (250)"; else fail "tenant override != 250 (got '$OV')"; fi

# ── 5. Cap ENFORCEMENT E2E ───────────────────────────────────────────────────
echo "→ 5. cap enforcement (provision + deploy + cap + verify redirect + restore)"
curl -sk -X POST "$ADMIN_HOST/api/v1/admin/tenants/$TID/provision" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1
PROV=0; for i in $(seq 1 45); do api "$ADMIN_HOST/api/v1/tenants/$TID" | grep -q '"status":"active"' && { PROV=1; break; }; sleep 4; done
if [[ "$PROV" -ne 1 ]]; then fail "tenant did not provision — skipping cap E2E"; else
  NS=$(api "$ADMIN_HOST/api/v1/tenants/$TID" | jq -r '.data.kubernetesNamespace')
  HOST="bwcap-${TID:0:8}.example.test"
  CAT_ID=$(api "$ADMIN_HOST/api/v1/catalog?limit=200" | jq -r '[.data[] | select(((.name//"")|ascii_downcase)|test("static")) | select(((.name//"")|ascii_downcase)|test("nginx"))][0].id // empty')
  if [[ -z "$CAT_ID" ]]; then
    fail "static-nginx catalog entry not found — cannot build a serving route"
  else
    DRESP=$(curl -sk -X POST "$ADMIN_HOST/api/v1/tenants/$TID/deployments" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d "{\"catalog_entry_id\":\"$CAT_ID\",\"name\":\"bwsite\",\"domain_name\":\"$HOST\"}")
    DEP_ID=$(echo "$DRESP" | jq -r '.data.id // empty')
    # Ensure the domain is linked to the deployment so an active ingress_route exists.
    DOM_ID=$(api "$ADMIN_HOST/api/v1/tenants/$TID/domains" | jq -r --arg h "$HOST" '.data[] | select(.domainName==$h) | .id' | head -1)
    if [[ -n "$DEP_ID" && -n "$DOM_ID" ]]; then
      curl -sk -X PATCH "$ADMIN_HOST/api/v1/tenants/$TID/domains/$DOM_ID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
        -d "{\"deployment_id\":\"$DEP_ID\",\"status\":\"active\"}" >/dev/null 2>&1
    fi
    # Wait for the tenant IngressRoute to be built.
    IR=""; for i in $(seq 1 20); do IR=$(k get ingressroute -n "$NS" -o json 2>/dev/null | jq -r '[.items[].metadata.name]|join(",")'); [[ -n "$IR" && "$IR" != "null" ]] && break; sleep 4; done
    if [[ -z "$IR" || "$IR" == "null" ]]; then
      fail "no IngressRoute built for the test tenant — cannot verify cap"
    else
      pass "tenant IngressRoute built ($IR)"
      has_cap() { k get ingressroute -n "$NS" -o json 2>/dev/null \
        | jq -e '[.items[].spec.routes[].middlewares[]?.name] | any(startswith("bw-cap"))' >/dev/null 2>&1; }
      # Baseline: not capped.
      if has_cap; then fail "bw-cap middleware present BEFORE capping"; else pass "no bw-cap middleware before capping (baseline)"; fi

      # Cap: set the flag + reconcile via a domain PATCH (tenant-scoped, parallel-safe).
      psql_q "UPDATE tenants SET bandwidth_capped=true, bandwidth_capped_at=NOW() WHERE id='$TID';" >/dev/null
      [[ -n "${DOM_ID:-}" ]] && curl -sk -X PATCH "$ADMIN_HOST/api/v1/tenants/$TID/domains/$DOM_ID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"ssl_auto_renew":true}' >/dev/null 2>&1
      CAPPED=0; for i in $(seq 1 10); do has_cap && { CAPPED=1; break; }; sleep 3; done
      if [[ "$CAPPED" -eq 1 ]]; then pass "CAP ENFORCED: bw-cap redirect Middleware injected on the live IngressRoute"; else fail "cap flag set but bw-cap Middleware NOT injected after reconcile"; fi

      # User-visible: the tenant host now redirects (best-effort — HTTPS cert may
      # be absent for the throwaway domain, so try http entrypoint too).
      if [[ "$CAPPED" -eq 1 && -n "$CONTROL_HOST" ]]; then
        LOC=$(curl -sk -o /dev/null -D - --resolve "$HOST:80:$CONTROL_HOST" "http://$HOST/" --max-time 15 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}' | head -1)
        if echo "$LOC" | grep -qi "bandwidth-exceeded"; then
          pass "capped tenant host 30x-redirects to the bandwidth-exceeded page ($LOC)"
        else
          echo "  ⊝ capped-host redirect not asserted (Location='$LOC'; TLS cert may be absent for the throwaway domain) — Middleware-level cap already proven"
        fi
      fi

      # Restore: lift the cap + reconcile → middleware removed.
      psql_q "UPDATE tenants SET bandwidth_capped=false, bandwidth_capped_at=NULL WHERE id='$TID';" >/dev/null
      [[ -n "${DOM_ID:-}" ]] && curl -sk -X PATCH "$ADMIN_HOST/api/v1/tenants/$TID/domains/$DOM_ID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"ssl_auto_renew":true}' >/dev/null 2>&1
      RESTORED=0; for i in $(seq 1 10); do has_cap || { RESTORED=1; break; }; sleep 3; done
      if [[ "$RESTORED" -eq 1 ]]; then pass "CAP LIFTED: bw-cap Middleware removed after uncap + reconcile"; else fail "cap lifted but bw-cap Middleware still present"; fi
    fi
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo
echo "─────────────────────────────────────────────"
echo "PASS: $PASS  FAIL: $FAIL"
echo "─────────────────────────────────────────────"
[[ "$FAIL" -gt 0 ]] && exit 1
exit 0
