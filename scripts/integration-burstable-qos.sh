#!/usr/bin/env bash
# integration-burstable-qos.sh — verify ADR-037 asymmetric QoS model
# against a real k3s cluster.
#
# Asserts:
#   1. New deployments emit `requests.cpu` per container and NO
#      `limits.cpu` (CPU is bursty).
#   2. New deployments emit `requests.memory == limits.memory` per
#      container (memory is Guaranteed).
#   3. The tenant namespace's ResourceQuota enforces `requests.cpu`
#      (not `limits.cpu`) and `limits.memory` + `requests.memory`.
#   4. Multi-component allocator splits a deployment's CPU/memory
#      across components — no single component holds the full budget.
#   5. Sum of per-component `requests.cpu` ≤ plan cap; quota rejects
#      pods that would push over the cap.
#   6. The /resource-breakdown API endpoint returns per-component
#      allocations matching what's on the cluster.
#
# Required env:
#   ADMIN_PASSWORD     admin@example.test password
#
# Optional env:
#   ADMIN_HOST         https://admin.staging.example.test
#   STAGING_SSH_HOST   first IP from ~/k8s-staging/servers.txt
#   SSH_KEY            ~/hosting-platform.key
#
# Exit codes:
#   0  all assertions passed
#   1  one or more assertions failed
#   2  prereq missing

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.example.test}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -q}"

if [[ -z "$ADMIN_PASSWORD" ]]; then
  echo "ERROR: ADMIN_PASSWORD must be set" >&2
  exit 2
fi

# STAGING_SSH_HOST when run standalone; SSH_HOST when driven by integration-all
# (which loads scripts/integration.env — SSH_HOST=root@<node>). Placeholder last.
CONTROL_HOST="${STAGING_SSH_HOST:-${SSH_HOST:-192.0.2.58}}"
CONTROL_HOST="${CONTROL_HOST##*@}"

PASS=0
FAIL=0

pass() { echo "PASS: $*"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }

# Helper: kubectl from staging1
k() {
  ssh $SSH_OPTS -i "$SSH_KEY" "root@${CONTROL_HOST}" kubectl "$@"
}

# ─── Authenticate ───────────────────────────────────────────────────────────
echo "→ Authenticating..."
TOKEN=$(curl -fsSL -X POST "$ADMIN_HOST/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | jq -r '.data.token')

if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "ERROR: login failed" >&2
  exit 2
fi

# ─── Create/locate test tenant ──────────────────────────────────────────────
# Base plan is Starter (smallest PVCs) so the test stays cheap. CPU and
# memory are bumped via overrides — the burstable-QoS test specifically
# needs cpu_limit_override=2 + memory_limit_override=4 to exercise the
# burstable scheduling path.
TENANT_NAME="qos-test-$(date +%s)"
echo "→ Creating test tenant '$TENANT_NAME' (Starter plan + 2-CPU override)..."

PLAN_ID=$(curl -sk -H "Authorization: Bearer $TOKEN" "$ADMIN_HOST/api/v1/plans?limit=20" \
  | jq -r '[.data[] | select(.name == "Starter")][0].id // .data[0].id // empty')
REGION_ID=$(curl -sk -H "Authorization: Bearer $TOKEN" "$ADMIN_HOST/api/v1/regions?limit=1" \
  | jq -r '.data[0].id // empty')
if [[ -z "$PLAN_ID" || -z "$REGION_ID" ]]; then
  echo "ERROR: could not resolve Starter plan_id or region_id (plan=$PLAN_ID region=$REGION_ID)" >&2
  exit 1
fi

CLIENT_RESP=$(curl -fsSL -X POST "$ADMIN_HOST/api/v1/tenants" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$TENANT_NAME\",\"primary_email\":\"$TENANT_NAME@example.test\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\",\"cpu_limit_override\":2,\"memory_limit_override\":4}")
TENANT_ID=$(echo "$CLIENT_RESP" | jq -r '.data.id')

if [[ -z "$TENANT_ID" || "$TENANT_ID" == "null" ]]; then
  echo "ERROR: client create failed: $CLIENT_RESP" >&2
  exit 1
fi
echo "  Client ID: $TENANT_ID"

cleanup() {
  if [[ -n "$TENANT_ID" && "$TENANT_ID" != "null" ]]; then
    echo "→ Cleanup: deleting client $TENANT_ID"
    curl -fsSL -X DELETE "$ADMIN_HOST/api/v1/tenants/$TENANT_ID" \
      -H "Authorization: Bearer $TOKEN" >/dev/null || true
  fi
}
trap cleanup EXIT

# Tenants are created pending+unprovisioned (no auto-provision). Explicitly
# provision and wait for status=active before any tenant-scoped op — this also
# brings up the namespace + ResourceQuota the assertions below depend on.
echo "→ Provisioning tenant (waiting for status=active)..."
curl -sk -X POST "$ADMIN_HOST/api/v1/admin/tenants/$TENANT_ID/provision" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1 || true
PROV_OK=0
for i in $(seq 1 45); do
  if curl -sk "$ADMIN_HOST/api/v1/tenants/$TENANT_ID" -H "Authorization: Bearer $TOKEN" \
       | grep -q '"status":"active"'; then
    PROV_OK=1; break
  fi
  sleep 4
done
if [[ "$PROV_OK" -ne 1 ]]; then
  echo "ERROR: tenant $TENANT_ID did not reach status=active within 180s" >&2
  exit 1
fi

# Re-read the namespace now that provisioning has created it.
NAMESPACE=$(curl -sk "$ADMIN_HOST/api/v1/tenants/$TENANT_ID" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.data.kubernetesNamespace')
echo "  namespace: $NAMESPACE"

# Wait for namespace to be ready
echo "→ Waiting for namespace to be ready..."
for i in $(seq 1 30); do
  if k get ns "$NAMESPACE" &>/dev/null; then
    break
  fi
  sleep 2
done

# ─── Assertion 1+2+3: ResourceQuota shape ───────────────────────────────────
echo "→ Asserting ResourceQuota shape..."
QUOTA_JSON=$(k get resourcequota "${NAMESPACE}-quota" -n "$NAMESPACE" -o json 2>/dev/null || echo '{}')

if echo "$QUOTA_JSON" | jq -e '.spec.hard."requests.cpu"' >/dev/null; then
  pass "Quota enforces requests.cpu"
else
  fail "Quota does not enforce requests.cpu"
fi

if echo "$QUOTA_JSON" | jq -e '.spec.hard."limits.memory"' >/dev/null; then
  pass "Quota enforces limits.memory"
else
  fail "Quota does not enforce limits.memory"
fi

if echo "$QUOTA_JSON" | jq -e '.spec.hard."limits.cpu"' >/dev/null; then
  fail "Quota STILL enforces limits.cpu (should be dropped)"
else
  pass "Quota does NOT enforce limits.cpu (Burstable model correct)"
fi

# ─── Assertion 4: deploy a multi-component test app ─────────────────────────
# /catalog/entries?code=<x> was removed (2026-06 restructure) → use the /catalog
# list endpoint. Prefer a multi-component app (nextcloud/wordpress) but fall back
# to ANY application-type entry, so the QoS check runs against whatever catalog is
# synced on the target cluster (DEV/staging carry different seed sets).
echo "→ Looking up a multi-component application catalog entry..."
NC_ID=$(curl -fsSL "$ADMIN_HOST/api/v1/catalog" -H "Authorization: Bearer $TOKEN" | jq -r '
  ([.data[] | select((.code // "") | test("nextcloud|wordpress"))] | .[0].id)
  // ([.data[] | select(.type == "application")] | .[0].id)
  // empty')

if [[ -z "$NC_ID" ]]; then
  # No application-type (multi-component) entry in the catalog. Since the 2026-07
  # catalog split, self-contained app stacks (Nextcloud/WordPress/…) live in the
  # opt-in community catalog, NOT the default primitives-only catalog — so a fresh
  # cluster (the VM test tier and future staging) has none. Skip the multi-component
  # + plan-cap-at-admission assertions (they require a deployable app stack) rather
  # than fail; the quota-SHAPE assertions above are the core burstable-QoS check and
  # still run. Re-enable by adding the community catalog to the target cluster
  # (Applications → Repositories) or seeding an app stack.
  echo "SKIP: no application-type entry in catalog (app stacks are community-only) — skipping multi-component + plan-cap assertions"
  DEP_ID=""
else
  echo "→ Deploying multi-component app with cpu=1 (was failing before ADR-037)..."
  DEPLOY_RESP=$(curl -fsSL -X POST "$ADMIN_HOST/api/v1/tenants/$TENANT_ID/deployments" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"catalog_entry_id\":\"$NC_ID\",\"name\":\"qos-app\",\"cpu_request\":\"1\",\"memory_request\":\"1Gi\"}")
  DEP_ID=$(echo "$DEPLOY_RESP" | jq -r '.data.id // empty')

  if [[ -z "$DEP_ID" ]]; then
    fail "Deployment creation failed: $(echo "$DEPLOY_RESP" | jq -r '.error // .')"
  else
    pass "Multi-component deployment accepted by quota (was rejected before ADR-037)"

    # Wait for pods to schedule
    sleep 10

    # Sum the requests.cpu of all containers in the namespace's tenant pods.
    SUM_CPU_MILLI=$(k get pods -n "$NAMESPACE" -l 'platform.io/managed-by!=file-manager' -o json | \
      jq '[.items[].spec.containers[].resources.requests.cpu // "0"] | map(
        if endswith("m") then (.[:-1] | tonumber) else (tonumber * 1000) end
      ) | add')

    if [[ -n "$SUM_CPU_MILLI" && "$SUM_CPU_MILLI" -le 1000 ]]; then
      pass "Sum of tenant container requests.cpu = ${SUM_CPU_MILLI}m ≤ 1000m budget"
    else
      fail "Sum of tenant container requests.cpu = ${SUM_CPU_MILLI}m exceeds 1000m budget"
    fi

    # No container has limits.cpu
    HAS_CPU_LIMITS=$(k get pods -n "$NAMESPACE" -l 'platform.io/managed-by!=file-manager' -o json | \
      jq '[.items[].spec.containers[].resources.limits.cpu // null] | map(select(. != null)) | length')

    if [[ "$HAS_CPU_LIMITS" -eq 0 ]]; then
      pass "No tenant container has limits.cpu set (Burstable for CPU)"
    else
      fail "$HAS_CPU_LIMITS tenant container(s) still have limits.cpu (should be unset)"
    fi

    # Every container has limits.memory == requests.memory
    MEM_GUARANTEED=$(k get pods -n "$NAMESPACE" -l 'platform.io/managed-by!=file-manager' -o json | \
      jq '[.items[].spec.containers[] | (.resources.requests.memory == .resources.limits.memory)] | all')

    if [[ "$MEM_GUARANTEED" == "true" ]]; then
      pass "Every tenant container is Guaranteed for memory (requests == limits)"
    else
      fail "Some tenant containers have requests.memory != limits.memory"
    fi

    # ─── Assertion 6: /resource-breakdown endpoint ────────────────────────
    echo "→ Verifying /resource-breakdown API..."
    BREAKDOWN=$(curl -fsSL "$ADMIN_HOST/api/v1/tenants/$TENANT_ID/deployments/$DEP_ID/resource-breakdown" \
      -H "Authorization: Bearer $TOKEN")
    COMP_COUNT=$(echo "$BREAKDOWN" | jq -r '.data.components | length')
    QOS_CPU=$(echo "$BREAKDOWN" | jq -r '.data.qosModel.cpu')
    QOS_MEM=$(echo "$BREAKDOWN" | jq -r '.data.qosModel.memory')

    if [[ "$COMP_COUNT" -gt 0 ]]; then
      pass "/resource-breakdown returned $COMP_COUNT components"
    else
      fail "/resource-breakdown returned no components"
    fi

    if [[ "$QOS_CPU" == "burstable" && "$QOS_MEM" == "guaranteed" ]]; then
      pass "/resource-breakdown reports qosModel: cpu=burstable, memory=guaranteed"
    else
      fail "/resource-breakdown qosModel mismatch: cpu=$QOS_CPU, memory=$QOS_MEM"
    fi
  fi
fi

# ─── Assertion 5: Plan cap enforced at pod-admission (ResourceQuota) ─────────
# The plan cap is NOT a synchronous deploy-API 4xx. The deploy API accepts the
# spec and creates the Deployment; the tenant ResourceQuota then blocks the
# ReplicaSet's pods at admission, surfacing as a `FailedCreate` "exceeded quota"
# event that the reconciler turns into deployment status=failed
# (k8s-deployer.ts formatQuotaExceededMessage). Assert on that real path — an
# over-alloc that pushes namespace requests.cpu past the 2-core cap.
if [[ -n "${DEP_ID:-}" && -n "$NC_ID" ]]; then
  echo "→ Asserting plan cap rejects over-allocation at pod-admission..."
  OVER_RESP=$(curl -sS -X POST "$ADMIN_HOST/api/v1/tenants/$TENANT_ID/deployments" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"catalog_entry_id\":\"$NC_ID\",\"name\":\"qos-over\",\"cpu_request\":\"5\",\"memory_request\":\"1Gi\"}" \
    -w '\n%{http_code}')
  OVER_STATUS=$(echo "$OVER_RESP" | tail -1)
  OVER_DEP_ID=$(echo "$OVER_RESP" | sed '$d' | jq -r '.data.id // empty')

  if [[ "$OVER_STATUS" -ge 400 && "$OVER_STATUS" -lt 500 ]]; then
    # Defensive: a synchronous pre-admission rejection is also acceptable.
    pass "Plan cap rejected over-allocation synchronously (HTTP $OVER_STATUS)"
  elif [[ "$OVER_STATUS" -ge 200 && "$OVER_STATUS" -lt 300 ]]; then
    # Expected path: accepted, then quota-blocked at admission. Poll (up to
    # ~120s) for the FailedCreate "exceeded quota" event on the over-alloc
    # ReplicaSet, or the reconciler-surfaced quota message on the deployment.
    QUOTA_BLOCKED=0
    for _ in $(seq 1 30); do
      EVT=$(k get events -n "$NAMESPACE" -o json 2>/dev/null | jq -r \
        '[.items[] | select(.reason=="FailedCreate" and ((.message // "") | test("exceeded quota")))] | length')
      if [[ "${EVT:-0}" -ge 1 ]]; then QUOTA_BLOCKED=1; break; fi
      if [[ -n "$OVER_DEP_ID" ]]; then
        DJSON=$(curl -sk "$ADMIN_HOST/api/v1/tenants/$TENANT_ID/deployments/$OVER_DEP_ID" \
          -H "Authorization: Bearer $TOKEN" 2>/dev/null)
        if echo "$DJSON" | grep -qi 'exceeded quota'; then QUOTA_BLOCKED=1; break; fi
      fi
      sleep 4
    done
    if [[ "$QUOTA_BLOCKED" -eq 1 ]]; then
      pass "Plan cap rejected over-allocation at pod-admission (ResourceQuota: exceeded quota)"
    else
      fail "Over-allocation neither rejected synchronously nor blocked by ResourceQuota within 120s (HTTP $OVER_STATUS)"
    fi
    # Remove the over-alloc deployment so it doesn't linger past the test.
    if [[ -n "$OVER_DEP_ID" ]]; then
      curl -sk -X DELETE "$ADMIN_HOST/api/v1/tenants/$TENANT_ID/deployments/$OVER_DEP_ID" \
        -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
    fi
  else
    fail "Unexpected response creating over-allocation deployment (HTTP $OVER_STATUS)"
  fi
fi

# ─── Summary ────────────────────────────────────────────────────────────────
echo
echo "─────────────────────────────────────────────"
echo "PASS: $PASS  FAIL: $FAIL"
echo "─────────────────────────────────────────────"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
