#!/usr/bin/env bash
# integration-traffic-scopes.sh — every traffic scope answers with DATA.
#
# WHY THIS EXISTS. The traffic tabs shipped with every individual view blank:
# pick a node, a tenant, a pod or a route and the chart was empty, while the
# breakdown it was chosen from was full. The whole suite was green throughout,
# because it ran against a DEV cluster holding one tenant and no workloads —
# so "the page renders without an error" was satisfied by an empty page, and
# "the table has rows" by the cluster fallback.
#
# Two rules follow from that, and this script exists to enforce them:
#
#   1. Assert DATA, not the absence of errors. A scope that returns zero
#      series here is a failure, not a quiet pass.
#   2. Assert the ROUND TRIP. Take the key the subject picker offers, send it
#      back as `subject`, and require series. That is the exact step that was
#      broken — the picker returned row ids carrying a direction prefix
#      (`out:sv1`), and `node="out:sv1"` matches nothing.
#
# It provisions its own tenant, serves a real host, drives real requests at
# it, waits for a scrape, then interrogates every scope.
#
# ENV (same shape as the other suites; integration-all supplies these):
#   ADMIN_HOST / ADMIN_EMAIL / ADMIN_PASSWORD (required)
#   SSH_KEY (default ~/hosting-platform.key) · STAGING_SSH_HOST / SSH_HOST
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/integration-env.sh"
set -uo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.$(resolve_platform_apex)}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -q}"
[[ -z "$ADMIN_PASSWORD" ]] && { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

CONTROL_HOST="${STAGING_SSH_HOST:-${SSH_HOST:-192.0.2.58}}"
CONTROL_HOST="${CONTROL_HOST#*@}"

PASS=0; FAIL=0
pass() { echo "PASS: $*"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }
k() { ssh $SSH_OPTS -i "$SSH_KEY" "root@${CONTROL_HOST}" kubectl "$@"; }
api() { curl -sk -H "Authorization: Bearer $TOKEN" "$@"; }

TOKEN=$(curl -fsSk -X POST "$ADMIN_HOST/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | jq -r '.data.token')
[[ -z "$TOKEN" || "$TOKEN" == "null" ]] && { echo "ERROR: login failed" >&2; exit 2; }

TMP="$(mktemp -d)"
TID=""
cleanup() {
  rm -rf "$TMP"
  [[ -n "$TID" ]] && curl -sk -X DELETE "$ADMIN_HOST/api/v1/tenants/$TID" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1
  return 0
}
trap cleanup EXIT

# ── 1. a tenant that actually serves something ───────────────────────────────
echo "→ 1. provision a tenant with a served host"
PLAN_ID=$(api "$ADMIN_HOST/api/v1/plans?limit=20" | jq -r '.data[0].id // empty')
REGION_ID=$(api "$ADMIN_HOST/api/v1/regions?limit=20" | jq -r '.data[0].id // empty')
[[ -z "$PLAN_ID" || -z "$REGION_ID" ]] && { echo "ERROR: no plan/region" >&2; exit 1; }

TNAME="traffic-scopes-$(date +%s)"
TID=$(curl -sk -X POST "$ADMIN_HOST/api/v1/tenants" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$TNAME\",\"primary_email\":\"$TNAME@example.test\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\"}" \
  | jq -r '.data.id // empty')
[[ -z "$TID" ]] && { echo "ERROR: tenant create failed" >&2; exit 1; }

curl -sk -X POST "$ADMIN_HOST/api/v1/admin/tenants/$TID/provision" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1
for _ in $(seq 1 45); do
  api "$ADMIN_HOST/api/v1/tenants/$TID" | grep -q '"status":"active"' && break; sleep 4
done
NS=$(api "$ADMIN_HOST/api/v1/tenants/$TID" | jq -r '.data.kubernetesNamespace')
[[ -z "$NS" || "$NS" == "null" ]] && { fail "tenant never provisioned"; echo "RESULTS: $PASS passed, $((FAIL+1)) failed"; exit 1; }
pass "tenant provisioned into $NS"

CAT_ID=$(api "$ADMIN_HOST/api/v1/catalog?limit=200" \
  | jq -r '[.data[] | select(((.type//"")|ascii_downcase)=="static")][0].id // empty')
DEP_ID=$(curl -sk -X POST "$ADMIN_HOST/api/v1/tenants/$TID/deployments" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"catalog_entry_id\":\"$CAT_ID\",\"name\":\"tsite\"}" \
  | jq -r '.data.id // empty')
HOST="tscope-${TID:0:8}.example.test"
curl -sk -X POST "$ADMIN_HOST/api/v1/tenants/$TID/domains" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"domain_name\":\"$HOST\",\"dns_mode\":\"cname\",\"deployment_id\":\"$DEP_ID\"}" >/dev/null 2>&1
for _ in $(seq 1 20); do
  k get ingressroute -n "$NS" -o name 2>/dev/null | grep -q . && break; sleep 4
done
k get ingressroute -n "$NS" -o name 2>/dev/null | grep -q . \
  && pass "IngressRoute built for $HOST" || fail "no IngressRoute — route scope will be untestable"

# ── 2. move real bytes ───────────────────────────────────────────────────────
# Through the ingress, with the Host header, so BOTH Traefik's per-service
# counters and the pod's own interface counters advance.
echo "→ 2. drive real traffic at the host"
# --resolve, not -H Host:. Over TLS the Host header does not set SNI, so
# Traefik matched its default router and the tenant's own route never saw a
# request — which then reads as "tenant/requests has no data" and looks
# exactly like a product bug. Verified: with -H there were zero
# tenant-prefixed Traefik services in the store afterwards.
ssh $SSH_OPTS -i "$SSH_KEY" "root@${CONTROL_HOST}" \
  "for i in \$(seq 1 200); do curl -sk -o /dev/null --resolve '$HOST:443:127.0.0.1' 'https://$HOST/' ; done" >/dev/null 2>&1
SEEN=$(ssh $SSH_OPTS -i "$SSH_KEY" "root@${CONTROL_HOST}" \
  "curl -sk -o /dev/null -w '%{http_code}' --resolve '$HOST:443:127.0.0.1' 'https://$HOST/'" 2>/dev/null)
if [[ -n "$SEEN" && "$SEEN" != "000" ]]; then
  pass "first burst reached $HOST (status $SEEN)"
else
  fail "could not reach $HOST at all — the scopes below cannot be judged"
fi

# A SECOND burst after a gap, and this is not belt-and-braces. A counter that
# has just appeared has no earlier sample to difference against, so its rate
# is zero however much traffic created it. One burst against a brand-new
# tenant therefore reads as "this scope has no data" — which is exactly what
# this suite is supposed to mean something by. Two bursts either side of a
# scrape guarantee an increase between two samples.
echo "   waiting 90s so the new counter is scraped once…"
sleep 90
ssh $SSH_OPTS -i "$SSH_KEY" "root@${CONTROL_HOST}" \
  "for i in \$(seq 1 200); do curl -sk -o /dev/null --resolve '$HOST:443:127.0.0.1' 'https://$HOST/' ; done" >/dev/null 2>&1
pass "second burst sent"
echo "   waiting 120s for the rate window to span both bursts…"
sleep 120

# ── 3. every scope answers with data ─────────────────────────────────────────
FROM=$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)
TO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BASE="$ADMIN_HOST/api/v1/admin/monitoring/traffic"

series_count() { # scope metric [subject] [pod]
  local url="$BASE/series?from=$FROM&to=$TO&scope=$1&metric=$2&direction=both"
  [[ -n "${3:-}" ]] && url="$url&subject=$3"
  [[ -n "${4:-}" ]] && url="$url&pod=$4"
  api "$url" | jq '[.data.series[]? | select([.points[]? | select(. != null and . > 0)] | length > 0)] | length' 2>/dev/null || echo 0
}
subjects_json() { # scope metric [subject]
  local url="$BASE/subjects?from=$FROM&to=$TO&scope=$1&metric=$2"
  [[ -n "${3:-}" ]] && url="$url&subject=$3"
  api "$url"
}

echo "→ 3. breakdowns carry data"
for combo in "cluster traffic" "node traffic" "tenant traffic" "pod traffic" "route traffic" \
             "cluster requests" "tenant requests" "route requests" \
             "cluster latency" "tenant latency" "route latency"; do
  set -- $combo
  n=$(series_count "$1" "$2")
  if [[ "${n:-0}" -gt 0 ]]; then pass "$1/$2 breakdown: $n series with data"
  else fail "$1/$2 breakdown returned NO series with data"; fi
done

# ── 4. the round trip: a key from the picker must select its subject ─────────
# This is the assertion the shipped bug walked straight past.
echo "→ 4. a picker key selects the thing it names"
for scope in node tenant route; do
  SJ=$(subjects_json "$scope" traffic)
  KEY=$(echo "$SJ" | jq -r '.data.subjects[0].key // empty')
  NAME=$(echo "$SJ" | jq -r '.data.subjects[0].name // empty')
  if [[ -z "$KEY" ]]; then fail "$scope: the picker offered nothing"; continue; fi
  case "$KEY" in
    out:*|in:*) fail "$scope: picker key carries a direction prefix ($KEY)" ;;
    *)          pass "$scope: picker key is an identity ($NAME)" ;;
  esac
  n=$(series_count "$scope" traffic "$KEY")
  if [[ "${n:-0}" -gt 0 ]]; then pass "$scope: selecting it returns $n series"
  else fail "$scope: selecting '$NAME' returned NO data (key=$KEY)"; fi
done

# ── 5. a tenant key opens that tenant's pods ─────────────────────────────────
echo "→ 5. tenant → pods"
TKEY=$(subjects_json tenant traffic | jq -r --arg ns "$NS" '[.data.subjects[] | select(.key==$ns)][0].key // .data.subjects[0].key // empty')
PODS=$(subjects_json pod traffic "$TKEY")
PN=$(echo "$PODS" | jq '[.data.subjects[]?] | length')
if [[ "${PN:-0}" -gt 0 ]]; then pass "tenant $TKEY lists $PN pod(s)"
else fail "tenant $TKEY lists NO pods"; fi
PKEY=$(echo "$PODS" | jq -r '.data.subjects[0].key // empty')
if [[ -n "$PKEY" ]]; then
  n=$(series_count pod traffic "$TKEY" "$PKEY")
  [[ "${n:-0}" -gt 0 ]] && pass "pod $PKEY returns $n series" || fail "pod $PKEY returned NO data"
fi

# ── 6. names are names, not ids ──────────────────────────────────────────────
echo "→ 6. subjects read as names"
TN=$(subjects_json tenant traffic | jq -r '[.data.subjects[].name] | join(" | ")')
case "$TN" in
  *kubernetescrd*) fail "tenant picker shows Traefik service ids: $TN" ;;
  *)               pass "tenant picker shows names" ;;
esac
# The identity must not change when the metric does — that silently
# invalidated whatever was selected.
# Not "the top key matches" — the two metrics rank different populations, so
# comparing their first entries compares different tenants and fails for no
# reason. The invariant is that a tenant's identity is a NAMESPACE whichever
# metric is selected, so that switching metric does not invalidate whatever
# was chosen.
BAD_KEYS=""
for m in traffic requests latency; do
  K=$(subjects_json tenant "$m" | jq -r '[.data.subjects[].key] | map(select(startswith("tenant-") | not)) | join(",")')
  [[ -n "$K" ]] && BAD_KEYS="$BAD_KEYS $m:[$K]"
done
if [[ -z "$BAD_KEYS" ]]; then
  pass "a tenant's key is a namespace under traffic, requests and latency"
else
  fail "tenant keys are not namespaces under every metric:$BAD_KEYS"
fi
RN=$(subjects_json route traffic | jq -r '[.data.subjects[].name] | join(" | ")')
case "$RN" in
  *kubernetescrd*) fail "route picker shows raw service ids: $RN" ;;
  *)               pass "route picker shows readable names" ;;
esac

echo "════════════════════════════════════"
echo "  RESULTS: $PASS passed, $FAIL failed"
echo "════════════════════════════════════"
[[ "$FAIL" -eq 0 ]]
