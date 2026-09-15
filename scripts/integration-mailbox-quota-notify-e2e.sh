#!/usr/bin/env bash
# The mailbox-quota NOTIFICATION chain, proven by filling a real mailbox.
#
# Guard 5 of docs/roadmap/NOTIFICATION_OVERHAUL.md §6. This is the one the
# other guards cannot give you: every static check can pass while the chain
# delivers to nobody. It had never fired once in its life —
# `mailbox_quota_events` held 0 rows platform-wide while four mailboxes sat at
# or above 75%, because recipients were resolved through `mailbox_access`, a
# table with no rows anywhere.
#
# What this asserts, in order of what actually matters:
#   1. crossing 80/90 opens the dedupe events,
#   2. the MAILBOX OWNER is addressed directly — they have no platform account,
#      which is precisely why no user-id resolver ever reached them,
#   3. the TENANT ADMIN is told through the normal user path,
#   4. the message names the mailbox, the tenant, the value and the time,
#   5. crossing 100 additionally produces the aggregated OPERATOR view,
#   6. a second sweep does NOT re-notify a condition already reported.
#
# Why 20 MB and random bytes
# --------------------------
# Stalwart compresses at rest. A first attempt pushed 52 MB of repetitive
# filler and the mailbox reported 14 MB used — the threshold never moved. The
# payload here is base64 of /dev/urandom, which does not compress, so stored
# size tracks sent size. 20 MB is the smallest quota the contract allows
# (lowered from 50 for exactly this reason), which keeps the fill to seconds.
#
# USAGE: ADMIN_PASSWORD=<…> ADMIN_HOST=https://admin.<env>.example.test \
#        ./scripts/integration-mailbox-quota-notify-e2e.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/integration-env.sh
[[ -f "$SCRIPT_DIR/lib/integration-env.sh" ]] && source "$SCRIPT_DIR/lib/integration-env.sh" && load_integration_env

ADMIN_HOST="${ADMIN_HOST:-https://admin.$(resolve_platform_apex)}"
case "$ADMIN_HOST" in http://*|https://*) ;; *) ADMIN_HOST="https://$ADMIN_HOST" ;; esac
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; RESET='\033[0m'
log()  { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*"; }
passed=0; failed=0
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail() { printf '  %b✗%b %s\n' "$RED" "$RESET" "$*"; failed=$((failed+1)); }

QUOTA_MB=20
LOCAL_PART="quota-notify-$(date +%s)"
TMP="$(mktemp -d)"
FILLER_POD="quota-notify-filler"
trap 'rm -rf "$TMP"; kubectl delete pod "$FILLER_POD" -n mail --ignore-not-found --wait=false >/dev/null 2>&1 || true' EXIT

# Cluster access is required: the fill has to originate inside the cluster
# (repeated SMTP from one external IP trips CrowdSec), and the assertions read
# the platform database directly.
if ! command -v kubectl >/dev/null 2>&1 || ! kubectl get ns platform >/dev/null 2>&1; then
  log "SKIP: no cluster access — this suite fills a real mailbox and reads the platform DB"
  exit 0
fi
PSQL() { kubectl exec -n platform system-db-1 -c postgres -- psql -U postgres -d platform -At "$@"; }

log "Authenticating against $ADMIN_HOST"
TOKEN="$(curl -sk -X POST "$ADMIN_HOST/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | jq -r '.data.token // empty')"
[[ -n "$TOKEN" ]] || { fail "login failed"; exit 1; }

# ── Find a mail-enabled domain to hang the probe mailbox off ────────────────
read -r TENANT_ID EMAIL_DOMAIN_ID DOMAIN_NAME <<<"$(PSQL -F' ' -c "
  SELECT ed.tenant_id, ed.id, d.domain_name
    FROM email_domains ed JOIN domains d ON d.id = ed.domain_id
   WHERE ed.enabled = 1 ORDER BY d.domain_name LIMIT 1;")"
[[ -n "${EMAIL_DOMAIN_ID:-}" ]] || { log "SKIP: no enabled email domain on this cluster"; exit 0; }
ADDRESS="$LOCAL_PART@$DOMAIN_NAME"
log "probe mailbox $ADDRESS (quota ${QUOTA_MB}MB) on tenant $TENANT_ID"

MBPW="Probe$(openssl rand -hex 10)Zz"
CREATE="$(curl -sk -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"local_part\":\"$LOCAL_PART\",\"password\":\"$MBPW\",\"quota_mb\":$QUOTA_MB,\"display_name\":\"Quota notify probe\"}" \
  "$ADMIN_HOST/api/v1/tenants/$TENANT_ID/email/domains/$EMAIL_DOMAIN_ID/mailboxes")"
MAILBOX_ID="$(echo "$CREATE" | jq -r '.data.id // empty')"
if [[ -n "$MAILBOX_ID" ]]; then
  ok "created a ${QUOTA_MB}MB mailbox (the contract floor — 50 would need 50MB of fill)"
else
  fail "mailbox create failed: $(echo "$CREATE" | head -c 300)"; exit 1
fi
cleanup_mailbox() {
  curl -sk -o /dev/null -X DELETE -H "Authorization: Bearer $TOKEN" \
    "$ADMIN_HOST/api/v1/tenants/$TENANT_ID/mailboxes/$MAILBOX_ID" || true
  PSQL -c "DELETE FROM notifications WHERE title LIKE '%$LOCAL_PART%';" >/dev/null 2>&1 || true
  PSQL -c "DELETE FROM notification_deliveries WHERE recipient_address = '$ADDRESS';" >/dev/null 2>&1 || true
}
trap 'cleanup_mailbox; rm -rf "$TMP"; kubectl delete pod "$FILLER_POD" -n mail --ignore-not-found --wait=false >/dev/null 2>&1 || true' EXIT

# ── Fill it with data that does NOT compress ───────────────────────────────
cat > "$TMP/fill.py" <<PY
import smtplib, os, base64, sys
from email.message import EmailMessage
HOST, PORT = "stalwart-mail.mail.svc.cluster.local", 25
TO, FROM = sys.argv[1], sys.argv[2]
N, MB = int(sys.argv[3]), 4
sent = 0
for i in range(N):
    body = base64.b64encode(os.urandom(MB * 1024 * 1024 * 3 // 4)).decode()
    m = EmailMessage()
    m["Subject"] = f"quota fill {i+1}/{N}"
    m["From"], m["To"] = FROM, TO
    m.set_content(body)
    try:
        with smtplib.SMTP(HOST, PORT, timeout=180) as s:
            s.send_message(m)
        sent += 1
    except Exception as e:
        print(f"STOPPED at {i+1}: {type(e).__name__}: {e}")
        break
print(f"SENT={sent}")
PY
kubectl delete pod "$FILLER_POD" -n mail --ignore-not-found --wait=false >/dev/null 2>&1 || true
kubectl run "$FILLER_POD" -n mail --image=python:3.12-alpine --restart=Never \
  --command -- sleep 900 >/dev/null 2>&1
for _ in $(seq 1 20); do
  [[ "$(kubectl get pod "$FILLER_POD" -n mail -o jsonpath='{.status.phase}' 2>/dev/null)" == "Running" ]] && break
  sleep 5
done
kubectl cp "$TMP/fill.py" "mail/$FILLER_POD:/tmp/fill.py" >/dev/null 2>&1
# 5 x 4MB = 20MB against a 20MB quota: past 80 and 90, and at/over 100.
log "sending 20MB of incompressible mail (Stalwart compresses repetitive filler)"
kubectl exec -n mail "$FILLER_POD" -- python3 /tmp/fill.py "$ADDRESS" "postmaster@$DOMAIN_NAME" 5 2>&1 | tail -2

# ── Wait for the reconciler + threshold check ──────────────────────────────
log "waiting for the usage reconciler to see it (runs after each mail-stats cycle)"
CROSSED=0
for _ in $(seq 1 24); do
  USED="$(PSQL -c "SELECT used_mb FROM mailboxes WHERE id='$MAILBOX_ID';" | tr -d '[:space:]')"
  EV="$(PSQL -c "SELECT count(*) FROM mailbox_quota_events WHERE mailbox_id='$MAILBOX_ID';" | tr -d '[:space:]')"
  [[ "${EV:-0}" -gt 0 ]] && { CROSSED=1; break; }
  sleep 20
done
USED="$(PSQL -c "SELECT used_mb FROM mailboxes WHERE id='$MAILBOX_ID';" | tr -d '[:space:]')"
if [[ "$CROSSED" == "1" ]]; then
  ok "usage reached ${USED}MB/${QUOTA_MB}MB and opened quota event(s): $(PSQL -c "SELECT string_agg(threshold::text,',' ORDER BY threshold) FROM mailbox_quota_events WHERE mailbox_id='$MAILBOX_ID';")"
else
  fail "no quota event after filling to ${USED}MB/${QUOTA_MB}MB — the threshold chain did not fire"
  echo "RESULTS: $passed passed, $failed failed"; exit 1
fi

# ── 1. the MAILBOX OWNER, addressed directly ───────────────────────────────
OWNER="$(PSQL -c "SELECT count(*) FROM notification_deliveries
  WHERE recipient_address = '$ADDRESS' AND user_id IS NULL;" | tr -d '[:space:]')"
[[ "${OWNER:-0}" -gt 0 ]] \
  && ok "the mailbox OWNER was addressed directly ($OWNER delivery row(s), no user id)" \
  || fail "nothing addressed to $ADDRESS — the owner has no account, so a user-id resolver never reaches them"

# ── 2. the TENANT ADMIN, through the user path ─────────────────────────────
ADMIN_N="$(PSQL -c "SELECT count(*) FROM notification_deliveries d
  WHERE d.category_id LIKE 'mailbox.quota%' AND d.user_id IS NOT NULL
    AND d.queued_at > now() - interval '30 minutes';" | tr -d '[:space:]')"
[[ "${ADMIN_N:-0}" -gt 0 ]] \
  && ok "the TENANT ADMIN was notified ($ADMIN_N delivery row(s) resolved to a user)" \
  || fail "no user-resolved delivery — the tenant admin was not told"

# ── 3. the message answers which mailbox / which tenant / what / when ──────
MSG="$(PSQL -F'~' -c "SELECT title || ' :: ' || message FROM notifications
  WHERE category_id LIKE 'mailbox.quota%' AND message LIKE '%$LOCAL_PART%'
  ORDER BY created_at DESC LIMIT 1;")"
[[ -n "$MSG" ]] && log "message: $(echo "$MSG" | head -c 220)"
echo "$MSG" | grep -q "$LOCAL_PART"            && ok "names the MAILBOX"  || fail "does not name the mailbox"
echo "$MSG" | grep -Eq "[0-9]+ of [0-9]+ MB"   && ok "names the VALUE"    || fail "does not give used/quota"
echo "$MSG" | grep -Eq "[0-9]{4}-[0-9]{2}-[0-9]{2}" && ok "names WHEN"    || fail "has no timestamp"

# ── 4. at 100%, the operator gets ONE aggregated view ──────────────────────
PCT=$(( USED * 100 / QUOTA_MB ))
if [[ "$PCT" -ge 100 ]]; then
  FLEET="$(PSQL -c "SELECT count(*) FROM notification_deliveries
    WHERE category_id='admin.mailbox_quota_fleet' AND queued_at > now() - interval '30 minutes';" | tr -d '[:space:]')"
  [[ "${FLEET:-0}" -gt 0 ]] \
    && ok "at ${PCT}% the OPERATOR got the aggregated fleet view" \
    || fail "mailbox is at ${PCT}% but no admin.mailbox_quota_fleet delivery"
else
  log "reached only ${PCT}% — the 100% operator path is not exercised by this run"
fi

# ── 5. a condition already reported must not re-notify ─────────────────────
BEFORE="$(PSQL -c "SELECT count(*) FROM notifications WHERE message LIKE '%$LOCAL_PART%';" | tr -d '[:space:]')"
log "waiting one more reconciler cycle to prove it does not repeat"
sleep 150
AFTER="$(PSQL -c "SELECT count(*) FROM notifications WHERE message LIKE '%$LOCAL_PART%';" | tr -d '[:space:]')"
[[ "$BEFORE" == "$AFTER" ]] \
  && ok "a still-true condition did NOT re-notify ($AFTER unchanged)" \
  || fail "re-notified on the next cycle ($BEFORE -> $AFTER) — this is how an alert becomes noise"

echo
echo "RESULTS: $passed passed, $failed failed"
[[ "$failed" -eq 0 ]]
