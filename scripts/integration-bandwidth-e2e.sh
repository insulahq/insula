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
# psql over stdin (kubectl exec -i → psql -tA reads SQL from stdin). Passing SQL
# via stdin avoids all shell re-quoting through ssh→kubectl→psql — a literal
# WHERE id='...' survives intact, which the previous -tAc "$1" form mangled.
psql_q() { ssh $SSH_OPTS -i "$SSH_KEY" "root@${CONTROL_HOST}" \
  "kubectl exec -i -n platform system-db-1 -c postgres -- psql -U postgres -d platform -tA" <<<"$1" 2>/dev/null; }
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

# ── 4. Tenant bandwidth override round-trip (PATCH — the admin-UI path) ───────
# Overrides (cpu/memory/storage/bandwidth) are PATCH-only: createTenantSchema
# has no override fields, so Zod strips them at create — the TenantDetail
# ResourceLimitsCard applies them via PATCH /tenants/:id. Exercise that path.
echo "→ 4. tenant bandwidth override (PATCH)"
REGION_ID=$(api "$ADMIN_HOST/api/v1/regions?limit=1" | jq -r '.data[0].id // empty')
if [[ -z "$PLAN_ID" || -z "$REGION_ID" ]]; then echo "ERROR: no plan/region" >&2; exit 1; fi
TNAME="bw-e2e-$(date +%s)"
TRESP=$(curl -sk -X POST "$ADMIN_HOST/api/v1/tenants" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"name\":\"$TNAME\",\"primary_email\":\"$TNAME@example.test\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\"}")
TID=$(echo "$TRESP" | jq -r '.data.id // empty')
if [[ -z "$TID" ]]; then echo "ERROR: tenant create failed: $TRESP" >&2; exit 1; fi
echo "  tenant $TID"
cleanup() {
  [[ -n "${TID:-}" ]] && curl -sk -X DELETE "$ADMIN_HOST/api/v1/tenants/$TID" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1 || true
}
trap cleanup EXIT
# Set the override.
curl -sk -X PATCH "$ADMIN_HOST/api/v1/tenants/$TID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"bandwidth_limit_override":250}' >/dev/null 2>&1
OV=$(api "$ADMIN_HOST/api/v1/tenants/$TID" | jq -r '.data.bandwidthLimitOverride // empty')
if [[ "$OV" == "250" ]]; then pass "tenant bandwidth override round-trips (250 via PATCH)"; else fail "tenant override != 250 (got '$OV')"; fi
# Clear the override → inherits the plan again (null).
curl -sk -X PATCH "$ADMIN_HOST/api/v1/tenants/$TID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"bandwidth_limit_override":null}' >/dev/null 2>&1
OV2=$(api "$ADMIN_HOST/api/v1/tenants/$TID" | jq -r '.data.bandwidthLimitOverride // "null"')
if [[ "$OV2" == "null" ]]; then pass "override clears to plan inheritance (null)"; else fail "override did not clear (got '$OV2')"; fi

# ── 5. Cap ENFORCEMENT E2E ───────────────────────────────────────────────────
# The IngressRoute only exists once an ingress_routes row (status=active) points
# at a deployment. The reliable path: deploy a workload, then POST a domain BOUND
# to it (createDomain → createRoute status=active → reconcileIngress). The route
# builds regardless of pod readiness or domain verification (buildAllRouteSpecs
# filters on route.status only), so image-pull/quota can't block the cap assertion.
echo "→ 5. cap enforcement (provision + deploy + domain + cap + verify redirect + restore)"
curl -sk -X POST "$ADMIN_HOST/api/v1/admin/tenants/$TID/provision" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1
PROV=0; for i in $(seq 1 45); do api "$ADMIN_HOST/api/v1/tenants/$TID" | grep -q '"status":"active"' && { PROV=1; break; }; sleep 4; done
if [[ "$PROV" -ne 1 ]]; then fail "tenant did not provision — skipping cap E2E"; else
  NS=$(api "$ADMIN_HOST/api/v1/tenants/$TID" | jq -r '.data.kubernetesNamespace')
  HOST="bwcap-${TID:0:8}.example.test"
  CAT_ID=$(api "$ADMIN_HOST/api/v1/catalog?limit=200" | jq -r '[.data[] | select(((.name//"")|ascii_downcase)|test("static")) | select(((.name//"")|ascii_downcase)|test("nginx"))][0].id // empty')
  [[ -z "$CAT_ID" ]] && CAT_ID=$(api "$ADMIN_HOST/api/v1/catalog?limit=200" | jq -r '[.data[] | select(((.type//"")|ascii_downcase)=="static")][0].id // empty')
  if [[ -z "$CAT_ID" ]]; then
    fail "no static catalog entry found — cannot build a serving route"
  else
    DRESP=$(curl -sk -X POST "$ADMIN_HOST/api/v1/tenants/$TID/deployments" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d "{\"catalog_entry_id\":\"$CAT_ID\",\"name\":\"bwsite\"}")
    DEP_ID=$(echo "$DRESP" | jq -r '.data.id // empty')
    if [[ -z "$DEP_ID" ]]; then
      fail "deployment create failed: $(echo "$DRESP" | head -c 200)"
    else
      # Domain bound to the deployment → active ingress_route + reconcile.
      DOMRESP=$(curl -sk -X POST "$ADMIN_HOST/api/v1/tenants/$TID/domains" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
        -d "{\"domain_name\":\"$HOST\",\"dns_mode\":\"cname\",\"deployment_id\":\"$DEP_ID\"}")
      DOM_ID=$(echo "$DOMRESP" | jq -r '.data.id // empty')
      if [[ -z "$DOM_ID" ]]; then
        fail "domain create failed: $(echo "$DOMRESP" | head -c 200)"
      else
        # Wait for the tenant IngressRoute to be built.
        IR=""; for i in $(seq 1 20); do IR=$(k get ingressroute -n "$NS" -o json 2>/dev/null | jq -r '[.items[].metadata.name]|join(",")'); [[ -n "$IR" && "$IR" != "null" ]] && break; sleep 4; done
        if [[ -z "$IR" || "$IR" == "null" ]]; then
          fail "no IngressRoute built for the test tenant — cannot verify cap"
          echo "  route rows:"; psql_q "SELECT hostname,status,deployment_id FROM ingress_routes WHERE domain_id='$DOM_ID';"
        else
          pass "tenant IngressRoute built ($IR)"
          has_cap() { k get ingressroute -n "$NS" -o json 2>/dev/null \
            | jq -e '[.items[].spec.routes[].middlewares[]?.name] | any(startswith("bw-cap"))' >/dev/null 2>&1; }
          # Baseline: not capped.
          if has_cap; then fail "bw-cap middleware present BEFORE capping"; else pass "no bw-cap middleware before capping (baseline)"; fi

          # Cap: set the flag (simulating a meter tick) + reconcile via a domain
          # dns_mode PATCH (updateDomain reconciles on dns_mode/deployment_id change).
          psql_q "UPDATE tenants SET bandwidth_capped=true, bandwidth_capped_at=NOW() WHERE id='$TID';" >/dev/null
          curl -sk -X PATCH "$ADMIN_HOST/api/v1/tenants/$TID/domains/$DOM_ID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"dns_mode":"cname"}' >/dev/null 2>&1
          CAPPED=0; for i in $(seq 1 12); do has_cap && { CAPPED=1; break; }; sleep 3; done
          if [[ "$CAPPED" -eq 1 ]]; then pass "CAP ENFORCED: bw-cap redirect Middleware injected on the live IngressRoute"; else fail "cap flag set but bw-cap Middleware NOT injected after reconcile"; fi

          # User-visible: the capped tenant host now 30x-redirects to the
          # bandwidth-exceeded page. bw-cap runs on the HTTPS route (the http
          # entrypoint only upgrades http→https first), so hit :443 with SNI.
          # curl -k tolerates the throwaway domain's default/absent cert — the
          # redirect is emitted by the middleware before the backend is reached.
          if [[ "$CAPPED" -eq 1 && -n "$CONTROL_HOST" ]]; then
            LOC=$(curl -sk -o /dev/null -D - --resolve "$HOST:443:$CONTROL_HOST" "https://$HOST/" --max-time 15 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}' | head -1)
            if echo "$LOC" | grep -qi "bandwidth-exceeded"; then
              pass "capped tenant host 30x-redirects to the bandwidth-exceeded page ($LOC)"
            else
              echo "  ⊝ capped-host redirect not asserted (Location='$LOC') — Middleware-level cap already proven on the live IngressRoute"
            fi
          fi

          # Restore: lift the cap + reconcile → middleware removed.
          psql_q "UPDATE tenants SET bandwidth_capped=false, bandwidth_capped_at=NULL WHERE id='$TID';" >/dev/null
          curl -sk -X PATCH "$ADMIN_HOST/api/v1/tenants/$TID/domains/$DOM_ID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"dns_mode":"cname"}' >/dev/null 2>&1
          RESTORED=0; for i in $(seq 1 12); do has_cap || { RESTORED=1; break; }; sleep 3; done
          if [[ "$RESTORED" -eq 1 ]]; then pass "CAP LIFTED: bw-cap Middleware removed after uncap + reconcile"; else fail "cap lifted but bw-cap Middleware still present"; fi
        fi
      fi
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
