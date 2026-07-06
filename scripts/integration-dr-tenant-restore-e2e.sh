#!/usr/bin/env bash
# integration-dr-tenant-restore-e2e.sh
#
# End-to-end tenant DR recovery from an offsite bundle, driving the
# one-button orchestrator `POST /api/v1/admin/dr/tenants/:id/recover`.
#
# Flow (self-provisioning probe tenant, non-destructive to real tenants):
#   1. Create probe tenant; seed a known website file (SHA recorded) AND a
#      mailbox with N marked messages.
#   2. Capture a whole-client bundle (files+mailboxes+config) offsite; assert
#      status == completed (NEVER partial).
#   3. Simulate cluster data loss: delete the tenant namespace (files gone)
#      and destroy all mailbox messages (mail gone); assert both are gone.
#   4. Recover from the offsite bundle via the DR orchestrator route; poll the
#      restore cart to `done`.
#   5. Assert USER-VISIBLE recovery: website file SHA256 matches the original,
#      and the mailbox message count is restored.
#   6. Teardown: delete the probe tenant.
#
# Registry tier: manual (destructive to its OWN probe tenant only; needs an
# offsite BackupStore + the mail stalwart-probe machinery). Run against staging.
#
# USAGE:
#   ADMIN_HOST=https://admin.<apex> ADMIN_PASSWORD=<pw> \
#   SSH_HOST=root@<node> SSH_KEY=~/hosting-platform.key PLATFORM_DOMAIN=<apex> \
#   ./scripts/integration-dr-tenant-restore-e2e.sh
# (or: source scripts/integration.env first)
set -uo pipefail
: "${ADMIN_HOST:?set ADMIN_HOST or source scripts/integration.env}"
: "${ADMIN_EMAIL:=admin@${PLATFORM_DOMAIN:?}}"
: "${SSH_HOST:?}" "${PLATFORM_DOMAIN:?}"
# TOKEN may be preset (e.g. an out-of-band minted admin JWT when /auth/login is
# unavailable); otherwise ADMIN_PASSWORD is required for the login below.
[[ -n "${TOKEN:-}" ]] || : "${ADMIN_PASSWORD:?set ADMIN_PASSWORD, or export a preset TOKEN}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
NODE="$SSH_HOST"
COUNT="${MAIL_COUNT:-15}"
STAMP=$(date +%s)
DOMAIN="drtr-$STAMP.net"
pass=0; fail=0
red(){ printf '\033[31m%s\033[0m\n' "$*"; }; grn(){ printf '\033[32m%s\033[0m\n' "$*"; }
cyn(){ printf '\033[36m== %s ==\033[0m\n' "$*"; }
ok(){ grn "  ✓ $*"; pass=$((pass+1)); }; no(){ red "  ✗ $*"; fail=$((fail+1)); }
rd(){ sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}/<IP>/g'; }
api(){ local m="$1" p="$2" b="${3:-}" a="${4:-}"; local H=(); [[ -n "$a" ]] && H=(-H "Authorization: Bearer $a")
  if [[ -z "$b" ]]; then curl -sk -w '\n%{http_code}' -X "$m" "$ADMIN_HOST/api/v1$p" "${H[@]}"
  else curl -sk -w '\n%{http_code}' -X "$m" "$ADMIN_HOST/api/v1$p" "${H[@]}" -H 'Content-Type: application/json' -d "$b"; fi; }
parse(){ STATUS=$(printf '%s' "$1"|tail -n1); BODY=$(printf '%s' "$1"|sed '$d'); }
ssh_node(){ ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=12 "$NODE" "$@"; }
fm_exec(){ ssh_node "kubectl -n $NS exec '$FM_POD' -c file-manager -- sh -c '$1'" </dev/null; }
wait_ns_gone(){ for i in $(seq 1 40); do ssh_node "kubectl get ns $NS" </dev/null >/dev/null 2>&1 || return 0; sleep 3; done; return 1; }
wait_ns(){ for i in $(seq 1 60); do ssh_node "kubectl get ns $NS" </dev/null >/dev/null 2>&1 && return 0; sleep 3; done; return 1; }
wait_pvc(){ for i in $(seq 1 80); do [[ "$(ssh_node "kubectl -n $NS get pvc ${NS}-storage -o jsonpath='{.status.phase}'" </dev/null 2>/dev/null||true)" == Bound ]] && return 0; sleep 3; done; return 1; }
ensure_fm(){ api POST "/tenants/$TENANT_ID/files/start" '{}' "$TOKEN" >/dev/null 2>&1 || true
  for i in $(seq 1 30); do ssh_node "kubectl -n $NS get deploy file-manager" </dev/null >/dev/null 2>&1 && break
    api POST "/tenants/$TENANT_ID/files/start" '{}' "$TOKEN" >/dev/null 2>&1 || true; sleep 4; done
  ssh_node "kubectl -n $NS rollout status deploy/file-manager --timeout=200s" </dev/null >/dev/null 2>&1 || return 1
  FM_POD=""; for i in $(seq 1 20); do FM_POD=$(ssh_node "kubectl -n $NS get pod -l app=file-manager --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'" </dev/null 2>/dev/null||true); [[ -n "$FM_POD" ]] && break; sleep 3; done
  [[ -n "$FM_POD" ]]; }
force_reconcile(){ api POST /admin/mail/stalwart-reprovision '{}' "$TOKEN" >/dev/null 2>&1 || true; }

# JMAP op in the mail probe pod (master-proxy impersonation of TEST_ADDR): count | destroy
jmap_op(){ local op="$1"
ssh_node "kubectl -n mail exec -i stalwart-probe -- env ADDR='$TEST_ADDR' OP='$op' python3 - " </dev/null <<'PY'
import base64,json,os,urllib.request,urllib.error
ADDR=os.environ["ADDR"]; OP=os.environ["OP"]; pw=os.environ["STALWART_MASTER_PASSWORD"]
EP="http://stalwart-mgmt.mail.svc.cluster.local:8080/.well-known/jmap"
auth="Basic "+base64.b64encode(f"{ADDR}%master@local.host:{pw}".encode()).decode()
def http(u,m="GET",b=None):
    r=urllib.request.Request(u,data=b,method=m); r.add_header("Authorization",auth)
    if b is not None: r.add_header("Content-Type","application/json")
    try:
        with urllib.request.urlopen(r,timeout=60) as x: return x.status,x.read()
    except urllib.error.HTTPError as e: return e.code,(e.read() if hasattr(e,'read') else b'')
st,body=http(EP)
if st!=200: print("ERR session %s"%st); raise SystemExit(1)
s=json.loads(body); from urllib.parse import urlsplit,urlunsplit
api=urlunsplit((urlsplit(EP).scheme,urlsplit(EP).netloc,urlsplit(s["apiUrl"]).path,'',''))
acct=next(a for a,i in s["accounts"].items() if "urn:ietf:params:jmap:mail" in i.get("accountCapabilities",{}))
ids=[]; pos=0
while True:
    rsp=http(api,"POST",json.dumps({"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],"methodCalls":[["Email/query",{"accountId":acct,"position":pos,"limit":200,"calculateTotal":False},"0"]]}).encode())
    got=json.loads(rsp[1])["methodResponses"][0][1].get("ids",[])
    if not got: break
    ids+=got; pos+=len(got)
    if len(got)<200: break
if OP=="count": print("COUNT=%d"%len(ids))
elif OP=="destroy":
    if ids:
        rsp=http(api,"POST",json.dumps({"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],"methodCalls":[["Email/set",{"accountId":acct,"destroy":ids},"0"]]}).encode())
        print("DESTROYED=%d"%len(json.loads(rsp[1])["methodResponses"][0][1].get("destroyed",[])))
    else: print("DESTROYED=0")
PY
}
jcount(){ jmap_op count | grep -oE 'COUNT=[0-9]+' | cut -d= -f2; }

TENANT_ID=""; NS=""; TEST_ADDR=""
cleanup(){ [[ -n "$TENANT_ID" ]] && { cyn "TEARDOWN: delete probe tenant $TENANT_ID"; api DELETE "/tenants/$TENANT_ID" '' "$TOKEN" >/dev/null 2>&1 || true; }; }
trap cleanup EXIT

cyn "0. login + resolve plan/region/backup-cfg + probe pod"
if [[ -n "${TOKEN:-}" ]]; then
  ok "using preset TOKEN (login skipped)"
else
  parse "$(api POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")"
  [[ "$STATUS" == 200 ]] || { no "login $STATUS"; echo "$BODY"|rd; exit 1; }
  TOKEN=$(printf '%s' "$BODY"|jq -r '.data.token'); ok "admin login"
fi
parse "$(api GET /admin/backup-configs '' "$TOKEN")"
CFG=$(printf '%s' "$BODY"|jq -r '.data[]|select(.active==true or .isActive==true)|.id'|head -1)
[[ -n "$CFG" ]] || CFG=$(printf '%s' "$BODY"|jq -r '.data[]|select(.name|test("s3";"i"))|.id'|head -1)
api POST "/admin/backup-configs/$CFG/activate" '{}' "$TOKEN" >/dev/null
PLAN_ID=$(api GET /plans '' "$TOKEN"|sed '$d'|jq -r '.data[]|select(.name=="Starter").id'|head -1)
REGION_ID=$(api GET /regions '' "$TOKEN"|sed '$d'|jq -r '.data[0].id')
[[ -n "$CFG" && -n "$PLAN_ID" && -n "$REGION_ID" ]] || { no "missing cfg/plan/region"; exit 1; }
ok "cfg=$CFG plan+region resolved"
# A stale probe pod (restartPolicy:Never sleep ended → phase=Succeeded) can't be
# exec'd into and `kubectl apply` won't recreate it — delete any non-Running pod
# before applying a fresh one.
ssh_node "kubectl -n mail get pod stalwart-probe -o jsonpath='{.status.phase}' 2>/dev/null | grep -q Running" </dev/null 2>/dev/null || \
ssh_node "kubectl -n mail delete pod stalwart-probe --ignore-not-found --wait=true >/dev/null 2>&1; cat <<'EOF' | kubectl apply -f - >/dev/null; kubectl -n mail wait --for=condition=ready pod/stalwart-probe --timeout=120s
apiVersion: v1
kind: Pod
metadata: {name: stalwart-probe, namespace: mail}
spec:
  restartPolicy: Never
  containers:
  - name: c
    image: ghcr.io/insulahq/insula/tenant-backup-tools:latest
    command: [\"sh\",\"-c\",\"sleep 7200\"]
    env:
    - {name: STALWART_MASTER_PASSWORD, valueFrom: {secretKeyRef: {name: mail-secrets, key: STALWART_MASTER_PASSWORD}}}
    resources: {requests: {cpu: 100m, memory: 128Mi}, limits: {cpu: 500m, memory: 512Mi}}
EOF" </dev/null 2>&1 | rd
[[ "$(ssh_node "kubectl -n mail get pod stalwart-probe -o jsonpath='{.status.phase}'" </dev/null 2>/dev/null)" == Running ]] || { no "stalwart-probe not Running"; exit 1; }
ok "stalwart-probe ready"

cyn "1. create probe tenant + provision"
parse "$(api POST /tenants "{\"name\":\"DR TR $STAMP\",\"primary_email\":\"drtr-$STAMP@example.test\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\",\"storage_tier\":\"local\"}" "$TOKEN")"
[[ "$STATUS" =~ ^20 ]] || { no "tenant create $STATUS"; echo "$BODY"|rd; exit 1; }
TENANT_ID=$(printf '%s' "$BODY"|jq -r '.data.id')
api POST "/admin/tenants/$TENANT_ID/provision" '{}' "$TOKEN" >/dev/null 2>&1 || true
st=""; for i in $(seq 1 80); do st=$(api GET "/tenants/$TENANT_ID" '' "$TOKEN"|sed '$d'|jq -r '.data.status'); [[ "$st" == active ]] && break; sleep 3; done
[[ "$st" == active ]] || { no "tenant not active ($st)"; exit 1; }
NS=$(api GET "/tenants/$TENANT_ID" '' "$TOKEN"|sed '$d'|jq -r '.data.kubernetesNamespace')
ok "tenant=$TENANT_ID ns=$NS active"

cyn "2. seed FILES (known website) + MAIL (mailbox + $COUNT messages)"
wait_pvc || { no "storage PVC not bound"; exit 1; }
ensure_fm || { no "file-manager not ready"; exit 1; }
MARK="DRTR-$STAMP-$(head -c8 /dev/urandom|od -An -tx1|tr -d ' ')"
fm_exec "mkdir -p /data/site; printf '%s' '$MARK' > /data/site/index.html; sync"
ORIG_SHA=$(fm_exec "sha256sum /data/site/index.html"|awk '{print $1}')
ok "seeded site/index.html sha=$ORIG_SHA"
# mail: domain -> email enable -> mailbox
DID=$(api POST "/tenants/$TENANT_ID/domains" "{\"domain_name\":\"$DOMAIN\",\"dns_mode\":\"primary\"}" "$TOKEN"|sed '$d'|jq -r '.data.id // empty')
EDID=$(api POST "/tenants/$TENANT_ID/email/domains/$DID/enable" '{}' "$TOKEN"|sed '$d'|jq -r '.data.id // empty')
[[ -n "$EDID" && "$EDID" != null ]] || { no "email-domain enable failed"; exit 1; }
MBX=$(api POST "/tenants/$TENANT_ID/email/domains/$EDID/mailboxes" '{"local_part":"dr-probe"}' "$TOKEN"|sed '$d'|jq -r '.data.id // empty')
[[ -n "$MBX" && "$MBX" != null ]] || { no "mailbox create failed"; exit 1; }
TEST_ADDR="dr-probe@$DOMAIN"
RDY=""; for i in $(seq 1 25); do c=$(jcount 2>/dev/null); [[ -n "$c" ]] && { RDY=1; break; }; force_reconcile; sleep 12; done
[[ -n "$RDY" ]] || { no "mailbox never JMAP-reachable"; exit 1; }
ssh_node "kubectl -n mail exec stalwart-probe -- /usr/local/bin/jmap-seed.py --endpoint http://stalwart-mgmt.mail.svc.cluster.local:8080 --account-address $TEST_ADDR --master-user master@local.host --auth-pass-env STALWART_MASTER_PASSWORD --count $COUNT --marker $MARK --flagged-every-n 5" </dev/null 2>&1 | tail -2 | rd
SEED=$(jcount); [[ "$SEED" -ge "$COUNT" ]] || { no "mail seed short: $SEED<$COUNT"; exit 1; }
ok "seeded mailbox $TEST_ADDR ($SEED messages)"

cyn "3. capture whole-client bundle (files+mailboxes+config) offsite"
parse "$(api POST /admin/tenant-bundles "{\"tenantId\":\"$TENANT_ID\",\"targetConfigId\":\"$CFG\",\"async\":true,\"components\":{\"files\":true,\"mailboxes\":true,\"config\":true,\"secrets\":false}}" "$TOKEN")"
[[ "$STATUS" =~ ^20 ]] || { no "bundle create $STATUS"; echo "$BODY"|rd; exit 1; }
BID=$(printf '%s' "$BODY"|jq -r '.data.bundleId // .data.id')
BST=timeout; for i in $(seq 1 120); do
  parse "$(api GET "/admin/tenant-bundles/$BID" '' "$TOKEN")"; s=$(printf '%s' "$BODY"|jq -r '.data.status // empty')
  [[ "$s" == completed || "$s" == partial || "$s" == failed ]] && { BST="$s"; break; }; sleep 3
done
[[ "$BST" == completed ]] || { no "bundle terminal=$BST (expected completed)"; printf '%s' "$BODY"|jq -r '.data.components[]?|"    \(.component) \(.status) \(.lastError//"")"'|rd; exit 1; }
ok "bundle $BID completed (files+mailboxes+config)"

cyn "4. SIMULATE LOSS"
if [[ -n "${RECREATE:-}" ]]; then
  # S4 deleted-client case: delete the WHOLE tenant (row + config + namespace).
  jmap_op destroy >/dev/null 2>&1 || true
  api DELETE "/tenants/$TENANT_ID" '' "$TOKEN" >/dev/null 2>&1 || true
  gone=""; for i in $(seq 1 80); do [[ "$(api GET "/tenants/$TENANT_ID" '' "$TOKEN"|tail -n1)" == 404 ]] && { gone=1; break; }; sleep 3; done
  [[ -n "$gone" ]] && ok "tenant $TENANT_ID DELETED entirely (row+config+ns gone)" || { no "tenant not fully deleted"; exit 1; }
else
  ssh_node "kubectl delete ns $NS --wait=false" </dev/null 2>&1|rd || true
  wait_ns_gone && ok "namespace $NS deleted (files+PVC gone)" || { no "namespace not deleted"; exit 1; }
  jmap_op destroy | rd
  [[ "$(jcount)" == 0 ]] && ok "mailbox emptied (mail gone)" || { no "mailbox not emptied"; exit 1; }
fi

cyn "5. RECOVER from offsite bundle via DR orchestrator route"
# G2: when TARGET_NODE is set, ask the recover route to place the tenant there.
RBODY="{\"bundleId\":\"$BID\"}"
[[ -n "${TARGET_NODE:-}" ]] && { RBODY="{\"bundleId\":\"$BID\",\"targetNode\":\"$TARGET_NODE\"}"; echo "  targetNode=$TARGET_NODE"; }
parse "$(api POST "/admin/dr/tenants/$TENANT_ID/recover" "$RBODY" "$TOKEN")"
[[ "$STATUS" =~ ^20 ]] || { no "recover route $STATUS"; echo "$BODY"|rd; exit 1; }
CID=$(printf '%s' "$BODY"|jq -r '.data.cartId // .data.id // empty')
[[ -n "$CID" ]] || { no "recover: no cartId in response: $BODY"; exit 1; }
ok "recover started (cart=$CID, provisioned=$(printf '%s' "$BODY"|jq -r '.data.provisioned // "?"'), recreated=$(printf '%s' "$BODY"|jq -r '.data.recreated // "?"'))"
if [[ -n "${RECREATE:-}" ]]; then
  REC=$(printf '%s' "$BODY"|jq -r '.data.recreated // false')
  [[ "$REC" == true ]] && ok "re-create: tenant re-created from bundle (recreated=true)" || no "re-create: recreated=$REC (expected true)"
fi
CST=timeout; for i in $(seq 1 150); do
  parse "$(api GET "/admin/restores/carts/$CID" '' "$TOKEN")"; s=$(printf '%s' "$BODY"|jq -r '.data.status // empty')
  [[ "$s" == done || "$s" == failed ]] && { CST="$s"; break; }; sleep 4
done
[[ "$CST" == done ]] || { no "restore cart terminal=$CST"; printf '%s' "$BODY"|jq -r '.data.items[]?|"    \(.type) \(.status) \(.lastError//.progressMessage//"")"'|rd; exit 1; }
ok "restore cart done"

cyn "6. ASSERT user-visible recovery"
if [[ -n "${RECREATE:-}" ]]; then
  st2=""; for i in $(seq 1 60); do st2=$(api GET "/tenants/$TENANT_ID" '' "$TOKEN"|sed '$d'|jq -r '.data.status // empty'); [[ "$st2" == active ]] && break; sleep 3; done
  [[ "$st2" == active ]] && ok "re-create: tenant $TENANT_ID is back + active (original id preserved)" || no "re-create: tenant not active after recover ($st2)"
  NS=$(api GET "/tenants/$TENANT_ID" '' "$TOKEN"|sed '$d'|jq -r '.data.kubernetesNamespace')
fi
wait_ns && wait_pvc && ensure_fm || { no "file-manager not back after recover"; exit 1; }
GOT_SHA=$(fm_exec "sha256sum /data/site/index.html 2>/dev/null"|awk '{print $1}')
[[ "$GOT_SHA" == "$ORIG_SHA" ]] && ok "FILES: site/index.html SHA matches ($GOT_SHA)" || no "FILES: SHA mismatch want=$ORIG_SHA got=$GOT_SHA"
sleep 5; RCOUNT=$(jcount 2>/dev/null || echo 0)
[[ "${RCOUNT:-0}" -ge "$COUNT" ]] && ok "MAIL: $RCOUNT messages restored (>= $COUNT)" || no "MAIL: only $RCOUNT restored (want >= $COUNT)"
# G2: assert the recovered tenant's file-manager landed on the requested node.
if [[ -n "${TARGET_NODE:-}" ]]; then
  FMNODE=$(ssh_node "kubectl -n $NS get pod -l app=file-manager --field-selector=status.phase=Running -o jsonpath='{.items[0].spec.nodeName}'" </dev/null 2>/dev/null)
  [[ "$FMNODE" == "$TARGET_NODE" ]] && ok "G2: file-manager placed on target node $TARGET_NODE" || no "G2: file-manager on '$FMNODE', expected '$TARGET_NODE'"
fi

cyn "RESULT: PASS=$pass FAIL=$fail"
[[ "$fail" == 0 ]] && { grn "TENANT DR RESTORE: GREEN"; exit 0; } || { red "TENANT DR RESTORE: $fail failure(s)"; exit 1; }
