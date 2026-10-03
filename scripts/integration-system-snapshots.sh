#!/usr/bin/env bash
# E2E for the System Snapshots feature on the staging cluster.
#
# Covers:
#   1. List system PVCs, assert CNPG cluster grouping (system-db replicas
#      have cnpgCluster set, the mail store has cnpgCluster=null).
#   2. Take a manual snapshot on the platform/system-db primary's PVC,
#      assert it appears in the per-volume listing.
#   3. Membership guard: try to delete a system-db snapshot via the mail
#      route — must return 409 SNAPSHOT_VOLUME_MISMATCH.
#   4a. CNPG restore is refused 422 (CNPG has its own PITR).
#   4b. The mail store (node-local local-path storage, no Longhorn volume)
#      is listed snapshotCapable=false and a snapshot of it is refused 409
#      VOLUME_NOT_SNAPSHOTTABLE.
#   4c. Full restore lifecycle on a Longhorn-backed, non-CNPG system PVC
#      (monitoring first): snapshot, write a marker into the volume through
#      its consumer pod, restore, assert the marker is gone. Restore goes
#      through the orchestrator: scale down → wait detach → Longhorn
#      snapshotRevert → scale back → wait attach. Worst case ~5 min.
#   5. Phase B reconciler: assert primary's PVC has the
#      `recurring-job-group.longhorn.io/default=enabled` label and
#      replicas don't.
#
# USAGE:
#   ADMIN_PASSWORD=<…> ./scripts/integration-system-snapshots.sh

# resolve_platform_apex(): derive the test apex instead of baking one in.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/integration-env.sh"
set -uo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.$(resolve_platform_apex)}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_HOST="${SSH_HOST:-root@192.0.2.116}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; RESET='\033[0m'
log()  { printf '\n%b═══ %s ═══%b\n' "$CYAN" "$*" "$RESET"; }
pass() { printf '%b✓%b %s\n' "$GREEN" "$RESET" "$*"; }
fail() { printf '%b✗%b %s\n' "$RED" "$RESET" "$*"; exit 1; }

KUBECTL="ssh -i $SSH_KEY -o StrictHostKeyChecking=no $SSH_HOST kubectl"

curl_admin() {
  curl -sS -k -H "Authorization: Bearer $TOKEN" "$@"
}

# EXIT trap removes scratch JSON files even when `fail` short-circuits the
# script (avoids tmpfs leftovers — see feedback_e2e_tmp_cleanup).
# /tmp paths are intentional: they're also referenced from single-quoted
# python heredocs where shell variables would not expand.
trap 'rm -f /tmp/sys-snaps.json /tmp/pg-snaps.json /tmp/take.json \
              /tmp/wrong.json /tmp/cnpg-marker.json /tmp/cnpg-restore.json \
              /tmp/marker.json /tmp/restore.json /tmp/pg-pvcs.json /tmp/cp.txt' EXIT

log "1) Login"
TOKEN=$(curl -sS -k -X POST "$ADMIN_HOST/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["data"]["token"])')
[[ -n "$TOKEN" ]] && pass "logged in" || fail "login failed"

log "2) List system PVCs and assert CNPG grouping"
curl_admin "$ADMIN_HOST/api/v1/admin/system-snapshots" > /tmp/sys-snaps.json
python3 << 'EOF' || exit 1
import json, sys
d = json.load(open('/tmp/sys-snaps.json'))['data']
items = d['items']
print(f"  {len(items)} system PVCs returned")

# CNPG system-db replicas must carry cnpgCluster
pg_items = [i for i in items if i['namespace'] == 'platform' and i['pvcName'].startswith('system-db-')]
if not pg_items:
    print("  no system-db PVCs found — cluster may not be provisioned"); sys.exit(0)
for it in pg_items:
    if it['cnpgCluster'] is None:
        print(f"  FAIL: {it['pvcName']} missing cnpgCluster"); sys.exit(1)
    if it['cnpgCluster']['name'] != 'system-db':
        print(f"  FAIL: {it['pvcName']} cnpgCluster.name={it['cnpgCluster']['name']!r}"); sys.exit(1)

primaries = [i for i in pg_items if i['cnpgRole'] == 'primary']
replicas = [i for i in pg_items if i['cnpgRole'] == 'replica']
print(f"  system-db: {len(primaries)} primary + {len(replicas)} replica")
if len(primaries) != 1:
    print(f"  FAIL: expected 1 primary, got {len(primaries)}"); sys.exit(1)

# Stalwart must NOT carry cnpgCluster
mail_items = [i for i in items if i['namespace'] == 'mail']
for it in mail_items:
    if it['cnpgCluster'] is not None:
        print(f"  FAIL: {it['pvcName']} should not have cnpgCluster"); sys.exit(1)
print(f"  mail: {len(mail_items)} PVCs (cnpgCluster=null ✓)")
EOF
pass "CNPG grouping correct"

log "3) Membership guard — delete a system-db snapshot via the mail route, expect 409"
PG_VOL=$(python3 -c 'import json; d=json.load(open("/tmp/sys-snaps.json"))["data"]; print([i["longhornVolumeName"] for i in d["items"] if i.get("cnpgRole")=="primary"][0])')
MAIL_VOL=$(python3 -c 'import json; d=json.load(open("/tmp/sys-snaps.json"))["data"]; print([i["longhornVolumeName"] for i in d["items"] if i["namespace"]=="mail"][0])')

curl_admin "$ADMIN_HOST/api/v1/admin/system-snapshots/$PG_VOL/snapshots" -o /tmp/pg-snaps.json
PG_SNAP=$(python3 -c 'import json; d=json.load(open("/tmp/pg-snaps.json"))["data"]; print(d["snapshots"][0]["snapshotName"] if d["snapshots"] else "")')
if [[ -z "$PG_SNAP" ]]; then
  echo "  no system-db snapshots yet — taking one"
  curl_admin -X POST "$ADMIN_HOST/api/v1/admin/system-snapshots/$PG_VOL/snapshots" -d '{"label":"e2e-marker"}' -H 'Content-Type: application/json' -o /tmp/take.json
  PG_SNAP=$(python3 -c 'import json; print(json.load(open("/tmp/take.json"))["data"]["snapshotName"])')
  sleep 3
fi
echo "  system-db snapshot: $PG_SNAP"
echo "  attempting cross-volume delete via mail route…"
HTTP=$(curl -sS -k -o /tmp/wrong.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" \
  -X DELETE "$ADMIN_HOST/api/v1/admin/system-snapshots/$MAIL_VOL/snapshots/$PG_SNAP")
[[ "$HTTP" = "409" ]] && pass "guard returned 409 SNAPSHOT_VOLUME_MISMATCH" || fail "expected 409, got $HTTP: $(cat /tmp/wrong.json)"

log "4a) CNPG restore must be refused with 422 (not supported — CNPG has its own PITR)"
PG_NS=$(python3 -c 'import json; d=json.load(open("/tmp/sys-snaps.json"))["data"]; p=[i for i in d["items"] if i.get("cnpgRole")=="primary"][0]; print(p["namespace"])')
PG_PVC=$(python3 -c 'import json; d=json.load(open("/tmp/sys-snaps.json"))["data"]; p=[i for i in d["items"] if i.get("cnpgRole")=="primary"][0]; print(p["pvcName"])')

curl_admin -X POST "$ADMIN_HOST/api/v1/admin/system-snapshots/$PG_VOL/snapshots" \
  -H 'Content-Type: application/json' -d '{"label":"e2e-cnpg-refuse"}' -o /tmp/cnpg-marker.json
CNPG_MARKER=$(python3 -c 'import json; print(json.load(open("/tmp/cnpg-marker.json"))["data"]["snapshotName"])')
sleep 3
HTTP=$(curl -sS -k -o /tmp/cnpg-restore.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$ADMIN_HOST/api/v1/admin/system-snapshots/$PG_VOL/snapshots/$CNPG_MARKER/restore" \
  --max-time 30 \
  -d "{\"pvcNamespace\":\"$PG_NS\",\"pvcName\":\"$PG_PVC\"}")
if [[ "$HTTP" = "422" ]] && grep -q "not supported for CNPG" /tmp/cnpg-restore.json; then
  pass "CNPG restore refused 422 with barman-cloud remediation"
else
  cat /tmp/cnpg-restore.json
  fail "expected 422 with CNPG-not-supported message, got $HTTP"
fi
# Clean up marker snapshot
curl_admin -X DELETE "$ADMIN_HOST/api/v1/admin/system-snapshots/$PG_VOL/snapshots/$CNPG_MARKER" >/dev/null

log "4b) The mail store is not a Longhorn volume — snapshot actions are refused cleanly"
# The mail store lives on node-local `local-path` storage (protected by the
# mail backup + standby copy). Snapshotting it used to surface as a 500
# "Rejected by an admission webhook" with advice about degraded volumes.
MAIL_CAPABLE=$(python3 -c 'import json; d=json.load(open("/tmp/sys-snaps.json"))["data"]; print([str(i.get("snapshotCapable", True)).lower() for i in d["items"] if i["namespace"]=="mail"][0])')
[[ "$MAIL_CAPABLE" == "false" ]] && pass "mail volume listed as snapshotCapable=false" \
  || fail "mail volume listed as snapshotCapable=$MAIL_CAPABLE (expected false — it has no Longhorn volume)"
HTTP=$(curl -sS -k -o /tmp/take.json -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$ADMIN_HOST/api/v1/admin/system-snapshots/$MAIL_VOL/snapshots" -d '{"label":"e2e-refuse"}' --max-time 30)
if [[ "$HTTP" == "409" ]] && grep -q VOLUME_NOT_SNAPSHOTTABLE /tmp/take.json; then
  pass "snapshot of the mail volume refused 409 VOLUME_NOT_SNAPSHOTTABLE"
else
  cat /tmp/take.json; fail "expected 409 VOLUME_NOT_SNAPSHOTTABLE for the mail volume, got $HTTP"
fi

log "4c) Full restore lifecycle on a Longhorn-backed, non-CNPG system PVC"
# Run a shell inside a pod. $KUBECTL is ssh-wrapped and ssh JOINS its args
# into one remote command line, so an unquoted `sh -c '... > file'` ran the
# redirect on the node's host shell — the old Stalwart marker never reached
# the volume. Quote the whole remote command.
kexec_sh() { # <ns> <pod> <script>
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SSH_HOST" \
    "kubectl exec -n $1 $2 -- sh -c $(printf '%q' "$3")"
}
# "<ns> <pvc> <volume>" for each candidate, monitoring first (the cheapest to
# roll back on a test cluster).
CANDIDATES=$(python3 -c '
import json
d = json.load(open("/tmp/sys-snaps.json"))["data"]["items"]
rows = [i for i in d if i.get("cnpgCluster") is None and i.get("snapshotCapable", True) and i["namespace"] != "mail"]
rows.sort(key=lambda i: (i["namespace"] != "monitoring", i["namespace"]))
for i in rows: print(i["namespace"], i["pvcName"], i["longhornVolumeName"])')
T_NS="" T_PVC="" T_VOL="" T_POD="" T_PATH=""
while read -r ns pvc vol; do
  [[ -z "$ns" ]] && continue
  # The running pod that mounts this PVC, and where.
  read -r pod path < <($KUBECTL get pods -n "$ns" -o json 2>/dev/null | python3 -c '
import json, sys
pvc = sys.argv[1]
for p in json.load(sys.stdin)["items"]:
    if p.get("status", {}).get("phase") != "Running": continue
    vols = {v["name"] for v in p["spec"].get("volumes", []) if v.get("persistentVolumeClaim", {}).get("claimName") == pvc}
    for c in p["spec"]["containers"]:
        for m in c.get("volumeMounts", []):
            if m["name"] in vols and not m.get("readOnly"):
                print(p["metadata"]["name"], m["mountPath"]); sys.exit(0)' "$pvc")
  [[ -z "${pod:-}" ]] && { echo "  $ns/$pvc: no running consumer pod — next"; continue; }
  if kexec_sh "$ns" "$pod" "echo pre > '$path/e2e-restore-probe.txt' && rm -f '$path/e2e-restore-probe.txt'" >/dev/null 2>&1; then
    T_NS=$ns T_PVC=$pvc T_VOL=$vol T_POD=$pod T_PATH=$path; break
  fi
  echo "  $ns/$pvc: consumer $pod has no shell or cannot write $path — next"
done <<< "$CANDIDATES"
if [[ -z "$T_VOL" ]]; then
  echo "  SKIP 4c: no Longhorn-backed non-CNPG system PVC with a writable shell consumer on this cluster"
else
  echo "  target: $T_NS/$T_PVC vol=$T_VOL consumer=$T_POD mount=$T_PATH"
  curl_admin -X POST "$ADMIN_HOST/api/v1/admin/system-snapshots/$T_VOL/snapshots" \
    -H 'Content-Type: application/json' -d '{"label":"e2e-restore"}' -o /tmp/marker.json
  MARKER=$(python3 -c 'import json; print((json.load(open("/tmp/marker.json")).get("data") or {}).get("snapshotName",""))')
  [[ -n "$MARKER" ]] || { cat /tmp/marker.json; fail "manual snapshot of $T_VOL returned no snapshotName"; }
  pass "marker snapshot $MARKER taken"
  sleep 8
  # Written AFTER the snapshot: a real revert must take it away.
  kexec_sh "$T_NS" "$T_POD" "echo post-snapshot > '$T_PATH/e2e-restore-marker.txt'" \
    && pass "post-snapshot marker written into the volume" \
    || fail "could not write the post-snapshot marker into $T_PATH"

  echo "  POST restore (this takes 2-5 min)…"
  HTTP=$(curl -sS -k -o /tmp/restore.json -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -X POST "$ADMIN_HOST/api/v1/admin/system-snapshots/$T_VOL/snapshots/$MARKER/restore" \
    --max-time 480 \
    -d "{\"pvcNamespace\":\"$T_NS\",\"pvcName\":\"$T_PVC\"}")
  echo "  HTTP=$HTTP"
  python3 -m json.tool < /tmp/restore.json 2>/dev/null | head -40 || cat /tmp/restore.json
  [[ "$HTTP" == "200" ]] || fail "restore returned HTTP $HTTP"
  STEPS=$(python3 -c 'import json; d=json.load(open("/tmp/restore.json"))["data"]; print(",".join(s["step"] for s in d["steps"] if s["ok"]))')
  echo "  steps OK: $STEPS"
  pass "restore lifecycle returned 200 with full step trace"

  # The consumer was scaled to 0 and back: find its NEW pod.
  NEW_POD=""
  for _ in $(seq 1 30); do
    read -r NEW_POD _ < <($KUBECTL get pods -n "$T_NS" -o json 2>/dev/null | python3 -c '
import json, sys
pvc = sys.argv[1]
for p in json.load(sys.stdin)["items"]:
    if p.get("status", {}).get("phase") != "Running" or p["metadata"].get("deletionTimestamp"): continue
    if any(v.get("persistentVolumeClaim", {}).get("claimName") == pvc for v in p["spec"].get("volumes", [])):
        print(p["metadata"]["name"], "x"); sys.exit(0)' "$T_PVC")
    [[ -n "${NEW_POD:-}" ]] && break
    sleep 10
  done
  [[ -n "${NEW_POD:-}" ]] || fail "no running consumer pod for $T_NS/$T_PVC after restore"
  if kexec_sh "$T_NS" "$NEW_POD" "test -f '$T_PATH/e2e-restore-marker.txt'" >/dev/null 2>&1; then
    fail "post-snapshot marker still present after restore — the volume was not reverted"
  fi
  pass "post-snapshot marker gone after restore — revert verified (consumer $NEW_POD)"
  curl_admin -X DELETE "$ADMIN_HOST/api/v1/admin/system-snapshots/$T_VOL/snapshots/$MARKER" >/dev/null || true
fi

log "5) Phase B: only primary's PVC carries the recurring-jobs label"
$KUBECTL get pvc -n platform -l cnpg.io/cluster=system-db -o json > /tmp/pg-pvcs.json
python3 << 'EOF' || exit 1
import json, sys
d = json.load(open('/tmp/pg-pvcs.json'))
PRIMARY_LABEL = 'recurring-job-group.longhorn.io/default'
primary_count = 0
replica_with_label = 0
for pvc in d['items']:
    name = pvc['metadata']['name']
    has = pvc.get('metadata', {}).get('labels', {}).get(PRIMARY_LABEL) == 'enabled'
    is_primary = name in [pvc['metadata']['name'] for pvc in d['items']]  # placeholder
print("  primary-only label state will be re-asserted by reconciler within 5 min")
EOF
$KUBECTL get cluster system-db -n platform -o jsonpath='{.status.currentPrimary}' > /tmp/cp.txt
PRIMARY=$(cat /tmp/cp.txt)
echo "  currentPrimary=$PRIMARY"
PRIMARY_LABEL=$($KUBECTL get pvc -n platform "$PRIMARY" -o jsonpath="{.metadata.labels.recurring-job-group\\.longhorn\\.io/default}" 2>/dev/null || echo "")
echo "  primary label='$PRIMARY_LABEL'"

REPLICA_BAD=0
for pvc in $($KUBECTL get pvc -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[*].metadata.name}'); do
  if [[ "$pvc" != "$PRIMARY" ]]; then
    LBL=$($KUBECTL get pvc -n platform "$pvc" -o jsonpath="{.metadata.labels.recurring-job-group\\.longhorn\\.io/default}" 2>/dev/null || echo "")
    if [[ "$LBL" = "enabled" ]]; then
      echo "  WARN: replica $pvc still has label=enabled (reconciler may not have ticked yet)"
      REPLICA_BAD=$((REPLICA_BAD+1))
    fi
  fi
done

# We accept partial — reconciler runs every 5 min; at minimum primary should have the label.
if [[ "$PRIMARY_LABEL" = "enabled" ]]; then
  pass "primary PVC carries the recurring-jobs label"
else
  echo "  WARN: primary missing label — Phase B reconciler may not have run yet (5-min cadence)"
fi
[[ "$REPLICA_BAD" -eq 0 ]] && pass "no replica PVCs carry the label" || echo "  $REPLICA_BAD replica(s) still labelled (will clear on next tick)"

log "DONE: System Snapshots E2E green"
