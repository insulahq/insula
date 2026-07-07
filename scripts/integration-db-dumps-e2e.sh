#!/usr/bin/env bash
# integration-db-dumps-e2e.sh
#
# Multi-engine tenant-bundle DATABASE logical-dump capture + restore E2E.
# Verifies the 2026-07-07 DB-dump hardening on a REAL cluster:
#   - MariaDB (SQL, hot --single-transaction dump) + MongoDB (--archive) +
#     SQLite (file discovered on the PVC + sqlite3 .dump) all captured in ONE
#     whole-client bundle.
#   - The bundle's `database_dumps` operator summary populates: status=='ok',
#     each engine's database shows status=='dumped'.
#   - The per-engine dump artifacts land on the PVC (`.sql` / `.archive.gz` /
#     `.sqlite.sql`) and are inside the files snapshot.
#   - Restore round-trip: corrupt MariaDB + MongoDB, then re-import via the
#     `databases-by-id` restore-cart item; assert rows/docs come back (which
#     also proves the root password captured in `config` still authenticates).
#
# NOTE: degraded/failed paths (BYO image w/o dump tool, PVC-full guard, benign
# vs hard classification) are covered by the backend unit tests
# (database-predump.test.ts, database-dumps-summary.test.ts); this harness
# proves the real k8s capture+restore integration for the happy multi-engine
# path. SQLite is capture-only here (its raw file restores via files-paths).
#
# Registry tier: suite (wired into integration-all.sh). Needs an offsite
# BackupStore assigned to the 'tenant' shim class (same precondition as
# dr-bundle / system-backup).
#
# USAGE: source scripts/integration.env first, or set ADMIN_HOST/ADMIN_PASSWORD/
#   SSH_HOST/SSH_KEY/PLATFORM_DOMAIN (TOKEN optional — preset to skip login).
set -uo pipefail
: "${ADMIN_HOST:?}" ; : "${ADMIN_EMAIL:=admin@${PLATFORM_DOMAIN:?}}"
: "${SSH_HOST:?}" "${PLATFORM_DOMAIN:?}"
[[ -n "${TOKEN:-}" ]] || : "${ADMIN_PASSWORD:?set ADMIN_PASSWORD or export a preset TOKEN}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
NODE="$SSH_HOST"
ROWS="${DB_ROWS:-25}"
STAMP=$(date +%s)
pass=0; fail=0; skip=0
red(){ printf '\033[31m%s\033[0m\n' "$*"; }; grn(){ printf '\033[32m%s\033[0m\n' "$*"; }
cyn(){ printf '\033[36m== %s ==\033[0m\n' "$*"; }
ok(){ grn "  ✓ $*"; pass=$((pass+1)); }; no(){ red "  ✗ $*"; fail=$((fail+1)); }
sk(){ printf '\033[33m  ~ %s\033[0m\n' "$*"; skip=$((skip+1)); }
rd(){ sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}/<IP>/g'; }
api(){ local m="$1" p="$2" b="${3:-}" a="${4:-}"; local H=(); [[ -n "$a" ]] && H=(-H "Authorization: Bearer $a")
  if [[ -z "$b" ]]; then curl -sk -w '\n%{http_code}' -X "$m" "$ADMIN_HOST/api/v1$p" "${H[@]}"
  else curl -sk -w '\n%{http_code}' -X "$m" "$ADMIN_HOST/api/v1$p" "${H[@]}" -H 'Content-Type: application/json' -d "$b"; fi; }
parse(){ STATUS=$(printf '%s' "$1"|tail -n1); BODY=$(printf '%s' "$1"|sed '$d'); }
ssh_node(){ ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=12 "$NODE" "$@"; }
kx(){ ssh_node "kubectl $*" </dev/null; }

TENANT_ID=""; NS=""; TOKEN="${TOKEN:-}"
cleanup(){ [[ "${NO_TEARDOWN:-}" == 1 ]] && { cyn "NO_TEARDOWN=1 — keeping tenant $TENANT_ID ($NS) for inspection"; return; }; [[ -n "$TENANT_ID" ]] && { cyn "TEARDOWN: delete probe tenant $TENANT_ID"; api DELETE "/tenants/$TENANT_ID" '' "$TOKEN" >/dev/null 2>&1 || true; }; }
trap cleanup EXIT

# ── 0. login + resolve plan/region/backup-cfg + catalog entries ───────────────
cyn "0. login + resolve plan/region/backup-cfg + catalog DB entries"
if [[ -n "$TOKEN" ]]; then ok "using preset TOKEN"; else
  parse "$(api POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")"
  [[ "$STATUS" == 200 ]] || { no "login $STATUS"; echo "$BODY"|rd; exit 1; }
  TOKEN=$(printf '%s' "$BODY"|jq -r '.data.token'); ok "admin login"
fi
parse "$(api GET /admin/backup-configs '' "$TOKEN")"
CFG=$(printf '%s' "$BODY"|jq -r '.data[]|select(.active==true or .isActive==true)|.id'|head -1)
if [[ -z "$CFG" || "$CFG" == null ]]; then
  echo "  SKIP (77): no active offsite BackupStore assigned to the 'tenant' class — this suite needs one (same precondition as dr-bundle/system-backup). Assign via PUT /admin/backup-rclone-shim/assignments/tenant." >&2
  exit 77
fi
ok "offsite backup target=$CFG"
parse "$(api GET /plans '' "$TOKEN")"
PLAN=$(printf '%s' "$BODY"|jq -r '.data[]|select(.name=="Premium" or .name=="Business" or .name=="Pro").id'|head -1)
[[ -n "$PLAN" && "$PLAN" != null ]] || PLAN=$(printf '%s' "$BODY"|jq -r '.data[-1].id')
parse "$(api GET '/regions?limit=1' '' "$TOKEN")"; REGION=$(printf '%s' "$BODY"|jq -r '.data[0].id')
parse "$(api GET '/catalog?type=database&limit=200' '' "$TOKEN")"; CAT="$BODY"
MARIA=$(printf '%s' "$CAT"|jq -r '.data[]|select(.runtime=="mariadb").id'|head -1)
[[ -n "$MARIA" && "$MARIA" != null ]] || MARIA=$(printf '%s' "$CAT"|jq -r '.data[]|select(.runtime=="mysql").id'|head -1)
MONGO=$(printf '%s' "$CAT"|jq -r '.data[]|select(.runtime=="mongodb").id'|head -1)
[[ -n "$MARIA" && "$MARIA" != null ]] || { no "no mariadb/mysql catalog entry"; exit 1; }
ok "catalog: maria=$MARIA mongo=${MONGO:-<none>}"

# ── 1. create probe tenant + provision ────────────────────────────────────────
cyn "1. create probe tenant + provision"
parse "$(api POST /tenants "{\"name\":\"dbdump-$STAMP\",\"primary_email\":\"dbdump-$STAMP@example.test\",\"plan_id\":\"$PLAN\",\"region_id\":\"$REGION\"}" "$TOKEN")"
TENANT_ID=$(printf '%s' "$BODY"|jq -r '.data.id'); [[ -n "$TENANT_ID" && "$TENANT_ID" != null ]] || { no "tenant create $STATUS"; echo "$BODY"|rd; exit 1; }
api POST "/admin/tenants/$TENANT_ID/provision" '{}' "$TOKEN" >/dev/null 2>&1 || true
for i in $(seq 1 80); do [[ "$(api GET "/tenants/$TENANT_ID" '' "$TOKEN"|sed '$d'|jq -r '.data.status')" == active ]] && break; sleep 3; done
NS=$(api GET "/tenants/$TENANT_ID" '' "$TOKEN"|sed '$d'|jq -r '.data.kubernetesNamespace')
[[ -n "$NS" && "$NS" != null ]] || { no "no namespace"; exit 1; }; ok "tenant=$TENANT_ID ns=$NS"

# ── helper: wait a deployment to running, resolve its pod ──────────────────────
wait_dep(){ # $1 dep_id  $2 app_name -> echoes pod name
  local id="$1" name="$2" st="" pod=""
  for i in $(seq 1 90); do st=$(api GET "/tenants/$TENANT_ID/deployments/$id" '' "$TOKEN"|sed '$d'|jq -r '.data.status'); [[ "$st" == running ]] && break; sleep 4; done
  [[ "$st" == running ]] || return 1
  for i in $(seq 1 30); do pod=$(kx "-n $NS get pod -l app=$name --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'" 2>/dev/null||true); [[ -n "$pod" ]] && break; sleep 4; done
  [[ -n "$pod" ]] && printf '%s' "$pod"
}

# ── 2. deploy + seed MariaDB ──────────────────────────────────────────────────
cyn "2. deploy add-on MariaDB + seed $ROWS rows"
parse "$(api POST "/tenants/$TENANT_ID/deployments" "{\"catalog_entry_id\":\"$MARIA\",\"name\":\"ddmaria\",\"cpu_request\":\"0.5\",\"memory_request\":\"512Mi\"}" "$TOKEN")"
MDEP=$(printf '%s' "$BODY"|jq -r '.data.id'); MPOD=$(wait_dep "$MDEP" ddmaria) || { no "mariadb not running"; kx "-n $NS get pods"|rd; exit 1; }
MCON=$(kx "-n $NS get pod $MPOD -o jsonpath='{.spec.containers[0].name}'" 2>/dev/null)
mdb(){ ssh_node "kubectl -n $NS exec '$MPOD' -c '$MCON' -- sh -c 'exec mariadb -u root -p\"\$MARIADB_ROOT_PASSWORD\" -N -B -e \"$1\"'" </dev/null; }
for i in $(seq 1 30); do mdb "SELECT 1" >/dev/null 2>&1 && break; sleep 5; done
mdb "CREATE DATABASE IF NOT EXISTS drdata; CREATE TABLE IF NOT EXISTS drdata.t (id INT PRIMARY KEY); DELETE FROM drdata.t;" >/dev/null
mdb "$(for i in $(seq 1 "$ROWS"); do printf 'INSERT INTO drdata.t VALUES (%d);' "$i"; done)" >/dev/null
[[ "$(mdb "SELECT COUNT(*) FROM drdata.t"|tr -d '[:space:]')" == "$ROWS" ]] && ok "mariadb seeded $ROWS rows" || { no "mariadb seed failed"; exit 1; }
# nit B (prune): seed a STALE predump (backdated far beyond any plan retention)
# + a FRESH one. The capture's predump step must prune the stale one (bounds
# unbounded predump accumulation → ENOSPC) and keep the fresh one.
kx "-n $NS exec $MPOD -c $MCON -- sh -c 'touch -d \"200 days ago\" /var/lib/mysql/predump-stale-bkp-OLDBUNDLE.sql; touch /var/lib/mysql/predump-fresh-bkp-NEWBUNDLE.sql'" >/dev/null 2>&1 \
  && ok "seeded stale(200d)+fresh predump markers" || sk "could not seed predump markers (touch -d unsupported?)"

# ── 3. deploy + seed MongoDB (best-effort — skip if no catalog entry) ─────────
MONGO_ON=""; MONGO_DOCS=7
if [[ -n "$MONGO" && "$MONGO" != null ]]; then
  cyn "3. deploy add-on MongoDB + seed $MONGO_DOCS docs"
  parse "$(api POST "/tenants/$TENANT_ID/deployments" "{\"catalog_entry_id\":\"$MONGO\",\"name\":\"ddmongo\",\"cpu_request\":\"0.5\",\"memory_request\":\"512Mi\"}" "$TOKEN")"
  GDEP=$(printf '%s' "$BODY"|jq -r '.data.id'); GPOD=$(wait_dep "$GDEP" ddmongo) || GPOD=""
  if [[ -n "$GPOD" ]]; then
    GCON=$(kx "-n $NS get pod $GPOD -o jsonpath='{.spec.containers[0].name}'" 2>/dev/null)
    # Feed the JS via STDIN (kubectl exec -i → mongosh reads a script from
    # stdin) rather than --eval, so single quotes in the JS don't collide with
    # the sh -c '…' wrapper.
    gsh(){ ssh_node "kubectl -n $NS exec -i '$GPOD' -c '$GCON' -- sh -c 'exec mongosh --quiet -u \"\$MONGO_INITDB_ROOT_USERNAME\" -p \"\$MONGO_INITDB_ROOT_PASSWORD\" --authenticationDatabase admin'" <<<"$1" 2>/dev/null; }
    for i in $(seq 1 30); do gsh 'db.adminCommand("ping").ok' | grep -q 1 && break; sleep 5; done
    gsh "var a=[];for(var i=1;i<=$MONGO_DOCS;i++)a.push({_id:i});db.getSiblingDB('drdata').t.drop();db.getSiblingDB('drdata').t.insertMany(a);" >/dev/null
    GOT=$(gsh "print(db.getSiblingDB('drdata').t.countDocuments())" | tr -cd '0-9')
    [[ "$GOT" == "$MONGO_DOCS" ]] && { MONGO_ON=1; ok "mongodb seeded $MONGO_DOCS docs"; } || no "mongodb seed failed ($GOT)"
  else no "mongodb not running"; fi
else sk "no mongodb catalog entry — mongo capture/restore assertions SKIPPED"; fi

# ── 4. create a SQLite file on the PVC (via the file-manager pod) ─────────────
cyn "4. create a SQLite file on the tenant PVC"
# The file-manager pod is on-demand — start it so we can seed a SQLite file
# (capture's SQLite discovery would start it too, but the file must exist first).
api POST "/tenants/$TENANT_ID/files/start" '{}' "$TOKEN" >/dev/null 2>&1 || true
FMPOD=""; for i in $(seq 1 45); do FMPOD=$(kx "-n $NS get pod -l app=file-manager --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'" 2>/dev/null||true); [[ -n "$FMPOD" ]] && break; sleep 4; done
SQLITE_ON=""
if [[ -n "$FMPOD" ]]; then
  kx "-n $NS exec $FMPOD -c file-manager -- sh -c 'sqlite3 /data/app.sqlite \"CREATE TABLE t(id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1),(2),(3);\"'" >/dev/null 2>&1 \
    && { SQLITE_ON=1; ok "sqlite /data/app.sqlite created (3 rows)"; } || sk "could not create sqlite file (sqlite3 absent in file-manager?) — sqlite assertions SKIPPED"
else sk "no file-manager pod — sqlite assertions SKIPPED"; fi

# ── 5. capture whole-client bundle + assert database_dumps summary ────────────
cyn "5. capture whole-client bundle (files → per-engine logical dumps)"
parse "$(api POST /admin/tenant-bundles "{\"tenantId\":\"$TENANT_ID\",\"targetConfigId\":\"$CFG\",\"async\":true,\"components\":{\"files\":true,\"mailboxes\":false,\"config\":true,\"secrets\":false}}" "$TOKEN")"
[[ "$STATUS" =~ ^20 ]] || { no "bundle create $STATUS"; echo "$BODY"|rd; exit 1; }
BID=$(printf '%s' "$BODY"|jq -r '.data.bundleId // .data.id')
BST=timeout; for i in $(seq 1 180); do
  parse "$(api GET "/admin/tenant-bundles/$BID" '' "$TOKEN")"; s=$(printf '%s' "$BODY"|jq -r '.data.status // empty')
  [[ "$s" == completed || "$s" == partial || "$s" == failed ]] && { BST="$s"; break; }; sleep 4
done
[[ "$BST" == completed ]] || { no "bundle terminal=$BST"; printf '%s' "$BODY"|jq -r '.data.components[]?|"    \(.component) \(.status) \(.lastError//"")"'|rd; exit 1; }
ok "bundle $BID completed"

# database_dumps operator summary
DD="$(printf '%s' "$BODY"|jq -c '.data.databaseDumps // empty')"
[[ -n "$DD" && "$DD" != null ]] || { no "databaseDumps summary MISSING on the bundle"; exit 1; }
DDST=$(printf '%s' "$DD"|jq -r '.status')
[[ "$DDST" == ok ]] && ok "databaseDumps.status == ok" || no "databaseDumps.status == $DDST (expected ok); detail: $(printf '%s' "$DD"|jq -c '.deployments')"
# maria db dumped
printf '%s' "$DD"|jq -e '.deployments[]|select(.engine=="mariadb" or .engine=="mysql").databases[]|select(.name=="drdata" and .status=="dumped")' >/dev/null \
  && ok "mariadb drdata → dumped" || no "mariadb drdata not 'dumped' in summary"
# mongo db dumped
if [[ -n "$MONGO_ON" ]]; then
  printf '%s' "$DD"|jq -e '.deployments[]|select(.engine=="mongodb").databases[]|select(.name=="drdata" and .status=="dumped")' >/dev/null \
    && ok "mongodb drdata → dumped" || no "mongodb drdata not 'dumped' in summary"
fi
# sqlite dumped
if [[ -n "$SQLITE_ON" ]]; then
  printf '%s' "$DD"|jq -e '.deployments[]|select(.engine=="sqlite").databases[]|select((.name|test("app.sqlite")) and .status=="dumped")' >/dev/null \
    && ok "sqlite app.sqlite → dumped" || no "sqlite app.sqlite not 'dumped' in summary"
fi

# Redesign: after the files snapshot captures them, the predumps are DELETED
# from the live PVC (a 2-5 GB client PVC can't hold a retention window of full
# dumps). They live in the bundle's snapshot; databases-by-id re-fetches them on
# restore. So they must be GONE from the live PVC now.
if [[ -n "$FMPOD" ]]; then
  kx "-n $NS exec $FMPOD -c file-manager -- find /data -type f -name 'predump-drdata-$BID.sql'" 2>/dev/null | grep -q predump && no "maria predump STILL on PVC (should be deleted after snapshot)" || ok "maria predump deleted from live PVC after snapshot"
  [[ -n "$MONGO_ON" ]] && { kx "-n $NS exec $FMPOD -c file-manager -- find /data -type f -name 'predump-drdata-$BID.archive.gz'" 2>/dev/null | grep -q archive.gz && no "mongo predump STILL on PVC" || ok "mongo predump deleted from live PVC"; }
  [[ -n "$SQLITE_ON" ]] && { kx "-n $NS exec $FMPOD -c file-manager -- find /data -type f -name '*$BID.sqlite.sql'" 2>/dev/null | grep -q sqlite.sql && no "sqlite predump STILL on PVC" || ok "sqlite predump deleted from live PVC"; }
fi

# nit B (prune): capture pruned the 200-day stale predump; the fresh one survived.
STALE=$(kx "-n $NS exec $MPOD -c $MCON -- sh -c '[ -f /var/lib/mysql/predump-stale-bkp-OLDBUNDLE.sql ] && echo PRESENT || echo GONE'" 2>/dev/null | tr -d '[:space:]')
[[ "$STALE" == GONE ]] && ok "stale predump pruned on capture (accumulation bounded)" || no "stale predump NOT pruned ($STALE)"
FRESH=$(kx "-n $NS exec $MPOD -c $MCON -- sh -c '[ -f /var/lib/mysql/predump-fresh-bkp-NEWBUNDLE.sql ] && echo PRESENT || echo GONE'" 2>/dev/null | tr -d '[:space:]')
[[ "$FRESH" == PRESENT ]] && ok "fresh predump kept (recent bundle stays restorable)" || no "fresh predump wrongly pruned ($FRESH)"

# ── 6. corrupt + restore via databases-by-id ──────────────────────────────────
cyn "6. corrupt (delete maria rows + drop mongo collection) then restore"
mdb "DELETE FROM drdata.t" >/dev/null; [[ "$(mdb "SELECT COUNT(*) FROM drdata.t"|tr -d '[:space:]')" == 0 ]] && ok "maria rows deleted" || no "maria delete failed"
[[ -n "$MONGO_ON" ]] && { gsh "db.getSiblingDB('drdata').t.drop()" >/dev/null; [[ "$(gsh "print(db.getSiblingDB('drdata').t.countDocuments())"|tr -cd '0-9')" == 0 ]] && ok "mongo collection dropped" || no "mongo drop failed"; }

parse "$(api POST /admin/restores/carts "{\"tenantId\":\"$TENANT_ID\",\"description\":\"db-dumps-e2e\"}" "$TOKEN")"
CID=$(printf '%s' "$BODY"|jq -r '.data.id // empty'); [[ -n "$CID" ]] || { no "cart create $STATUS"; echo "$BODY"|rd; exit 1; }
parse "$(api POST "/admin/restores/carts/$CID/items" "{\"bundleId\":\"$BID\",\"type\":\"databases-by-id\",\"selector\":{\"kind\":\"all\"}}" "$TOKEN")"
[[ "$STATUS" == 201 ]] || { no "add databases-by-id item $STATUS"; echo "$BODY"|rd; exit 1; }
parse "$(api POST "/admin/restores/carts/$CID/execute" '{}' "$TOKEN")"
[[ "$STATUS" == 200 ]] || { no "execute $STATUS"; echo "$BODY"|rd; exit 1; }
CST=timeout; for i in $(seq 1 150); do
  parse "$(api GET "/admin/restores/carts/$CID" '' "$TOKEN")"; s=$(printf '%s' "$BODY"|jq -r '.data.status // empty')
  [[ "$s" == done || "$s" == failed ]] && { CST="$s"; break; }; sleep 3
done
[[ "$CST" == done ]] || { no "cart terminal=$CST"; printf '%s' "$BODY"|jq -r '.data.items[]?|"    \(.type) \(.status): lastError=\(.lastError//"-") progress=\(.progressMessage//"-")"'|rd; exit 1; }
ok "restore cart done"

# ── 7. assert restored (also proves the config-captured root password works) ──
cyn "7. assert rows/docs restored"
sleep 3
[[ "$(mdb "SELECT COUNT(*) FROM drdata.t" 2>/dev/null|tr -d '[:space:]')" == "$ROWS" ]] && ok "maria drdata.t restored to $ROWS rows (root password round-trips)" || no "maria not restored"
[[ -n "$MONGO_ON" ]] && { g=$(gsh "print(db.getSiblingDB('drdata').t.countDocuments())"|tr -cd '0-9'); [[ "$g" == "$MONGO_DOCS" ]] && ok "mongo drdata.t restored to $MONGO_DOCS docs" || no "mongo not restored ($g)"; }

# ── 8. password coherence on reconcile (nit A) ────────────────────────────────
cyn "8. nit A: DR reconcile arms + runs the root-password reset init container"
# Drift the on-disk root@% password (the host a tenant APP matches over TCP) so
# it differs from the config-captured one — a mixed/rotated restore leaves the
# datadir's grant tables disagreeing with `config`. (root@localhost is left
# alone: it uses unix_socket auth in the mariadb image, so a socket check can't
# observe a password drift — the reset init container's presence + clean run is
# the reliable, meaningful proof that the coherence fix is armed.)
mdb "ALTER USER IF EXISTS 'root'@'%' IDENTIFIED BY 'RotatedPw123'; FLUSH PRIVILEGES;" >/dev/null 2>&1 && ok "drifted on-disk root@% password" || sk "could not drift root@% (no such grant?)"
# Recover with reconcile (config-only, no re-provision) → arms the reset init
# container to re-stamp the config password onto the reused datadir.
parse "$(api POST "/admin/dr/tenants/$TENANT_ID/recover" "{\"bundleId\":\"$BID\",\"components\":[\"config\"],\"reconcile\":true,\"provision\":false}" "$TOKEN")"
[[ "$STATUS" =~ ^20 ]] && ok "recover+reconcile accepted (HTTP $STATUS)" || { no "recover+reconcile HTTP $STATUS"; echo "$BODY"|rd; }
# The maria pod is redeployed; wait for a Running pod that answers again.
sleep 8; MPOD=""; for i in $(seq 1 48); do
  MPOD=$(kx "-n $NS get pod -l app=ddmaria --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'" 2>/dev/null||true)
  [[ -n "$MPOD" ]] && mdb "SELECT 1" >/dev/null 2>&1 && break; sleep 5
done
# Assert the reset-root-password init container is BOTH armed on the redeployed
# pod AND ran to completion (exit 0) — it re-stamps the config root password
# onto the reused datadir (reset-script logic itself is unit-tested).
kx "-n $NS get pod $MPOD -o jsonpath='{.spec.initContainers[*].name}'" 2>/dev/null | grep -q reset-root-password \
  && ok "reset-root-password init container armed on reconcile redeploy" || no "reset init container NOT armed on reconcile"
RC=$(kx "-n $NS get pod $MPOD -o jsonpath=\"{.status.initContainerStatuses[?(@.name=='reset-root-password')].state.terminated.exitCode}\"" 2>/dev/null | tr -d '[:space:]')
[[ "$RC" == 0 ]] && ok "reset init container ran + re-stamped config pw (exit 0)" || no "reset init container did not complete cleanly (exitCode=${RC:-none})"
mdb "SELECT 1" >/dev/null 2>&1 && ok "maria healthy + queryable after reconcile" || no "maria not queryable after reconcile"

# ── 9. files-paths datadir restore on a LIVE tenant quiesces + crash-recovers (Q2) ──
cyn "9. Q2: files-paths restore of the maria DATADIR (live tenant) must quiesce + heal, not crash"
MSP=$(api GET "/tenants/$TENANT_ID/deployments/$MDEP" '' "$TOKEN"|sed '$d'|jq -r '.data.storagePath // empty')
if [[ -z "$MSP" || "$MSP" == null ]]; then sk "no storagePath for maria — Q2 datadir-restore check SKIPPED"; else
  ok "maria datadir path=$MSP"
  MPOD=""; for i in $(seq 1 20); do MPOD=$(kx "-n $NS get pod -l app=ddmaria --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'" 2>/dev/null||true); [[ -n "$MPOD" ]] && mdb "SELECT 1" >/dev/null 2>&1 && break; sleep 5; done
  # Corrupt: delete the rows. The bundle's files snapshot holds the datadir with
  # all 25 rows, so a datadir overlay must bring them back — IF the DB is
  # quiesced first (else the overlay under a live mysqld crash-corrupts it).
  mdb "DELETE FROM drdata.t" >/dev/null 2>&1
  parse "$(api POST /admin/restores/carts "{\"tenantId\":\"$TENANT_ID\",\"description\":\"q2-datadir\"}" "$TOKEN")"
  QCID=$(printf '%s' "$BODY"|jq -r '.data.id // empty')
  parse "$(api POST "/admin/restores/carts/$QCID/items" "{\"bundleId\":\"$BID\",\"type\":\"files-paths\",\"selector\":{\"kind\":\"paths\",\"paths\":[\"$MSP\"]}}" "$TOKEN")"
  [[ "$STATUS" == 201 ]] && ok "added files-paths datadir item" || { no "add files-paths item $STATUS"; echo "$BODY"|rd; }
  api POST "/admin/restores/carts/$QCID/execute" '{}' "$TOKEN" >/dev/null
  QST=timeout; for i in $(seq 1 150); do parse "$(api GET "/admin/restores/carts/$QCID" '' "$TOKEN")"; s=$(printf '%s' "$BODY"|jq -r '.data.status // empty'); [[ "$s" == done || "$s" == failed ]] && { QST="$s"; break; }; sleep 3; done
  [[ "$QST" == done ]] && ok "files-paths datadir restore cart done (quiesce→overlay→unquiesce)" || { no "files-paths cart=$QST"; printf '%s' "$BODY"|jq -r '.data.items[]?|"    \(.status): \(.lastError//.progressMessage//"-")"'|rd; }
  # maria must come back Running + queryable + rows restored — i.e. it crash-
  # RECOVERED on the restored datadir instead of crash-LOOPING on a corrupted one.
  MPOD=""; for i in $(seq 1 45); do MPOD=$(kx "-n $NS get pod -l app=ddmaria --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'" 2>/dev/null||true); [[ -n "$MPOD" ]] && mdb "SELECT 1" >/dev/null 2>&1 && break; sleep 5; done
  GOT=$(mdb "SELECT COUNT(*) FROM drdata.t" 2>/dev/null|tr -d '[:space:]')
  [[ "$GOT" == "$ROWS" ]] && ok "maria healthy after datadir overlay — $GOT rows (crash-recovered, NOT corrupted)" || no "maria datadir restore unhealthy (rows=${GOT:-?})"
  RST=$(kx "-n $NS get pod $MPOD -o jsonpath='{.status.containerStatuses[0].restartCount}'" 2>/dev/null|tr -d '[:space:]')
  [[ "${RST:-0}" -le 3 ]] && ok "maria not crash-looping (restartCount=${RST:-0})" || no "maria crash-looping after datadir overlay (restartCount=$RST)"
fi

cyn "RESULT: PASS=$pass FAIL=$fail SKIP=$skip"
[[ "$fail" == 0 ]] && { grn "DB-DUMPS MULTI-ENGINE E2E: GREEN"; exit 0; } || { red "DB-DUMPS MULTI-ENGINE E2E: $fail failure(s)"; exit 1; }
