#!/usr/bin/env bash
# integration-cleanup.sh — nuke leftover test resources via the OFFICIAL
# tenant-lifecycle API (NOT raw kubectl).
#
# Why this exists:
#   The `tenant-reaper-test-*`, `tenant-bundle-test-*`, `tenant-ingress-
#   test-*` etc. namespaces accumulate when an integration scenario
#   fails partway and the explicit DELETE never runs. Each leaves a
#   PVC + Longhorn replicas committed against the system-node storage
#   budget. Three orphan namespaces accumulated to ~150 GiB of
#   storageScheduled on staging (observed 2026-05-04), enough to
#   block postgres-2 from creating its replica with "insufficient
#   storage" precheck failures.
#
# Why use the lifecycle API + not raw kubectl:
#   The platform's tenant-lifecycle hook chain handles ordered cleanup
#   (DNS records → backup bundles → secrets → namespace → PV reclaim →
#   Longhorn volume delete). Raw `kubectl delete ns` skips the hook
#   chain and leaves orphan PVs / Longhorn volumes that the reconciler
#   has to mop up later (and may fail to). The lifecycle DELETE is
#   what production operators use, so the test cleanup must too.
#
# Usage:
#   ADMIN_PASSWORD=… ./scripts/integration-cleanup.sh
#   # or for non-interactive (CI):
#   ADMIN_PASSWORD=… DRY_RUN=1 ./scripts/integration-cleanup.sh

set -uo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.example.test}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
DRY_RUN="${DRY_RUN:-0}"
[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'
log()  { printf '\n%b═══ %s ═══%b\n' "$CYAN" "$*" "$RESET"; }
ok()   { printf '%b✓%b %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%b⚠%b %s\n' "$YELLOW" "$RESET" "$*"; }
fail() { printf '%b✗%b %s\n' "$RED" "$RESET" "$*"; exit 1; }

log "logging in"
TOKEN=$(curl -sS -k -X POST "$ADMIN_HOST/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["data"]["token"])')
[[ -n "$TOKEN" ]] || fail "login failed"
ok "logged in"

log "discovering test clients via /api/v1/tenants?limit=100"
# Match by test-email domain + name signature (see the matcher below).
# NOTE: the route is /api/v1/tenants — NOT /api/v1/admin/tenants (that 404s).
# The old /admin/ prefix made this discovery silently return a 404 body, so
# the matcher always found 0 clients and cleanup was inert — which is exactly
# why stale test tenants accumulated and tripped the leak guard every run.
curl -sS -k -H "Authorization: Bearer $TOKEN" \
  "$ADMIN_HOST/api/v1/tenants?limit=100" \
  > /tmp/cleanup-clients.json

TEST_CIDS=$(python3 <<'EOF'
import json, re
d = json.load(open('/tmp/cleanup-clients.json'))
items = d.get('data', []) or []
# Match the TWO universal signatures every integration suite stamps on its
# tenants, NOT a brittle exact-name list:
#   (a) a primaryEmail on the RFC-reserved `example.test` test domain — every
#       suite uses it (`pvc-l-<ts>@example.test`, `mqe2e-<ts>@example.test`, …);
#   (b) a name carrying a test token AND ending in a `date +%s` epoch (10 digits).
# The OLD pattern required the literal "<Subject> Test <digits>" and so MISSED
# every suite whose middle token wasn't "Test" — "PVC Test L …", "Drain HA …",
# "Drain LOCAL …", "Firewall E2E …", "Grow E2E …", "Tier Flip E2E …",
# "MboxQuota E2E …", "cd-cmp-…" — which is exactly how 9 stale tenants
# accumulated (2026-06-22..25) and tripped the runner's leak guard. Match EITHER
# signature; NEVER the SYSTEM tenant (isSystem) or a tenant off the test domain.
EMAIL_TEST = re.compile(r'@(?:[a-z0-9-]+\.)*example\.test$', re.I)
NAME_TEST = re.compile(
    r'(?i)\b(Reaper|Bundle|Ingress|Mail|Mbox|Drain|Tier|Grow|Lifecycle|Pvc|'
    r'Provision|Integration|Firewall|Snapshot|Quota|Storage|Backup|Restore|'
    r'Coturn|Single-Node|Guard|Race|Flip|E2E|cd|fw)\b.*\b\d{10}\s*$')
def is_test(c):
    if c.get('isSystem'):
        return False
    email = c.get('primaryEmail') or ''
    name = c.get('name') or ''
    return bool(EMAIL_TEST.search(email)) or bool(NAME_TEST.search(name))
hits = [c for c in items if is_test(c)]
for c in hits:
    print(f"{c['id']}\t{c['name']}")
EOF
)

COUNT=$(echo "$TEST_CIDS" | grep -c $'\t' || true)
if [[ "$COUNT" -eq 0 ]]; then
  ok "no test clients matched the integration-cleanup naming pattern"
  exit 0
fi

log "found $COUNT test client(s) matching integration patterns:"
echo "$TEST_CIDS" | sed 's/^/  /'

if [[ "$DRY_RUN" = "1" ]]; then
  warn "DRY_RUN=1 — would DELETE these clients via /api/v1/tenants/:id"
  exit 0
fi

read -r -p "Delete these $COUNT test client(s) via the lifecycle DELETE API? [y/N] " confirm
case "$confirm" in
  [yY]|[yY][eE][sS]) ;;
  *) warn "aborted by operator"; exit 0 ;;
esac

log "deleting via official tenant-lifecycle DELETE — runs the full hook cascade"
DELETED=0
FAILED=0
while IFS=$'\t' read -r cid name; do
  [[ -n "$cid" ]] || continue
  # -m 90 so a slow delete (the cascade waits on Longhorn PV release) can't hang
  # the runner's non-interactive cleanup pass; the server completes the delete
  # server-side even if the client times out. Sequential + a brief pause so we
  # don't fire many heavy cascades at once. 404 = already gone = success.
  HTTP=$(curl -sS -k -m 90 -o /tmp/cleanup-resp.json -w '%{http_code}' \
    -X DELETE "$ADMIN_HOST/api/v1/tenants/$cid" \
    -H "Authorization: Bearer $TOKEN" || echo 000)
  if [[ "$HTTP" =~ ^2 || "$HTTP" == "404" ]]; then
    ok "deleted $cid ($name)$([[ "$HTTP" == "404" ]] && echo ' (already gone)')"
    DELETED=$((DELETED+1))
  else
    warn "DELETE $cid → HTTP=$HTTP body=$(head -c 200 /tmp/cleanup-resp.json 2>/dev/null)"
    FAILED=$((FAILED+1))
  fi
  sleep 2
done <<< "$TEST_CIDS"

log "result: $DELETED deleted, $FAILED failed (cascade may still be in progress; re-run if needed)"

# ─── Global-state sanity sweep ───────────────────────────────────────
# Suites that mutate global toggles (OIDC proxy gate, Flux suspend
# during PITR, oauth2-proxy provider config) must restore them in
# their EXIT trap. If a trap fires too late or never fires, the next
# suite locks operators out. Catch it here and reset.
log "global-state sanity sweep"

SETTINGS=$(curl -sS -k -H "Authorization: Bearer $TOKEN" "$ADMIN_HOST/api/v1/admin/oidc/settings" 2>/dev/null || echo '{}')
PROTECT_ADMIN=$(echo "$SETTINGS" | python3 -c "import json,sys;
try: print(json.load(sys.stdin).get('data',{}).get('protectAdminViaProxy', False))
except: print('?')" 2>/dev/null)
PROTECT_TENANT=$(echo "$SETTINGS" | python3 -c "import json,sys;
try: print(json.load(sys.stdin).get('data',{}).get('protectTenantViaProxy', False))
except: print('?')" 2>/dev/null)
PROVIDERS=$(curl -sS -k -H "Authorization: Bearer $TOKEN" "$ADMIN_HOST/api/v1/admin/oidc/providers" 2>/dev/null \
  | python3 -c "import json,sys;
try:
  d=json.load(sys.stdin).get('data',[]) or []
  print(len([p for p in d if p.get('enabled')]))
except: print(0)" 2>/dev/null)

if [[ "$PROTECT_ADMIN" == "True" && "${PROVIDERS:-0}" -eq 0 ]]; then
  warn "OIDC proxy ON for admin but ZERO enabled providers → admin panel locked out; clearing"
  curl -sS -k -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"protect_admin_via_proxy":false,"protect_tenant_via_proxy":false,"disable_local_auth_admin":false,"disable_local_auth_tenant":false}' \
    "$ADMIN_HOST/api/v1/admin/oidc/settings" >/dev/null 2>&1 || true
  ok "reset admin proxy gate"
elif [[ "$PROTECT_TENANT" == "True" && "${PROVIDERS:-0}" -eq 0 ]]; then
  warn "OIDC proxy ON for tenant but ZERO enabled providers → tenant panel locked out; clearing"
  curl -sS -k -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"protect_admin_via_proxy":false,"protect_tenant_via_proxy":false,"disable_local_auth_admin":false,"disable_local_auth_tenant":false}' \
    "$ADMIN_HOST/api/v1/admin/oidc/settings" >/dev/null 2>&1 || true
  ok "reset tenant proxy gate"
else
  ok "OIDC proxy gates consistent: admin=${PROTECT_ADMIN} tenant=${PROTECT_TENANT} enabled-providers=${PROVIDERS}"
fi

PANEL=$(curl -sk -m 10 -o /dev/null -w '%{http_code}' "${ADMIN_HOST}/" 2>/dev/null || echo "000")
if [[ "$PANEL" == "200" ]]; then
  ok "admin panel reachable (200)"
else
  warn "admin panel returned ${PANEL} after cleanup — manual intervention may be needed"
fi

[[ "$FAILED" -eq 0 ]]
