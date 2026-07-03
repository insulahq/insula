#!/usr/bin/env bash
#
# integration-mail-dr-dataplane.sh — DATA-PLANE DR failover E2E.
#
# The sibling integration-mail-dr-failover.sh is CONTROL-PLANE only (it proves
# the migration launches, completes, and the pod relocates). This suite proves
# the USER-VISIBLE properties that one masks:
#
#   R  Reachability: measures the mail-port outage window on the SURVIVING
#      nodes during relocation (HAProxy stays bound but its backend is down),
#      and asserts mail is reachable again by the end. The gap is a REPORTED
#      METRIC (an inherent ~2-3 min for restore-based failover), not a FAIL.
#   D  Data survival: a message captured in the last snapshot survives failover.
#   I  Inbound: a message delivered via SMTP :25 to the NEW active lands.
#   S  Sync-back: messages written while on the standby round-trip to the
#      primary after failback (data sync standby → reactivated primary).
#   P  RPO: a message written AFTER the last snapshot is reported present/lost
#      (RPO = snapshot age minus standby-rsync) — REPORTED, not a FAIL.
#
# HARDENING (why the first hand-run gave false negatives): a restore-based
# failover transiently breaks master-user auth (credential drift, auto-heals
# <=5min). Every data assertion therefore WAITS for master-auth to heal and
# RETRIES the read. Failback is scale-down-timeout flaky, so it is retried and
# only fired once the target node is Ready.
#
# DESTRUCTIVE (~12-15min, real mail-down window). Deliberate maintenance-window
# run — never CI-gated. Self-contained: seeds its own probe tenant/mailbox and
# tears everything down (incl. failback + config restore) on exit.
#
# Env:
#   SSH_KEY               ssh key (default /home/dev/hosting-platform.key)
#   MAIL_DR_NODE_MAP      "name=ip,name=ip,..." (REQUIRED — nodes SSH by IP)
#   MAIL_DR_BASTION_NODE  kubectl bastion node name (default: a surviving server)
#   ADMIN_HOST/ADMIN_EMAIL/ADMIN_PASSWORD  from integration.env
#   STANDBY_NODE          failover target (default: the mailSecondaryNode, else auto)
#   TOOLS_IMAGE           tenant-backup-tools ref (default: auto-detect in containerd)
#   NODE_LOSS_MODE        "wipe" = TRUE node-loss: after stopping k3s, destroy the
#                         source node's local-path mail store so recovery is
#                         forced from backup (restic/standby) — exercises the
#                         restic-escalation + availability cutover (Gap A/B).
#                         Default (unset): plain k3s-stop (data survives on-node).
#
set -uo pipefail

SSH_KEY="${SSH_KEY:-/home/dev/hosting-platform.key}"
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -q -i $SSH_KEY"
BUDGET="${DR_FAILOVER_BUDGET:-720}"
DOMAIN=mailperf-bench.net
ADDR="dr-probe@${DOMAIN}"

green(){ printf '\033[32m%s\033[0m\n' "$*"; }
red(){ printf '\033[31m%s\033[0m\n' "$*" >&2; }
hdr(){ printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; }
PASS=0; FAIL=0
ok(){ green "  PASS: $*"; PASS=$((PASS+1)); }
no(){ red "  FAIL: $*"; FAIL=$((FAIL+1)); }
metric(){ printf '\033[33m  METRIC: %s\033[0m\n' "$*"; }

if [ -z "${MAIL_DR_NODE_MAP:-}" ]; then red "MAIL_DR_NODE_MAP required (name=ip,...)"; exit 2; fi
node_addr(){ local n="$1" p k v IFS=','; for p in $MAIL_DR_NODE_MAP; do k="${p%%=*}"; v="${p#*=}"; [ "$k" = "$n" ] && { printf '%s' "$v"; return; }; done; return 1; }

# ── temp helper scripts (self-contained; cleaned on exit) ──────────────────
TMP="$(mktemp -d)"
SMTP_PY="$TMP/smtp.py"; JMAP_PY="$TMP/jmap.py"; PROBE_LOG="$TMP/reach.log"
cat > "$SMTP_PY" <<'PY'
import sys,socket,smtplib
MODE,HOST,PORT=sys.argv[1],sys.argv[2],int(sys.argv[3])
if MODE=="probe":
    try:
        s=socket.create_connection((HOST,PORT),timeout=5); s.settimeout(5)
        b=s.recv(128).decode(errors="replace").strip(); s.close()
        print("OK" if b.startswith("220") else "BAD")
    except Exception as e: print("FAIL")
else:
    ADDR,subj,mid=sys.argv[4],sys.argv[5],sys.argv[6]
    try:
        srv=smtplib.SMTP(HOST,PORT,timeout=15); srv.helo("dr-probe.example.test")
        srv.sendmail("ext-sender@example.test",[ADDR],
            f"From: ext-sender@example.test\r\nTo: {ADDR}\r\nSubject: {subj}\r\nMessage-ID: <{mid}@example.test>\r\n\r\nbody {mid}\r\n")
        srv.quit(); print("delivered")
    except Exception as e: print(f"FAIL {type(e).__name__}")
PY
cat > "$JMAP_PY" <<'PY'
import os,sys,json,base64,urllib.parse as UP,urllib.request as U,urllib.error as E
B="http://stalwart-mgmt.mail.svc.cluster.local:8080"
MODE,ADDR=sys.argv[1],sys.argv[2]; pw=os.environ["MP"]
auth="Basic "+base64.b64encode(f"{ADDR}%master@local.host:{pw}".encode()).decode()
def toB(u): p=UP.urlsplit(u); return B+p.path+(("?"+p.query) if p.query else "")
def req(url,data=None,ctype="application/json"):
    r=U.Request(url,data=data); r.add_header("Authorization",auth)
    if data is not None: r.add_header("Content-Type",ctype)
    return U.urlopen(r,timeout=30)
if MODE=="auth":
    try: print("OK" if "capabilities" in json.load(req(B+"/.well-known/jmap")) else "BAD")
    except E.HTTPError as e: print(f"HTTP{e.code}")
    except Exception as e: print(f"ERR{type(e).__name__}")
    sys.exit(0)
sess=json.load(req(B+"/.well-known/jmap")); acct=sess["primaryAccounts"]["urn:ietf:params:jmap:mail"]
api=toB(sess["apiUrl"]); up=toB(sess["uploadUrl"].replace("{accountId}",acct))
def call(m,a): return json.load(req(api,json.dumps({"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],"methodCalls":[[m,{**a,"accountId":acct},"c0"]]}).encode()))["methodResponses"][0][1]
if MODE=="deliver":
    subj,mid=sys.argv[3],sys.argv[4]
    inbox=next((x["id"] for x in call("Mailbox/get",{"ids":None})["list"] if x.get("role")=="inbox"),None)
    raw=f"From: dr-seed@{ADDR.split('@')[1]}\r\nTo: {ADDR}\r\nSubject: {subj}\r\nMessage-ID: <{mid}@seed>\r\nDate: Wed, 02 Jul 2026 12:00:00 +0000\r\n\r\nbody {mid}\r\n".encode()
    blob=json.load(req(up,raw,ctype="message/rfc822"))["blobId"]
    r=call("Email/import",{"emails":{"e":{"blobId":blob,"mailboxIds":{inbox:True},"keywords":{}}}})
    print("delivered" if r.get("created") else f"FAIL {r.get('notCreated')}")
elif MODE=="read":
    ids=call("Email/query",{"limit":50}).get("ids",[])
    if not ids: print("SUBJECTS:"); sys.exit(0)
    g=call("Email/get",{"ids":ids,"properties":["subject"]})
    print("SUBJECTS:"+"|".join(sorted(s for s in (e.get("subject") for e in g["list"]) if s)))
PY

# ── cluster access ─────────────────────────────────────────────────────────
: "${ADMIN_HOST:?}" "${ADMIN_EMAIL:?}" "${ADMIN_PASSWORD:?}"
CURL="curl -sk --max-time 60"; API="$ADMIN_HOST/api/v1"
TOKEN=$($CURL -X POST "$API/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["token"])')
AH(){ $CURL -H "Authorization: Bearer $TOKEN" "$@"; }
jg(){ python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

hdr "PREFLIGHT"
ACTIVE=$(AH "$API/admin/mail/placement" | jg "d['data']['activeNode']")
ALL_NODES=$(echo "$MAIL_DR_NODE_MAP" | tr ',' '\n' | cut -d= -f1)
# bastion: any surviving node (!= active) to run kubectl through.
BASTION_NODE="${MAIL_DR_BASTION_NODE:-}"
if [ -z "$BASTION_NODE" ] || [ "$BASTION_NODE" = "$ACTIVE" ]; then
  for n in $ALL_NODES; do [ "$n" != "$ACTIVE" ] && { BASTION_NODE="$n"; break; }; done
fi
BASTION="root@$(node_addr "$BASTION_NODE")"; ACTIVE_ADDR="root@$(node_addr "$ACTIVE")"
kc(){ ssh $SSH_OPTS "$BASTION" "kubectl $*"; }
psql1(){ kc "exec -n platform \$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}') -- psql -U postgres -d platform -tA -c \"$1\"" 2>/dev/null | head -1 | tr -d ' '; }
# HA means ANY node loss must be recoverable — including a node hosting
# platform-api / system-db — so the standby is any node != active (override via
# STANDBY_NODE). PAPI/DB nodes are surfaced only as diagnostics.
PAPI_NODE=$(kc "get pod -n platform -l app=platform-api --field-selector=status.phase=Running -o jsonpath='{.items[0].spec.nodeName}'" 2>/dev/null)
DB_NODE=$(kc "get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].spec.nodeName}'" 2>/dev/null)
STANDBY="${STANDBY_NODE:-}"
if [ -z "$STANDBY" ]; then
  for n in $ALL_NODES; do [ "$n" != "$ACTIVE" ] && { STANDBY="$n"; break; }; done
fi
echo "active=$ACTIVE standby=$STANDBY bastion=$BASTION_NODE (papi=$PAPI_NODE db=$DB_NODE)"
MP=$(kc "get secret -n mail mail-secrets -o jsonpath='{.data.STALWART_MASTER_PASSWORD}' | base64 -d")
# Resolve the tenant-backup-tools image. Prefer the stalwart Deployment's
# restore-state init image ref (always resolvable) over the bastion's containerd
# cache (which may not have pulled it — that broke the first rc.3 run).
TOOLS="${TOOLS_IMAGE:-}"
[ -z "$TOOLS" ] && TOOLS=$(kc "get deploy -n mail stalwart-mail -o jsonpath='{range .spec.template.spec.initContainers[*]}{.image}{\"\n\"}{end}'" 2>/dev/null | grep tenant-backup-tools | head -1)
[ -z "$TOOLS" ] && TOOLS=$(ssh $SSH_OPTS "$BASTION" "k3s ctr images ls -q 2>/dev/null | grep tenant-backup-tools | grep -v sha256 | head -1")
[ -n "$MP" ] && [ -n "$TOOLS" ] || { red "missing master password or tools image"; exit 2; }
jmap(){ kc "exec -n mail dp-probe -- env MP='$MP' python3 /tmp/dpj.py $*" 2>/dev/null; }
smtp(){ python3 "$SMTP_PY" "$@"; }
# The mail hostname the served cert MUST cover (live value from ssl-status).
MAILHOST=$(AH "$API/admin/email-settings/ssl-status" | jg "d['data']['host']")
# cert_valid <node-ip> — the served mail cert (implicit-TLS :465) must be a REAL
# CA-issued cert that NAMES the mail host, NOT Stalwart's self-signed rcgen
# fallback (SAN=localhost). An invalid cert is a FAIL, never advisory: a
# self-signed / SAN-mismatched cert breaks every TLS-verifying IMAP/SMTP client
# and degrades outbound deliverability (the 2026-07-03 miss — mail was reported
# "healthy" while serving a self-signed cert for days).
cert_valid(){
  local ip="$1" out
  out=$(echo | timeout 10 openssl s_client -connect "$ip:465" -servername "$MAILHOST" 2>/dev/null | openssl x509 -noout -issuer -ext subjectAltName 2>/dev/null)
  echo "$out" | grep -qiE 'rcgen|self.?signed|CN *= *localhost' && return 1
  echo "$out" | grep -qi "DNS:$MAILHOST" && return 0
  return 1
}
# wait until master-user impersonation heals (post-restore credential drift)
wait_auth(){ local i; for i in $(seq 1 25); do [ "$(jmap auth "$ADDR")" = OK ] && return 0; sleep 12; done; return 1; }
# read with retry (eventual consistency after restore)
has(){ local subj="$1" i r; for i in $(seq 1 8); do r=$(jmap read "$ADDR" | grep SUBJECTS); echo "$r" | grep -qF "$subj" && return 0; sleep 6; done; return 1; }

CID=""; PROBE_PID=""
cleanup(){
  hdr "TEARDOWN"
  [ -n "$PROBE_PID" ] && kill "$PROBE_PID" 2>/dev/null
  ssh $SSH_OPTS "$ACTIVE_ADDR" 'systemctl start k3s' 2>&1 | head -1 || true
  # best-effort failback to primary if we're still on the standby
  local onnode; onnode=$(kc "get pod -n mail -l app=stalwart-mail -o jsonpath='{.items[0].spec.nodeName}'" 2>/dev/null)
  if [ "$onnode" = "$STANDBY" ]; then
    echo "failing back $STANDBY → $ACTIVE (retry x3)"
    local a; for a in 1 2 3; do
      # only fire once the target is Ready
      [ "$(kc "get node $ACTIVE -o jsonpath='{.status.conditions[?(@.type==\"Ready\")].status}'" 2>/dev/null)" = True ] || sleep 20
      AH -X POST "$API/admin/mail/failback" -H 'Content-Type: application/json' -d '{"confirm":true}' -o /dev/null
      local b st; for b in $(seq 1 40); do st=$(kc "get pod -n mail -l app=stalwart-mail -o jsonpath='{.items[0].spec.nodeName}'" 2>/dev/null); [ "$st" = "$ACTIVE" ] && break; sleep 10; done
      [ "$st" = "$ACTIVE" ] && break
    done
  fi
  # restore original DR config + labels + seed
  AH -X PATCH "$API/admin/mail/placement" -H 'Content-Type: application/json' -d '{"primaryNode":"'"$ACTIVE"'","secondaryNode":null,"autoFailoverEnabled":false,"failoverThresholdSeconds":300}' -o /dev/null 2>/dev/null || true
  kc "label node $STANDBY insula.host/mail-standby- " >/dev/null 2>&1 || true
  kc "delete pod -n mail dp-probe --ignore-not-found --wait=false" >/dev/null 2>&1 || true
  kc "delete job -n mail -l dp-dataplane --ignore-not-found --wait=false" >/dev/null 2>&1 || true
  [ -n "$CID" ] && AH -X DELETE "$API/tenants/$CID" -o /dev/null 2>/dev/null || true
  rm -rf "$TMP"
  hdr "RESULT: PASS=$PASS FAIL=$FAIL"
  [ "$FAIL" -eq 0 ] && green "DATA-PLANE DR: GREEN" || red "DATA-PLANE DR: $FAIL failure(s)"
}
trap cleanup EXIT

hdr "SETUP: standby + placement + probe mailbox"
kc "label node $STANDBY insula.host/mail-standby=true --overwrite" >/dev/null
AH -X PATCH "$API/admin/mail/placement" -H 'Content-Type: application/json' -d '{"primaryNode":"'"$ACTIVE"'","secondaryNode":"'"$STANDBY"'","autoFailoverEnabled":true,"failoverThresholdSeconds":60}' >/dev/null
PLAN=$(AH "$API/plans?limit=20" | python3 -c "import json,sys;ps=json.load(sys.stdin)['data'];print((next((p for p in ps if p.get('name')=='Starter'),None) or ps[0])['id'])")
REGION=$(AH "$API/regions?limit=1" | jg "d['data'][0]['id']")
CID=$(AH -X POST "$API/tenants" -H 'Content-Type: application/json' -d "{\"name\":\"itest-drdp\",\"primary_email\":\"drdp-itest@example.test\",\"plan_id\":\"$PLAN\",\"region_id\":\"$REGION\"}" | jg "d['data']['id']")
AH -X POST "$API/admin/tenants/$CID/provision" -H 'Content-Type: application/json' -d '{}' -o /dev/null
for i in $(seq 1 60); do [ "$(AH "$API/tenants/$CID" | jg "d['data']['status']")" = active ] && break; sleep 4; done
DID=$(AH -X POST "$API/tenants/$CID/domains" -H 'Content-Type: application/json' -d '{"domain_name":"'"$DOMAIN"'","dns_mode":"primary"}' | jg "d['data']['id']")
EDID=$(AH -X POST "$API/tenants/$CID/email/domains/$DID/enable" -H 'Content-Type: application/json' -d '{}' | jg "d['data'].get('id')")
AH -X POST "$API/tenants/$CID/email/domains/$EDID/mailboxes" -H 'Content-Type: application/json' -d '{"local_part":"dr-probe"}' -o /dev/null
kc "run dp-probe -n mail --restart=Never --image='$TOOLS' --image-pull-policy=IfNotPresent --command -- sleep 3600" >/dev/null 2>&1
for i in $(seq 1 20); do [ "$(kc "get pod -n mail dp-probe -o jsonpath='{.status.phase}'" 2>/dev/null)" = Running ] && break; sleep 3; done
ssh $SSH_OPTS "$BASTION" "cat > /tmp/dpj.py" < "$JMAP_PY"
kc "cp /tmp/dpj.py mail/dp-probe:/tmp/dpj.py" >/dev/null 2>&1
wait_auth || { no "master-auth never healed at setup"; exit 1; }
green "setup complete (tenant=$CID)"

ST=$(psql1 "SELECT extract(epoch from now())::int;"); [ -n "$ST" ] || ST=$$
M1="DR-M1-$ST"; M1B="DR-M1B-$ST"; M2="DR-M2-$ST"; M3="DR-M3-$ST"

hdr "SEED DATA (M1 pre-snapshot, snapshot, M1B post-snapshot)"
jmap deliver "$ADDR" "$M1" "m1$ST"
SJ="dp-snap-$ST"; kc "create job -n mail $SJ --from=cronjob/stalwart-snapshot" >/dev/null 2>&1
for i in $(seq 1 40); do [ "$(kc "get job -n mail $SJ -o jsonpath='{.status.succeeded}'" 2>/dev/null)" = 1 ] && break; sleep 4; done
kc "label job -n mail $SJ dp-dataplane=1 --overwrite" >/dev/null 2>&1 || true
jmap deliver "$ADDR" "$M1B" "m1b$ST"
has "$M1" && ok "M1 delivered + readable pre-failover" || no "M1 not readable pre-failover"

hdr "FAILOVER: reachability prober + stop k3s on $ACTIVE"
S_STANDBY=$(node_addr "$STANDBY"); S_BASTION=$(node_addr "$BASTION_NODE")
: > "$PROBE_LOG"
( for r in $(seq 1 300); do t=$(date +%s); for h in "$S_BASTION" "$S_STANDBY"; do echo "$t $h $(python3 "$SMTP_PY" probe "$h" 25)"; done >> "$PROBE_LOG"; sleep 2; done ) & PROBE_PID=$!
# Resolve the source node's local-path mail data dir BEFORE stopping k3s (read
# via the surviving bastion — the PV object lives in etcd).
SRC_VOL=$(kc "get pvc -n mail mail-stack-data -o jsonpath='{.spec.volumeName}'" 2>/dev/null)
SRC_DATA_PATH=$(kc "get pv $SRC_VOL -o jsonpath='{.spec.local.path}'" 2>/dev/null)
ssh $SSH_OPTS "$ACTIVE_ADDR" 'systemctl stop k3s' 2>&1 | head -1
if [ "${NODE_LOSS_MODE:-}" = "wipe" ]; then
  # TRUE node-loss: destroy the source node's local-path mail store so recovery
  # is forced from BACKUP (restic/standby), not the surviving on-node PVC. This
  # is the scenario that exercises the restic-escalation + availability cutover
  # (a plain `systemctl stop k3s` leaves the local data intact → the pod just
  # reschedules with full data and never restores).
  if [ -n "$SRC_DATA_PATH" ]; then
    ssh $SSH_OPTS "$ACTIVE_ADDR" "rm -rf '$SRC_DATA_PATH'/* '$SRC_DATA_PATH'/.[!.]* 2>/dev/null; echo NODE-LOSS: wiped source mail store at '$SRC_DATA_PATH'" 2>&1 | head -1
  else
    red "NODE_LOSS_MODE=wipe but could not resolve source local-path dir — running as plain k3s-stop"
  fi
fi
PRE=$(psql1 "SELECT COUNT(*) FROM mail_migration_runs;"); NEWRUN=""; END=$(( $(date +%s)+BUDGET ))
while [ $(date +%s) -lt $END ]; do
  N=$(psql1 "SELECT COUNT(*) FROM mail_migration_runs;")
  echo "  [$(date +%H:%M:%S)] dr_state=$(psql1 "SELECT mail_dr_state FROM system_settings;") runs=$N (pre=$PRE)"
  [ "${N:-0}" -gt "${PRE:-0}" ] && { NEWRUN=$(psql1 "SELECT id FROM mail_migration_runs ORDER BY started_at DESC LIMIT 1;"); break; }
  sleep 20
done
[ -n "$NEWRUN" ] && ok "dr-watcher launched failover migration ($NEWRUN)" || { no "no failover migration within ${BUDGET}s"; exit 1; }
END=$(( $(date +%s)+540 ))
while [ $(date +%s) -lt $END ]; do R=$(psql1 "SELECT state FROM mail_migration_runs WHERE id='$NEWRUN';"); case "$R" in done) break;; failed|rolled-back|cancelled) break;; esac; sleep 5; done
sleep 5; NODE_NOW=$(kc "get pod -n mail -l app=stalwart-mail -o jsonpath='{.items[0].spec.nodeName}'" 2>/dev/null)
[ "$NODE_NOW" = "$STANDBY" ] && ok "failover relocated stalwart → $STANDBY" || no "stalwart not on standby (on $NODE_NOW)"
kill "$PROBE_PID" 2>/dev/null; PROBE_PID=""

hdr "REACHABILITY (metric) + recovery"
python3 - "$PROBE_LOG" "$S_BASTION" "$S_STANDBY" <<'PY'
import sys
log=sys.argv[1]
rows=[l.split(None,2) for l in open(log) if l.strip()]
for host in sys.argv[2:]:
    seq=sorted((int(r[0]), r[2].startswith("OK")) for r in rows if r[1]==host)
    if not seq: print(f"  {host}: no samples"); continue
    gap=0; gs=None
    for t,okp in seq:
        if not okp: gs=t if gs is None else gs; gap=max(gap,t-gs+2)
        else: gs=None
    print(f"  {host}: {sum(1 for _,o in seq if o)}/{len(seq)} OK, longest unreachable ~{gap}s")
PY
metric "^ mail-port outage window on surviving nodes during relocation (inbound SMTP retries → no loss)"
# reachability must be RESTORED by now on surviving nodes
sleep 5
r1=$(smtp probe "$S_BASTION" 25); r2=$(smtp probe "$S_STANDBY" 25)
[ "$r1" = OK ] && [ "$r2" = OK ] && ok "mail reachable again on surviving nodes post-failover" || no "mail NOT reachable post-failover ($S_BASTION=$r1 $S_STANDBY=$r2)"
# TLS: the new active must serve a VALID cert covering $MAILHOST (not the
# self-signed rcgen fallback a restore can leave behind). Invalid cert = FAIL.
cert_valid "$S_STANDBY" && ok "TLS: new active serves a valid cert for $MAILHOST" || no "TLS: new active serves an INVALID cert for $MAILHOST (self-signed/SAN-mismatch) — mail TLS is broken for clients"

hdr "DATA on new active (wait master-auth heal, retry reads)"
wait_auth || no "master-auth did not heal within ~5min post-failover"
has "$M1" && ok "D: M1 (in snapshot) survived failover" || no "D: M1 LOST after failover"
if has "$M1B"; then metric "RPO: M1B (post-snapshot) survived → standby-rsync captured it (RPO≈0)"; else metric "RPO: M1B (post-snapshot) LOST → restored from snapshot only (RPO = snapshot age)"; fi
smtp deliver "$S_STANDBY" 25 "$ADDR" "$M2" "m2$ST"; sleep 8
has "$M2" && ok "I: inbound SMTP :25 to new active delivered" || no "I: inbound SMTP delivery failed on new active"
jmap deliver "$ADDR" "$M3" "m3$ST" >/dev/null

hdr "FAILBACK → $ACTIVE (target-Ready gate + retry) and SYNC-BACK"
for i in $(seq 1 30); do [ "$(kc "get node $ACTIVE -o jsonpath='{.status.conditions[?(@.type==\"Ready\")].status}'" 2>/dev/null)" = True ] && break; sleep 6; done
FB_OK=0
for attempt in 1 2 3; do
  RID=$(AH -X POST "$API/admin/mail/failback" -H 'Content-Type: application/json' -d '{"confirm":true}' | jg "d['data']['runId']")
  [ -n "$RID" ] || { sleep 15; continue; }
  END=$(( $(date +%s)+600 ))
  while [ $(date +%s) -lt $END ]; do S=$(psql1 "SELECT state FROM mail_migration_runs WHERE id='$RID';"); case "$S" in done) FB_OK=1; break;; failed|rolled-back|cancelled) break;; esac; sleep 10; done
  [ "$FB_OK" = 1 ] && break
  echo "  failback attempt $attempt = $S; retrying"
done
NODE_FB=$(kc "get pod -n mail -l app=stalwart-mail -o jsonpath='{.items[0].spec.nodeName}'" 2>/dev/null)
[ "$NODE_FB" = "$ACTIVE" ] && ok "failback relocated stalwart → $ACTIVE" || no "failback did not return to $ACTIVE (on $NODE_FB)"
wait_auth || no "master-auth did not heal post-failback"
SUBS=$(jmap read "$ADDR")
for m in "$M1" "$M2" "$M3"; do echo "$SUBS" | grep -qF "$m" && ok "S: $m present on reactivated $ACTIVE" || no "S: $m MISSING on $ACTIVE after failback"; done
echo "final subjects: $SUBS"
# TLS on the reactivated primary must ALSO be valid — a failback restore can
# reset the cert just like a failover. Invalid cert = FAIL.
cert_valid "$(node_addr "$ACTIVE")" && ok "TLS: reactivated $ACTIVE serves a valid cert for $MAILHOST" || no "TLS: reactivated $ACTIVE serves an INVALID cert for $MAILHOST (self-signed/SAN-mismatch)"
# cleanup + result printed by trap
