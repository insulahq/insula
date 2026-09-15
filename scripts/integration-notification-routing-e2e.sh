#!/usr/bin/env bash
# End-to-end assertions for the notification routing overhaul.
#
# What this covers, against the real management API:
#   1. Channel policy is DERIVED, not "everything on". All 53 categories used
#      to ship with in_app + email + ntfy; 75% of production notification
#      traffic was SLO alerts and the largest single source was
#      admin.slo_alert_resolved at 130 deliveries a fortnight, each emailed AND
#      pushed to say something had stopped being broken.
#   2. ntfy is barred for tenant audiences. It is ONE shared operator topic with
#      no per-user leg, so every tenant-facing category was pushing tenant data
#      to the operator's phone.
#   3. The new categories exist and are wired.
#   4. No delivery in the recent window was dropped for a render failure. That
#      is the defect that cost `subscription.renewed` 16 emails in silence:
#      status='skipped' raises no alert and is not in the retry scan.
#   5. The tenant-issues endpoint answers, so the tenants-table badge and the
#      detail banner have a source.
#
# USAGE: ADMIN_PASSWORD=<…> ADMIN_HOST=https://admin.<env>.example.test \
#        ./scripts/integration-notification-routing-e2e.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/integration-env.sh
[[ -f "$SCRIPT_DIR/lib/integration-env.sh" ]] && source "$SCRIPT_DIR/lib/integration-env.sh" && load_integration_env

# ADMIN_HOST is a URL here, as integration.env sets it. Normalise both forms:
# integration-waf-api-scope.sh wants a bare hostname and builds https://$ADMIN_HOST,
# which produced https://https://… and HTTP 000 on every probe for months.
ADMIN_HOST="${ADMIN_HOST:-https://admin.$(resolve_platform_apex)}"
case "$ADMIN_HOST" in http://*|https://*) ;; *) ADMIN_HOST="https://$ADMIN_HOST" ;; esac
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"

[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; RESET='\033[0m'
log()  { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail() { printf '  %b✗%b %s\n' "$RED"   "$RESET" "$*"; failed=$((failed+1)); }
passed=0; failed=0

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log "Authenticating against $ADMIN_HOST"
TOKEN="$(curl -sk -X POST "$ADMIN_HOST/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | jq -r '.data.token // empty')"
[[ -n "$TOKEN" ]] || { echo "ERROR: login failed (no data.token)" >&2; exit 1; }

api() { curl -sk -H "Authorization: Bearer $TOKEN" "$ADMIN_HOST$1"; }

# ── 1. Categories ──────────────────────────────────────────────────────
log "Fetching notification categories"
api '/api/v1/admin/notifications/categories?limit=100' > "$TMP/cats.json"
CAT_COUNT="$(jq '[.data[]] | length' "$TMP/cats.json" 2>/dev/null || echo 0)"
if [[ "$CAT_COUNT" -gt 0 ]]; then
  ok "categories endpoint returned $CAT_COUNT sources"
else
  fail "categories endpoint returned nothing — every assertion below would pass vacuously"
  echo "RESULTS: $passed passed, $((failed+1)) failed"; exit 1
fi

# An ambient category must not leave the platform UI.
RESOLVED_CH="$(jq -r '[.data[] | select(.id=="admin.slo_alert_resolved") | .defaultChannels[]] | sort | join(",")' "$TMP/cats.json")"
if [[ "$RESOLVED_CH" == "in_app" ]]; then
  ok "admin.slo_alert_resolved is in_app only (was in_app,email,ntfy — 130 deliveries/14d)"
else
  fail "admin.slo_alert_resolved channels are [$RESOLVED_CH], expected in_app only"
fi

# A routine renewal must stop mailing customers.
ISSUED_CH="$(jq -r '[.data[] | select(.id=="tls.certificate_issued") | .defaultChannels[]] | sort | join(",")' "$TMP/cats.json")"
if [[ "$ISSUED_CH" == "in_app" ]]; then
  ok "tls.certificate_issued is in_app only (routine renewals stop emailing tenants)"
else
  fail "tls.certificate_issued channels are [$ISSUED_CH], expected in_app only"
fi

# ── 2. ntfy must never be on a tenant-audience category ────────────────
LEAKY="$(jq -r '[.data[] | select(.audience=="tenant") | select(.defaultChannels | index("ntfy")) | .id] | join(" ")' "$TMP/cats.json")"
if [[ -z "$LEAKY" ]]; then
  ok "no tenant-audience category routes to ntfy (it is ONE shared operator topic)"
else
  fail "tenant categories still pushing to the operator topic: $LEAKY"
fi

# ── 3. The new categories exist ────────────────────────────────────────
for cat in mailbox.quota_threshold mailbox.quota_exceeded admin.mailbox_quota_fleet \
           tenant.resource_saturation_warning tenant.resource_saturation_critical \
           admin.email_quota_exceeded admin.subscriptions_expiring; do
  if jq -e --arg c "$cat" '.data[] | select(.id==$c)' "$TMP/cats.json" >/dev/null 2>&1; then
    ok "category $cat is seeded"
  else
    fail "category $cat is MISSING"
  fi
done

# ── 4. Nothing was dropped for a render failure ────────────────────────
log "Checking recent deliveries for render failures"
api '/api/v1/admin/notifications/deliveries?limit=100' > "$TMP/deliv.json"
RENDER_FAILS="$(jq '[.data[]? | select((.lastError // "") | test("render_failed"))] | length' "$TMP/deliv.json" 2>/dev/null || echo 0)"
if [[ "$RENDER_FAILS" -eq 0 ]]; then
  ok "no delivery dropped for a render failure (the defect that cost 16 renewal emails)"
else
  fail "$RENDER_FAILS deliveries still dropped with render_failed — the delivery path must DEGRADE, not skip"
fi

# A degraded delivery is fine; an invisible one is not. Report them so a thin
# notification stays a reportable defect rather than a silent success.
DEGRADED="$(jq '[.data[]? | select(.degradedVars != null)] | length' "$TMP/deliv.json" 2>/dev/null || echo 0)"
log "deliveries rendered with missing variables in this window: $DEGRADED"

# ── 5. Tenant issues feed the badge and the banner ─────────────────────
log "Checking the tenant-issues endpoint"
HTTP="$(curl -sk -o "$TMP/issues.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
  "$ADMIN_HOST/api/v1/admin/tenants/issues")"
if [[ "$HTTP" == "200" ]] && jq -e '.data' "$TMP/issues.json" >/dev/null 2>&1; then
  TCOUNT="$(jq '.data | length' "$TMP/issues.json")"
  ok "tenant-issues endpoint answered 200 ($TCOUNT tenant(s) with open issues)"
else
  fail "tenant-issues endpoint returned HTTP $HTTP — the badge and banner have no source"
fi

echo
echo "RESULTS: $passed passed, $failed failed"
[[ "$failed" -eq 0 ]]
