#!/usr/bin/env bash
# integration-mail-imapsync-e2e.sh — REAL mailbox migration, end to end,
# against the local DinD cluster.
#
# WHY THIS EXISTS
#
# Mailbox migration (IMAPSync) shipped broken on every real cluster and no
# existing check could see it. Two independent defects, both found only by
# driving the feature for real on 2026-09-01:
#
#   1. platform-api read Stalwart's master password from
#      `process.env.STALWART_MASTER_SECRET`, a variable set in exactly one
#      file in the repo — the dind overlay. Every non-local cluster returned
#      503 IMAPSYNC_NOT_CONFIGURED.
#   2. The destination user was built as `<mailbox>%master` with a HARDCODED
#      literal `master`. Stalwart 0.16 master-proxy auth needs the master
#      principal's FQDN; the short name resolves against Stalwart's own
#      default domain and fails `NO [AUTHENTICATIONFAILED] localhost.local`,
#      so the Job exited 162 having transferred nothing.
#
# Neither is visible to typecheck or the unit suite: the code compiles, the
# pure manifest builders test fine, and both failures happen at RUNTIME —
# one in the route, one inside the imapsync pod. Only an end-to-end run that
# asserts messages actually arrived catches them. Hence this harness.
#
# WHAT IT ASSERTS (16 checks)
#   · mail-secrets/STALWART_MASTER_PASSWORD exists
#   · platform-api carries NO STALWART_MASTER_SECRET env  (defect 1)
#   · POST .../mail/imapsync is accepted, not 503          (defect 1)
#   · the Job resolves DEST_PASSWORD + DEST_MASTER_USER via secretKeyRef
#     against mail-secrets, optional:false
#   · the per-job Secret holds ONLY SOURCE_PASSWORD, and the master
#     password is not recoverable from it
#   · the job reaches `succeeded`
#   · USER-VISIBLE: all seeded messages are readable in the DESTINATION
#     mailbox over IMAP                                    (defect 2)
#
# Source and destination are both Stalwart mailboxes on this cluster.
# Stalwart is a real IMAP server, so the source leg is genuine IMAP; what
# this does NOT reproduce is a foreign server's quirks (UIDVALIDITY, Gmail
# All-Mail, INBOX. namespace prefixes). It is a migration-plumbing test.
#
# PREREQUISITES
#   ./scripts/local.sh up && ./scripts/local.sh mail-up
#   Stalwart must have the imap/143 listener. `local.sh` does NOT create it
#   (bootstrap.sh's configure_stalwart_full does, and local.sh never calls
#   it) — see the SKIP guard below, which says so rather than failing.
#
# USAGE
#   DOCKER_HOST=tcp://dind:2375 bash scripts/integration-mail-imapsync-e2e.sh
#
# Cleans up after itself: throwaway tenant deleted, helper pod deleted,
# temp dir trapped.
set -uo pipefail


export PATH="/home/dev/bin:$PATH"
K3S=hosting-platform-k3s-server-1
APEX="${APEX:-${LOCAL_APEX:-k8s-platform.test}}"   # dev-only default; override with APEX=
API="${API:-https://${DOCKER_HOST_NAME:-dind.local}:2011}"
ADMIN_EMAIL="admin@${APEX}"
ADMIN_PASS="${ADMIN_PASS:-admin}"
STAMP="$(date +%s)"
TDOMAIN="imapspike${STAMP}.test"
SEED_N=7

pass=0; fail=0
ok()   { echo "  ✅ $*"; pass=$((pass+1)); }
bad()  { echo "  ❌ $*"; fail=$((fail+1)); }
step() { echo ""; echo "═══ $* ═══"; }
kc()   { docker exec "$K3S" kubectl "$@"; }
j()    { python3 -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
try:
  v=d$1
  print(v if v is not None else '')
except Exception: pass" 2>/dev/null; }

TMP="$(mktemp -d -t imapspike.XXXXXX)"
HELPER_POD=""; TENANT_ID=""
cleanup() {
  rm -rf "$TMP"
  [ -n "$HELPER_POD" ] && kc -n mail delete pod "$HELPER_POD" --wait=false >/dev/null 2>&1
  [ -n "$TENANT_ID" ] && api DELETE "/tenants/$TENANT_ID" >/dev/null 2>&1 && echo "  ⊙ deleted throwaway tenant $TENANT_ID"
  return 0
}
trap cleanup EXIT

api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sSk --max-time 60 -X "$method" "$API/api/v1$path" -H "Host: admin.${APEX}" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body"
  else
    curl -sSk --max-time 60 -X "$method" "$API/api/v1$path" -H "Host: admin.${APEX}" \
      -H "Authorization: Bearer $TOKEN"
  fi
}

# ── 0. Auth ────────────────────────────────────────────────────────────────
step "0. Authenticate"
TOKEN=$(curl -sSk --max-time 30 -X POST "$API/api/v1/auth/login" -H "Host: admin.${APEX}" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" | j "['data']['token']")
[ -n "$TOKEN" ] || { echo "FATAL: admin login failed"; exit 1; }
ok "authenticated as $ADMIN_EMAIL"

# ── 1. Preconditions ───────────────────────────────────────────────────────
step "1. Preconditions"
MASTER_PW=$(kc -n mail get secret mail-secrets -o jsonpath='{.data.STALWART_MASTER_PASSWORD}' 2>/dev/null | base64 -d)
MASTER_USER=$(kc -n mail get secret mail-secrets -o jsonpath='{.data.STALWART_MASTER_USER}' 2>/dev/null | base64 -d)
[ -n "$MASTER_PW" ] && ok "mail-secrets/STALWART_MASTER_PASSWORD present (${#MASTER_PW} chars)" \
                    || { bad "mail-secrets/STALWART_MASTER_PASSWORD missing"; exit 1; }

# Stalwart must have the plaintext imap/143 listener the Job dials.
# local.sh never creates it (bootstrap.sh's configure_stalwart_full does),
# so SKIP loudly rather than fail on a legitimately unconfigured dev stack.
SW_POD=$(kc -n mail get pod -l app=stalwart-mail -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
SW_APW=$(kc -n mail get secret stalwart-admin-creds -o jsonpath='{.data.adminPassword}' 2>/dev/null | base64 -d)
if [ -n "$SW_POD" ] && [ -n "$SW_APW" ]; then
  LISTENERS=$(kc -n mail exec "$SW_POD" -c stalwart -- curl -sS -u "admin:$SW_APW" --max-time 10 \
    -H 'Content-Type: application/json' -X POST \
    -d '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],"methodCalls":[["x:NetworkListener/get",{"accountId":"d333333","ids":null},"c0"]]}' \
    http://127.0.0.1:8080/jmap/ 2>/dev/null | jq -r '.methodResponses[0][1].list[]?.name' | tr '\n' ' ')
  case " $LISTENERS " in
    *" imap "*) ok "Stalwart has the imap/143 listener" ;;
    *) echo "  SKIP: Stalwart has no plaintext imap/143 listener (has: ${LISTENERS:-none})."
       echo "        local.sh does not run bootstrap.sh's configure_stalwart_full(), which is"
       echo "        what creates http-acme/80, submission/587 and imap/143. Create it via"
       echo "        x:NetworkListener/set and restart the pod, then re-run."
       exit 0 ;;
  esac
fi

API_POD=$(kc -n platform get pod -l app=platform-api -o jsonpath='{.items[0].metadata.name}')
if kc -n platform get pod "$API_POD" -o json \
     | jq -e '.spec.containers[].env[]?|select(.name=="STALWART_MASTER_SECRET")' >/dev/null 2>&1; then
  bad "platform-api still carries STALWART_MASTER_SECRET — old build deployed"
else
  ok "platform-api has NO STALWART_MASTER_SECRET env (fix is deployed)"
fi

# ── 2. Fixtures ────────────────────────────────────────────────────────────
step "2. Provision tenant + domain + two mailboxes"
PLAN_ID=$(api GET "/plans?limit=1" | j "['data'][0]['id']")
REGION_ID=$(api GET "/regions?limit=1" | j "['data'][0]['id']")
[ -n "$PLAN_ID" ] && [ -n "$REGION_ID" ] || { echo "FATAL: no plan/region"; exit 1; }

TENANT_ID=$(api POST "/tenants" "{\"name\":\"imapspike-${STAMP}\",\"contact_name\":\"IMAP Spike\",\"primary_email\":\"spike@example.test\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\"}" | j "['data']['id']")
[ -n "$TENANT_ID" ] || { echo "FATAL: tenant create failed"; exit 1; }
ok "tenant $TENANT_ID"

api POST "/admin/tenants/${TENANT_ID}/provision" "{}" >/dev/null 2>&1
waited=0; active=0
while [ "$waited" -lt 240 ]; do
  case "$(api GET "/tenants/${TENANT_ID}")" in *'"status":"active"'*) active=1; break;; esac
  sleep 4; waited=$((waited+4))
done
[ "$active" = 1 ] && ok "tenant active (${waited}s)" || { bad "tenant never became active"; exit 1; }

DOM_RESP=$(api POST "/tenants/${TENANT_ID}/domains" "{\"domain_name\":\"$TDOMAIN\",\"dns_mode\":\"cname\"}"); DOM_ID=$(printf "%s" "$DOM_RESP" | j "['data']['id']")
[ -n "$DOM_ID" ] || { echo "FATAL domain: $DOM_RESP"; exit 1; }
ED_RESP=$(api POST "/tenants/${TENANT_ID}/email/domains/${DOM_ID}/enable" "{}"); ED_ID=$(printf "%s" "$ED_RESP" | j "['data']['id']")
[ -n "$ED_ID" ] || { echo "FATAL email-enable: $ED_RESP"; exit 1; }
ok "email domain $TDOMAIN enabled"

mkbox() {
  api POST "/tenants/${TENANT_ID}/email/domains/${ED_ID}/mailboxes" \
    "{\"local_part\":\"$1\",\"mailbox_type\":\"mailbox\"}"
}
SRC_JSON=$(mkbox src)
SRC_ADDR=$(printf '%s' "$SRC_JSON" | j "['data']['fullAddress']")
SRC_PW=$(printf '%s' "$SRC_JSON"   | j "['data']['initialLoginPassword']['secret']")
DST_JSON=$(mkbox dst)
DST_ID=$(printf '%s' "$DST_JSON"   | j "['data']['id']")
DST_ADDR=$(printf '%s' "$DST_JSON" | j "['data']['fullAddress']")

[ -n "$SRC_ADDR" ] && [ -n "$SRC_PW" ] && ok "source $SRC_ADDR (login password issued)" \
  || { bad "source mailbox: $(printf '%s' "$SRC_JSON" | head -c 200)"; exit 1; }
[ -n "$DST_ID" ] && ok "destination $DST_ADDR" || { bad "dst: $(printf '%s' "$DST_JSON" | head -c 200)"; exit 1; }

# ── 3. Seed the SOURCE mailbox over real IMAP ──────────────────────────────
step "3. Seed source mailbox ($SEED_N messages, IMAP APPEND from in-cluster pod)"
HELPER_POD="imapspike-helper-$STAMP"
kc -n mail run "$HELPER_POD" --image=python:3.12-alpine --restart=Never \
   --command -- sleep 3600 >/dev/null 2>&1
kc -n mail wait --for=condition=Ready "pod/$HELPER_POD" --timeout=180s >/dev/null 2>&1 \
  && ok "helper pod ready" || { bad "helper pod not ready"; exit 1; }

cat > "$TMP/seed.py" <<'PYEOF'
import imaplib, sys, time
host, user, pw, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
m = imaplib.IMAP4(host, 143)
import ssl as _s; _c=_s.create_default_context(); _c.check_hostname=False; _c.verify_mode=_s.CERT_NONE
m.starttls(_c)
m.login(user, pw)
for i in range(n):
    msg = (f"From: sender{i}@example.test\r\nTo: {user}\r\n"
           f"Subject: SPIKE-MSG-{i}\r\nMessage-ID: <spike-{i}@example.test>\r\n"
           f"Date: Mon, 1 Sep 2026 12:00:0{i} +0000\r\n\r\nbody {i}\r\n").encode()
    r = m.append("INBOX", None, imaplib.Time2Internaldate(time.time()), msg)
    if r[0] != 'OK': print("APPEND FAILED", r); sys.exit(1)
m.select("INBOX"); print("SEEDED", len(m.search(None,"ALL")[1][0].split())); m.logout()
PYEOF
SEED_OUT=$(docker exec -i "$K3S" kubectl -n mail exec -i "$HELPER_POD" -- python3 - \
  stalwart-mail.mail.svc.cluster.local "$SRC_ADDR" "$SRC_PW" "$SEED_N" < "$TMP/seed.py" 2>&1)
echo "$SEED_OUT" | grep -q "SEEDED $SEED_N" \
  && ok "seeded $SEED_N messages into $SRC_ADDR" || { bad "seed failed: $SEED_OUT"; exit 1; }

# ── 4. THE REPORTED BUG ────────────────────────────────────────────────────
step "4. Start the migration (production returned 503 here)"
JOB_JSON=$(api POST "/tenants/${TENANT_ID}/mail/imapsync" "{\"mailbox_id\":\"$DST_ID\",\"source_host\":\"stalwart-mail.mail.svc.cluster.local\",\"source_port\":143,\"source_username\":\"$SRC_ADDR\",\"source_password\":\"$SRC_PW\",\"source_ssl\":false,\"options\":{\"automap\":true}}")
ERRCODE=$(printf '%s' "$JOB_JSON" | j "['error']['code']")
JOB_ID=$(printf '%s' "$JOB_JSON" | j "['data']['id']")
if [ "$ERRCODE" = "IMAPSYNC_NOT_CONFIGURED" ]; then
  bad "REGRESSION — $(printf '%s' "$JOB_JSON" | j "['error']['message']")"; exit 1
elif [ -n "$JOB_ID" ]; then
  ok "migration accepted, job $JOB_ID (no IMAPSYNC_NOT_CONFIGURED)"
else
  bad "unexpected: $(printf '%s' "$JOB_JSON" | head -c 300)"; exit 1
fi

# ── 5. Manifest shape — the actual fix ─────────────────────────────────────
step "5. Assert Job + Secret shape"
K8S_JOB="imapsync-$JOB_ID"
for _ in $(seq 1 30); do kc -n mail get job "$K8S_JOB" >/dev/null 2>&1 && break; sleep 1; done

REF=$(kc -n mail get job "$K8S_JOB" -o json 2>/dev/null \
  | jq -r '.spec.template.spec.containers[0].env[]?|select(.name=="DEST_PASSWORD")|.valueFrom.secretKeyRef|"\(.name)/\(.key) optional=\(.optional)"')
[ "$REF" = "mail-secrets/STALWART_MASTER_PASSWORD optional=false" ] \
  && ok "DEST_PASSWORD ← secretKeyRef $REF" || bad "wrong secretKeyRef: '$REF'"

MREF=$(kc -n mail get job "$K8S_JOB" -o json 2>/dev/null \
  | jq -r '.spec.template.spec.containers[0].env[]?|select(.name=="DEST_MASTER_USER")|.valueFrom.secretKeyRef|"\(.name)/\(.key) optional=\(.optional)"')
[ "$MREF" = "mail-secrets/STALWART_MASTER_USER optional=false" ] \
  && ok "DEST_MASTER_USER <- secretKeyRef $MREF" || bad "wrong/missing DEST_MASTER_USER ref: '$MREF'"

# Defect 2: a hardcoded `%master` in argv is the bug. The real principal is
# composed at runtime by the entrypoint from DEST_MAILBOX + DEST_MASTER_USER.
ARGS=$(kc -n mail get job "$K8S_JOB" -o json 2>/dev/null | jq -r '.spec.template.spec.containers[0].args|join(" ")')
case "$ARGS" in
  *"%master"*) bad "Job argv contains a hardcoded '%master' — Stalwart needs the master FQDN" ;;
  *)           ok  "Job argv carries no hardcoded '%master'" ;;
esac

SECRET_KEYS=$(kc -n mail get secret "$K8S_JOB" -o json 2>/dev/null | jq -r '.data|keys|join(",")')
[ "$SECRET_KEYS" = "SOURCE_PASSWORD" ] \
  && ok "per-job Secret holds ONLY SOURCE_PASSWORD" \
  || bad "per-job Secret keys = '$SECRET_KEYS'"

if kc -n mail get secret "$K8S_JOB" -o json 2>/dev/null \
     | jq -r '.data|to_entries[]|.value' | base64 -d 2>/dev/null | grep -qF "$MASTER_PW"; then
  bad "MASTER PASSWORD LEAKED into the per-job Secret"
else
  ok "master password absent from the per-job Secret"
fi

# ── 6. Completion ──────────────────────────────────────────────────────────
step "6. Wait for the migration to finish"
# Snapshot pod logs while the Job still exists — the reconciler deletes it on
# terminal status, after which `kubectl logs job/...` is NotFound.
( for _ in $(seq 1 40); do
    if kc -n mail logs "job/$K8S_JOB" --tail=60 >"$TMP/podlogs.txt" 2>/dev/null; then
      [ -s "$TMP/podlogs.txt" ] && break
    fi
    sleep 3
  done ) &
STATUS=""
for _ in $(seq 1 60); do
  STATUS=$(api GET "/tenants/${TENANT_ID}/mail/imapsync/$JOB_ID" | j "['data']['status']")
  case "$STATUS" in succeeded|failed|cancelled) break;; esac
  sleep 5
done
[ "$STATUS" = "succeeded" ] && ok "job status = succeeded" || bad "job status = '$STATUS'"
if [ "$STATUS" != "succeeded" ]; then
  echo "--- errorMessage ---"; api GET "/tenants/${TENANT_ID}/mail/imapsync/$JOB_ID" | j "['data']['errorMessage']"
  echo "--- logTail (from the DB row; survives Job GC) ---"
  api GET "/tenants/${TENANT_ID}/mail/imapsync/$JOB_ID" | j "['data']['logTail']" | tail -45
  echo "--- pod log snapshot ---"; tail -40 "$TMP/podlogs.txt" 2>/dev/null || echo "(none captured)"
fi

# ── 7. USER-VISIBLE ASSERTION ──────────────────────────────────────────────
step "7. Are the messages actually IN the destination mailbox?"
cat > "$TMP/verify.py" <<'PYEOF'
import imaplib, sys
host, addr, muser, mpw, want = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
m = imaplib.IMAP4(host, 143)
import ssl as _s; _c=_s.create_default_context(); _c.check_hostname=False; _c.verify_mode=_s.CERT_NONE
m.starttls(_c)
m.login(f"{addr}%{muser}", mpw)   # Stalwart master-proxy
m.select("INBOX")
ids = m.search(None, "ALL")[1][0].split()
subs = []
for i in ids:
    for part in m.fetch(i, "(BODY.PEEK[HEADER.FIELDS (SUBJECT)])")[1]:
        if isinstance(part, tuple): subs.append(part[1].decode(errors="replace").strip())
print("COUNT", len(ids))
print("MATCHED", sum(1 for k in range(want) if any(f"SPIKE-MSG-{k}" in s for s in subs)))
m.logout()
PYEOF
VER=$(docker exec -i "$K3S" kubectl -n mail exec -i "$HELPER_POD" -- python3 - \
  stalwart-mail.mail.svc.cluster.local "$DST_ADDR" "$MASTER_USER" "$MASTER_PW" "$SEED_N" < "$TMP/verify.py" 2>&1)
echo "$VER"
MATCHED=$(echo "$VER" | awk '/^MATCHED/{print $2}')
[ "${MATCHED:-0}" = "$SEED_N" ] \
  && ok "all $SEED_N messages present in $DST_ADDR — the migration really moved mail" \
  || bad "only ${MATCHED:-0}/$SEED_N messages arrived"

echo ""; echo "═══════════════════════════════════════"
echo "  PASSED: $pass    FAILED: $fail"
echo "═══════════════════════════════════════"
[ "$fail" -eq 0 ] || exit 1
