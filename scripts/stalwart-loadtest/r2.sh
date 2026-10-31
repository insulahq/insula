#!/usr/bin/env bash
# r2.sh — second round of the Stalwart v1 store evaluation (ADR-065), on the questions the first
# round left open: the memory of every component including HA replicas, the
# total storage of each shape against today's RocksDB, backup and restore with the platform's own
# tools (IMAP and JMAP engines), what deleting mail and whole accounts frees, and blob storage that
# several nodes can share. Reuses lt.sh (sourced) and runs the same way, on a lab node as root:
#
#   ./r2.sh init
#   ./r2.sh store <variant>        ingest, settle, storage, memory under a mixed load, the platform's
#                                  mailbox backup and restore (IMAP and JMAP engines), store-level
#                                  backup and restore, deleting an account, deleting mail
#   ./r2.sh shape <variant[+tag]>  ingest, settle, storage, memory, reads — for the HA, memory-floor
#                                  and shared-blob shapes (env selects them, see dev-all)
#   ./r2.sh retention-min          v1-pg-fs with the shortest retention v1 allows: no deleted mail
#                                  kept by the spam classifier, hourly expunge and blob clean-up
#   ./r2.sh dev-all                every DEV (single-node) step in order, then report
#   ./r2.sh stg-all                the multi-node steps (staging: 3 servers)
#
# Results go to the same layout as lt.sh ($OUT), plus backup.jsonl (per mailbox and engine),
# restore-check.jsonl, retention.jsonl and store-backup.jsonl; report2.py turns them into tables.
set -uo pipefail
# shellcheck source=lt.sh
source "$(dirname "$0")/lt.sh"

IMG_TOOLS=${IMG_TOOLS:-ghcr.io/insulahq/insula/tenant-backup-tools:20261030110333-e0f6dea}  # DEV's pin
SOURCES=(big u001 u002 u003 u004 u005)   # mailboxes backed up and restored: the large one and five
MASTER=master@loadtest.example.test
BARMAN=${BARMAN:-on}                     # PostgreSQL variants archive WAL to the lab S3, as production would

# ── pieces ─────────────────────────────────────────────────────────────────────────

ingest() {  # <variant>
  local v=$1
  sizes "$v" empty
  phase "$v" append append --accounts "$ACCOUNTS" --per-account "$PER_ACCOUNT" --big "$BIG" --workers 8
  phase "$v" smtp smtp --accounts "$ACCOUNTS" --count 5000 --workers 10
  sizes "$v" after-smtp
}

index_drained() {  # <variant> — wait (≤ 30 min) until v1's search index queue is empty
  local v=$1 t0=$SECONDS q
  [[ $(base_of "$v") == v016* ]] && { sleep 60; return 0; }
  while (( SECONDS - t0 < 1800 )); do
    q=$(echo '[["x:IndexQueueStatus/get",{"ids":null},"c0"]]' | lg admin 2>/dev/null |
        python3 -c 'import json,sys; r=json.load(sys.stdin)[0][1]["list"]; print(sum(x.get("queuedUpdates",0)+x.get("queuedDeletions",0) for x in r))' 2>/dev/null) || q='?'
    [[ $q == 0 ]] && break
    sleep 10
  done
  log "$v: index queue empty after $(( SECONDS - t0 ))s (left: $q)"
}

settle() {  # <variant> — the store at rest: index built, PostgreSQL checkpointed and vacuumed
  local v=$1
  index_drained "$v"
  if [[ $v == v1-pg* ]]; then
    psql_pg -d stalwart -c "VACUUM (ANALYZE)" -c "CHECKPOINT" >/dev/null
  fi
  sleep 60
  sizes "$v" settled
}

tools_up() {  # the platform's tenant-backup-tools image with a work volume (captures, restic repo)
  kx get pod lt-tools >/dev/null 2>&1 && return 0
  pvc lt-work
  kx apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata: {name: lt-tools, labels: {app: lt-tools}}
spec:
  terminationGracePeriodSeconds: 1
  containers:
    - name: tools  # limits of the restore Job (backup-restore/executors/mailboxes-by-address.ts)
      image: $IMG_TOOLS
      command: [sleep, infinity]
      env:
        - {name: STALWART_MASTER_PASSWORD, valueFrom: {secretKeyRef: {name: lt-creds, key: admin}}}
        - {name: RESTIC_PASSWORD, value: lt-restic-not-secret}
      resources:
        requests: {cpu: 500m, memory: 256Mi}
        limits: {cpu: "2", memory: 2Gi}
      volumeMounts: [{name: work, mountPath: /work}]
  volumes: [{name: work, persistentVolumeClaim: {claimName: lt-work}}]
YAML
  kx wait --for=condition=Ready pod/lt-tools --timeout=300s >/dev/null || die "lt-tools not ready"
}
tools_down() { kx delete pod lt-tools --ignore-not-found --wait=true >/dev/null; kx delete pvc lt-work --ignore-not-found --wait=true >/dev/null; }
tx() { kx exec -i lt-tools -- "$@"; }

# timed_tool <variant> <step> <engine> <mailbox> <command…> — one tool run, its JSON summary kept
timed_tool() {
  local v=$1 step=$2 engine=$3 mbox=$4; shift 4
  local t0=$EPOCHREALTIME rc out
  out=$(tx "$@" 2> >(tail -c 2000 >> "$OUT/$v/$step-$engine.err"))
  rc=$?
  printf '{"variant":"%s","step":"%s","engine":"%s","mailbox":"%s","seconds":%s,"rc":%s,"summary":%s}\n' \
    "$v" "$step" "$engine" "$mbox" "$(since "$t0")" "$rc" \
    "$(python3 -c 'import json,sys
lines=[l for l in sys.argv[1].splitlines() if l.strip().startswith("{")]
print(lines[-1] if lines else "null")' "$out" 2>/dev/null || echo null)" >> "$OUT/backup.jsonl"
  return $rc
}

# backup_restore <variant> — ADR-044/061's mailbox backup and restore, both engines, end to end
backup_restore() {
  local v=$1 b src addr engine
  b=$(base_of "$v")
  tools_up
  tx sh -c 'rm -rf /work/cap-imap /work/cap-jmap /work/repo && mkdir -p /work/cap-imap /work/cap-jmap'
  [[ $b == v1* ]] && lg samples > "$OUT/$v/samples-before-restore.json" 2>&1
  for engine in imap jmap; do
    mark "$v" "capture-$engine" start
    for src in "${SOURCES[@]}"; do
      addr=$src@loadtest.example.test
      if [[ $engine == imap ]]; then
        timed_tool "$v" capture imap "$src" python3 /usr/local/bin/imap-sync.py --imap-host lt-stalwart --imap-port 993 \
          --account-address "$addr" --master-user "$MASTER" --auth-pass-env STALWART_MASTER_PASSWORD \
          --output-dir /work/cap-imap || log "$v: imap capture of $src failed"
      else
        timed_tool "$v" capture jmap "$src" python3 /usr/local/bin/jmap-sync.py --endpoint http://lt-stalwart:8080 \
          --account-address "$addr" --master-user "$MASTER" --auth-pass-env STALWART_MASTER_PASSWORD \
          --output-dir /work/cap-jmap || log "$v: jmap capture of $src failed"
      fi
    done
    mark "$v" "capture-$engine" end
  done
  # restic, per mailbox, with the flags of the production capture Job (components/mailboxes-restic.ts)
  tx restic init --repo /work/repo >/dev/null 2>&1
  mark "$v" restic-backup start
  for src in "${SOURCES[@]}"; do
    addr=$src@loadtest.example.test
    timed_tool "$v" restic-backup imap "$src" restic --repo /work/repo backup "/work/cap-imap/$addr" --tag "address=$addr" \
      --host lt --compression auto --pack-size 64 --ignore-inode --ignore-ctime --json -q
  done
  mark "$v" restic-backup end
  printf '{"variant":"%s","step":"restic-repo","bytes":%s,"capture_bytes":%s}\n' "$v" \
    "$(tx du -sb /work/repo | cut -f1)" "$(tx du -sb /work/cap-imap | cut -f1)" >> "$OUT/backup.jsonl"
  # the restore side: restic restore of the large mailbox, then both engines into empty accounts
  timed_tool "$v" restic-restore imap big sh -c 'rm -rf /work/rst && restic --repo /work/repo restore latest --tag address=big@loadtest.example.test --target /work/rst --no-lock -q && echo "{\"ok\":true}"'
  for engine in imap jmap; do
    mark "$v" "restore-$engine" start
    for src in "${SOURCES[@]}"; do
      # merge-overwrite for both engines: the targets are empty, so it equals the production default
      # (merge-skip-duplicates), which for JMAP would add one Email/query per message
      if [[ $engine == imap ]]; then  # the production call otherwise: default 4 connections
        timed_tool "$v" restore imap "$src" python3 /usr/local/bin/imap-restore.py --imap-host lt-stalwart --imap-port 993 \
          --target-address "rimap-$src@loadtest.example.test" --source-address "$src@loadtest.example.test" \
          --master-user "$MASTER" --auth-pass-env STALWART_MASTER_PASSWORD --maildir-root /work/cap-imap \
          --mode merge-overwrite || log "$v: imap restore of $src failed"
      else
        timed_tool "$v" restore jmap "$src" python3 /usr/local/bin/jmap-restore.py --endpoint http://lt-stalwart:8080 \
          --target-address "rjmap-$src@loadtest.example.test" --source-address "$src@loadtest.example.test" \
          --master-user "$MASTER" --auth-pass-env STALWART_MASTER_PASSWORD --maildir-root /work/cap-jmap \
          --mode merge-overwrite --workers 16 || log "$v: jmap restore of $src failed"
      fi
    done
    mark "$v" "restore-$engine" end
  done
  # what came back: folders, counts, flags, keywords, INTERNALDATE, sizes — against the source
  local names
  names=$(for src in "${SOURCES[@]}"; do printf '%s,rimap-%s,rjmap-%s,' "$src" "$src" "$src"; done)
  lg digest --names "${names%,}" > "$OUT/$v/digest.json" 2>> "$OUT/$v/digest.log"
  python3 - "$OUT/$v/digest.json" "$v" "${SOURCES[@]}" >> "$OUT/restore-check.jsonl" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); v = sys.argv[2]
for src in sys.argv[3:]:
    for engine in ("imap", "jmap"):
        a, b = d.get(src, {}), d.get(f"r{engine}-{src}", {})
        diff = {f: [a.get(f), b.get(f)] for f in sorted(set(a) | set(b))
                if (a.get(f) or {}).get("hash") != (b.get(f) or {}).get("hash")
                and ((a.get(f) or {}).get("messages") or (b.get(f) or {}).get("messages"))}
        print(json.dumps({"variant": v, "mailbox": src, "engine": engine,
                          "source_messages": sum(x["messages"] for x in a.values()),
                          "restored_messages": sum(x["messages"] for x in b.values()),
                          "identical": not diff, "differences": diff}))
PY
  [[ $b == v1* ]] && lg samples > "$OUT/$v/samples-after-restore.json" 2>&1
  log "$v: backup/restore done — $(grep -c "\"variant\": \"$v\"" "$OUT/restore-check.jsonl") checks, identical: $(grep "\"variant\": \"$v\"" "$OUT/restore-check.jsonl" | grep -c '"identical": true')"
}

# store_backup <variant> — the store-level copy and its restore (disaster recovery, standby)
objstore_up() {  # the barman-cloud ObjectStore on the lab S3 (lab-svc versitygw), one prefix per run
  : "${S3R_ENDPOINT:?} ${S3R_ACCESS_KEY:?} ${S3R_SECRET_KEY:?}"
  kx create secret generic lt-barman-s3 --from-literal=ak="$S3R_ACCESS_KEY" --from-literal=sk="$S3R_SECRET_KEY" \
    --dry-run=client -o yaml | kx apply -f - >/dev/null
  s3r mkdir r:lt-barman >/dev/null 2>&1
  kx apply -f - >/dev/null <<YAML
apiVersion: barmancloud.cnpg.io/v1
kind: ObjectStore
metadata: {name: lt-objstore}
spec:
  configuration:
    destinationPath: s3://lt-barman/$RUN/$(date +%s)  # a new, empty archive for every new cluster
    endpointURL: $S3R_ENDPOINT
    s3Credentials:
      accessKeyId: {name: lt-barman-s3, key: ak}
      secretAccessKey: {name: lt-barman-s3, key: sk}
    wal: {compression: gzip, maxParallel: 2}
    # immediateCheckpoint: the copy's own cost; the default spread checkpoint first waits up to
    # checkpoint_completion_target × checkpoint_timeout (13.5 min here; store evaluation finding 6)
    data: {compression: gzip, immediateCheckpoint: true}
  instanceSidecarConfiguration:
    resources:
      requests: {cpu: 50m, memory: 128Mi}
      limits: {memory: 1Gi}
YAML
}
pg_backup_restore() {  # <variant> — CNPG base backup to S3, then a new cluster recovered from it
  local v=$1 t0 bk="lt-bk-$RANDOM" _ ph
  t0=$EPOCHREALTIME
  kx apply -f - >/dev/null <<YAML
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata: {name: $bk}
spec:
  cluster: {name: lt-pg}
  method: plugin
  pluginConfiguration: {name: barman-cloud.cloudnative-pg.io}
YAML
  for _ in $(seq 1 720); do
    ph=$(kx get backups.postgresql.cnpg.io "$bk" -o jsonpath='{.status.phase}' 2>/dev/null)  # `backup` alone is Longhorn's
    [[ $ph == completed || $ph == failed ]] && break; sleep 5
  done
  printf '{"variant":"%s","kind":"cnpg-backup","phase":"%s","seconds":%s,"db_bytes":%s}\n' "$v" "$ph" "$(since "$t0")" \
    "$(psql_pg -d stalwart -c 'SELECT pg_database_size(current_database())')" >> "$OUT/store-backup.jsonl"
  [[ $ph == completed ]] || { log "$v: CNPG backup $ph"; return 1; }
  t0=$EPOCHREALTIME
  kx apply -f - >/dev/null <<YAML
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata: {name: lt-pg-rec}
spec:
  instances: 1
  imageName: $IMG_PG
  storage: {size: 60Gi, storageClass: $PG_SC}
  resources:
    requests: {cpu: 500m, memory: 512Mi}
    limits: {cpu: "$PG_CPU", memory: $PG_MEM}
  bootstrap:
    recovery: {source: origin}
  externalClusters:
    - name: origin
      plugin:
        name: barman-cloud.cloudnative-pg.io
        parameters: {barmanObjectName: lt-objstore, serverName: lt-pg}
YAML
  for _ in $(seq 1 720); do
    [[ "$(kx get cluster lt-pg-rec -o jsonpath='{.status.readyInstances}' 2>/dev/null)" == 1 ]] && break; sleep 5
  done
  local rows; rows=$(kx exec -i lt-pg-rec-1 -c postgres -- psql -U postgres -d stalwart -At -c 'SELECT pg_database_size(current_database())' 2>/dev/null)
  printf '{"variant":"%s","kind":"cnpg-recovery","seconds":%s,"db_bytes":"%s"}\n' "$v" "$(since "$t0")" "$rows" >> "$OUT/store-backup.jsonl"
  log "$v: CNPG backup + recovery: $(tail -n 2 "$OUT/store-backup.jsonl" | tr '\n' ' ')"
  kx delete cluster lt-pg-rec --wait=true >/dev/null
  kx delete backups.postgresql.cnpg.io "$bk" --wait=false >/dev/null
}
restic_dir() {  # <variant> <label> <path in lt-tools> — restic backup of a store directory, twice, and a restore
  local v=$1 label=$2 dir=$3 t0
  tx sh -c "rm -rf /work/srepo /work/srst && restic init --repo /work/srepo -q" >/dev/null 2>&1
  t0=$EPOCHREALTIME
  tx restic --repo /work/srepo backup "$dir" --compression auto --pack-size 64 -q >/dev/null 2>&1
  local first; first=$(since "$t0")
  phase "$v" "smtp-$label" smtp --accounts "$ACCOUNTS" --count 500 --workers 4 --offset $(( 11000000 + RANDOM * 10 )) >/dev/null 2>&1
  t0=$EPOCHREALTIME
  tx restic --repo /work/srepo backup "$dir" --compression auto --pack-size 64 -q >/dev/null 2>&1
  local second; second=$(since "$t0")
  t0=$EPOCHREALTIME
  tx restic --repo /work/srepo restore latest --target /work/srst -q >/dev/null 2>&1
  local rst; rst=$(since "$t0")
  printf '{"variant":"%s","kind":"restic-%s","files":%s,"bytes":%s,"repo_bytes":%s,"first_s":%s,"incremental_s":%s,"restore_s":%s}\n' \
    "$v" "$label" "$(tx sh -c "find $dir -type f | wc -l")" "$(tx du -sb "$dir" | cut -f1)" "$(tx du -sb /work/srepo | cut -f1)" \
    "$first" "$second" "$rst" >> "$OUT/store-backup.jsonl"
  tx rm -rf /work/srepo /work/srst
  log "$v: restic $label — $(tail -n 1 "$OUT/store-backup.jsonl")"
}
store_backup() {  # <variant>
  local v=$1 b; b=$(base_of "$v")
  # the store volume, read-only, next to the tools: today's stalwart-snapshot reads the RocksDB
  # directory of the running server the same way
  kx delete pod lt-tools --ignore-not-found --wait=true >/dev/null
  local blob_src="lt-data" blob_sub="blobs"
  [[ -n $BLOB_SC ]] && { blob_src=lt-blobs; blob_sub=""; }
  kx apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata: {name: lt-tools, labels: {app: lt-tools}}
spec:
  terminationGracePeriodSeconds: 1
  containers:
    - name: tools
      image: $IMG_TOOLS
      command: [sleep, infinity]
      env: [{name: RESTIC_PASSWORD, value: lt-restic-not-secret}]
      resources: {requests: {cpu: 500m, memory: 256Mi}, limits: {cpu: "2", memory: 2Gi}}
      volumeMounts:
        - {name: work, mountPath: /work}
        - {name: store, mountPath: /store/data, subPath: data, readOnly: true}
        - {name: blobs, mountPath: /store/blobs, subPath: "$blob_sub", readOnly: true}
  volumes:
    - {name: work, persistentVolumeClaim: {claimName: lt-work}}
    - {name: store, persistentVolumeClaim: {claimName: lt-data}}
    - {name: blobs, persistentVolumeClaim: {claimName: $blob_src}}
YAML
  kx wait --for=condition=Ready pod/lt-tools --timeout=300s >/dev/null || { log "$v: store tools pod not ready"; return 1; }
  case $b in
    v016-rocks|v1-rocks) restic_dir "$v" rocksdb /store/data ;;
    v1-pg-fs*|v1-pg-cluster-ha) restic_dir "$v" blobs /store/blobs ;;
  esac
  [[ $b == v1-pg* && $BARMAN == on ]] && pg_backup_restore "$v"
  kx delete pod lt-tools --ignore-not-found --wait=true >/dev/null
}

# delete_account <variant> — what deleting a whole mailbox frees, and when
delete_account() {
  local v=$1 name=${2:-rimap-u001} id t0 r  # default: mail that came back by restore (appends into INBOX)
  sizes "$v" before-account-delete
  r=$(lg destroy-account --name "$name") || { log "$v: destroy $name failed: $r"; return 1; }
  id=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["id"])' "$r")
  t0=$SECONDS
  if [[ $v == v1* ]]; then sleep 10; await_tasks "$v" DestroyAccount account-destroy; else sleep 60; fi
  admin_task purgeBlob > /dev/null; sleep 15
  [[ $v == v1* ]] && await_tasks "$v" StoreMaintenance blob-purge-after-account
  [[ $v != v1* ]] && sleep 120
  sizes "$v" after-account-delete
  local left='null'
  if [[ $v == v1* ]]; then
    left=$(lg samples | python3 -c 'import json,sys; print(json.load(sys.stdin)["per_account"].get(sys.argv[1], 0))' "$id")
    # what the platform would add: release the deleted account's training samples, then purge
    lg samples --release-account-id "$id" > "$OUT/$v/release-account-samples.json"
    admin_task purgeBlob > /dev/null; sleep 15
    await_tasks "$v" StoreMaintenance blob-purge-after-account-samples
    sizes "$v" after-account-samples-released
  fi
  printf '{"variant":"%s","step":"delete-account","account":"%s","id":"%s","seconds":%s,"samples_left":%s}\n' \
    "$v" "$name" "$id" "$(( SECONDS - t0 ))" "$left" >> "$OUT/retention.jsonl"
  log "$v: account $name deleted; its training samples left behind: $left"
}

cmd_store() {  # <variant>
  local v=$1
  log "=== r2 store $v ==="
  stalwart_up "$v"
  ingest "$v"
  lg fixtures > "$OUT/$v/fixtures.json" 2>&1 || log "$v: fixtures failed"
  settle "$v"
  phase "$v" mixed mixed --accounts "$ACCOUNTS" --duration "$MIXED_SECONDS" --smtp-rate 5
  backup_restore "$v"
  sizes "$v" after-restores
  store_backup "$v"
  delete_account "$v"
  delete_and_reclaim "$v"
  tools_down
  stalwart_down
  [[ $v == v1-pg* ]] && pg_reset_db stalwart
  log "=== r2 store $v done ==="
}

cmd_shape() {  # <variant[+tag]> [replicas] — the HA, memory-floor and shared-blob shapes
  local v=$1 replicas=${2:-1}
  log "=== r2 shape $v (PG ${PG_INSTANCES}× sync=$PG_SYNC, Stalwart $STALWART_MEM ×$replicas, PG $PG_MEM/$PG_SHARED_BUFFERS, blobs ${BLOB_SC:-subPath} $BLOB_ACCESS) ==="
  stalwart_up "$v" "$replicas"
  ingest "$v"
  settle "$v"
  phase "$v" mixed mixed --accounts "$ACCOUNTS" --duration "$MIXED_SECONDS" --smtp-rate 5
  # Longhorn's own pods (instance managers, the RWX share-manager) are outside the sampled namespace
  [[ -n $BLOB_SC ]] && $K top pods -n longhorn-system --containers > "$OUT/$v/longhorn-top.txt" 2>&1
  phase "$v" imap-read imap-read --accounts "$ACCOUNTS" --duration 120 --workers 16
  phase "$v" jmap-read jmap-read --accounts "$ACCOUNTS" --duration 120 --workers 16
  [[ -n $BLOB_SC ]] && $K top pods -n longhorn-system --containers >> "$OUT/$v/longhorn-top.txt" 2>&1
  kx get pods -o wide > "$OUT/$v/pods.txt" 2>&1
  kx get events --sort-by=.lastTimestamp 2>/dev/null | grep -i -E 'oom|kill|evict|fail' | tail -20 > "$OUT/$v/events.txt"
  stalwart_down
  [[ $(base_of "$v") == v1-pg-cluster-ha ]] && valkey_ha_down
  [[ $(base_of "$v") == v1-pg-garage ]] && garage_down
  [[ $v == v1-pg* ]] && pg_reset_db stalwart
  log "=== r2 shape $v done ==="
}

pg_recreate() {  # PostgreSQL with the current PG_* settings (instances, sync, memory)
  kx delete cluster lt-pg --ignore-not-found --wait=true >/dev/null
  local _; for _ in $(seq 1 60); do kx get pvc -l cnpg.io/cluster=lt-pg -o name 2>/dev/null | grep -q . || break; sleep 2; done
  cmd_pg_up
}

pg_fresh() {  # a new PostgreSQL with the current PG_* settings; with BARMAN=on it archives WAL to the
  # lab S3 through the barman-cloud plugin, as production's system-db does (created with the plugin:
  # adding it later restarts PostgreSQL)
  if [[ $BARMAN == on ]]; then objstore_up; export PG_WAL_ARCHIVE=on; fi
  pg_recreate
  log "postgres: WAL archiving ${PG_WAL_ARCHIVE:-off} $(kx get cluster lt-pg -o jsonpath='{.status.conditions[?(@.type=="ContinuousArchiving")].status}')"
}

cmd_retention_min() {
  local v=v1-pg-fs+retmin
  # model Disabled: the classifier keeps no training sample of anything; hourly expunge and blob
  # clean-up instead of daily at 00:00 / 04:00
  RETENTION_JSON='{"spam":{"model":{"@type":"Disabled"}},"data":{"expungeSchedule":{"@type":"Hourly","minute":5},"blobCleanupSchedule":{"@type":"Hourly","minute":35}}}'
  log "=== r2 retention-min ==="
  stalwart_up "$v"
  echo '[["x:SpamClassifier/get",{"ids":["singleton"]},"c0"],["x:DataRetention/get",{"ids":["singleton"]},"c1"]]' |
    lg admin > "$OUT/$v/retention-settings.json" 2>&1
  ACCOUNTS=20 PER_ACCOUNT=300 BIG=0 ingest "$v"
  lg samples > "$OUT/$v/samples-after-ingest.json" 2>&1
  phase "$v" delete delete --accounts 20 --fraction 0.5
  sizes "$v" after-delete
  admin_task purgeAccounts > /dev/null; sleep 15; await_tasks "$v" AccountMaintenance account-purge
  admin_task purgeBlob > /dev/null; sleep 15; await_tasks "$v" StoreMaintenance blob-purge
  sizes "$v" after-purge
  delete_account "$v" u019
  unset RETENTION_JSON
  stalwart_down
  pg_reset_db stalwart
  log "=== r2 retention-min done ==="
}

cmd_restore_again() {  # <variant> — backup and restore once more with the JMAP upload quota raised
  # (r1031e: on 0.16 the JMAP engine's restores failed on the default quota, HTTP 429), on the
  # mailboxes backup_restore uses: the large one and u001…u005
  local v=$1+uploadquota
  export LT_RAISE_UPLOAD_QUOTA=1
  log "=== r2 restore-again $v ==="
  stalwart_up "$v"
  ACCOUNTS=6 ingest "$v"
  lg fixtures > "$OUT/$v/fixtures.json" 2>&1 || log "$v: fixtures failed"
  settle "$v"
  backup_restore "$v"
  tools_down
  stalwart_down
  log "=== r2 restore-again $v done ==="
}

cmd_pg_backup_again() {  # <variant> — the CNPG base backup and recovery alone (r1031e: the one of v1-pg
  # failed when the lab S3's disk ran full of archived WAL)
  local v=$1+backup
  log "=== r2 pg-backup-again $v ==="
  pg_fresh
  stalwart_up "$v"
  # a third of the corpus: the lab S3 (30 GB disk) holds the archived WAL and the base backup, and
  # blobs in PostgreSQL write ~1.9 GB of WAL per GB of mail — the result is a rate
  ACCOUNTS=20 PER_ACCOUNT=300 BIG=8000 ingest "$v"
  settle "$v"
  pg_backup_restore "$v"
  stalwart_down
  log "=== r2 pg-backup-again $v done ==="
}

cmd_dev_all() {
  cmd_init
  [[ -f "$HERE/s3r.env" ]] && source "$HERE/s3r.env"
  local v
  for v in v016-rocks v1-rocks; do ( cmd_store "$v" ) || log "store $v failed — continuing"; done
  pg_fresh
  for v in v1-pg-fs v1-pg; do ( cmd_store "$v" ) || log "store $v failed — continuing"; done
  # PostgreSQL HA on one node: three instances, asynchronous then one synchronous standby
  ( PG_INSTANCES=3; pg_fresh; cmd_shape v1-pg-fs+pg3 ) || log "pg3 failed — continuing"
  ( PG_INSTANCES=3 PG_SYNC=on; pg_fresh; cmd_shape v1-pg-fs+pg3sync ) || log "pg3sync failed — continuing"
  # the memory floor: smaller limits for both
  ( STALWART_MEM=1Gi PG_MEM=1Gi PG_SHARED_BUFFERS=256MB; pg_fresh; cmd_shape v1-pg-fs+mem1g ) || log "mem1g failed — continuing"
  ( STALWART_MEM=512Mi PG_MEM=768Mi PG_SHARED_BUFFERS=192MB; pg_fresh; cmd_shape v1-pg-fs+mem512 ) || log "mem512 failed — continuing"
  pg_fresh
  # blobs several pods can share, on one node: Longhorn RWO and RWX, Garage
  ( BLOB_SC=lt-longhorn; cmd_shape v1-pg-fs+lhrwo ) || log "lhrwo failed — continuing"
  ( BLOB_SC=lt-longhorn BLOB_ACCESS=ReadWriteMany; cmd_shape v1-pg-cluster-ha+lhrwx 2 ) || log "lhrwx failed — continuing"
  ( GARAGE_NODES=1; cmd_shape v1-pg-garage ) || log "garage failed — continuing"
  ( cmd_retention_min ) || log "retention-min failed — continuing"
  python3 "$HERE/report.py" "$OUT" > "$OUT/report.md" 2>> "$OUT/lt.log"
  [[ -f "$HERE/report2.py" ]] && python3 "$HERE/report2.py" "$OUT" > "$OUT/report2.md" 2>> "$OUT/lt.log"
  log "=== r2 dev-all done — results in $OUT ==="
}

# ── multi-node (staging) ───────────────────────────────────────────────────────────
# The lab driver (scratchpad stg-driver.sh) runs these on the first server and powers a node off
# from the libvirt host in between: stg-up, then smtp-bg + the power cut, then stg-after.

samplers_up() {  # one sampler per node, each reading its own cgroups (run on every node by the driver)
  local node; node=$(hostname)
  [[ -f "$OUT/sampler-$node.pid" ]] && kill -0 "$(cat "$OUT/sampler-$node.pid")" 2>/dev/null && return 0
  nohup python3 "$HERE/sampler.py" "$NS" "$OUT/samples-$node.jsonl" 5 "$node" >/dev/null 2>&1 &
  echo $! > "$OUT/sampler-$node.pid"
}

cmd_stg_up() {  # <variant[+tag]> <replicas> — the shape on every server: ingest, settle, reads
  local v=$1 replicas=${2:-3}
  log "=== r2 stg $v (PG ${PG_INSTANCES}× sync=$PG_SYNC, Stalwart ×$replicas, blobs ${BLOB_SC:-subPath} $BLOB_ACCESS, Longhorn ×$LONGHORN_REPLICAS) ==="
  stalwart_up "$v" "$replicas"
  ingest "$v"
  settle "$v"
  phase "$v" imap-read imap-read --accounts "$ACCOUNTS" --duration 120 --workers 16
  phase "$v" jmap-read jmap-read --accounts "$ACCOUNTS" --duration 120 --workers 16
  phase "$v" mixed mixed --accounts "$ACCOUNTS" --duration 180 --smtp-rate 5
  lg verify-bodies --accounts "$ACCOUNTS" > "$OUT/$v/verify-before-cut.json" 2>> "$OUT/$v/verify.log"
  where "$v" before-cut
}

where() {  # <variant> <label> — which node holds what (the driver picks the node to cut from it)
  {
    echo "== $2 $(date +%T)"
    kx get pods -o wide --no-headers | awk '{print $1, $3, $7}'
    echo "pg-primary $(pg_primary)"
    $K -n longhorn-system get pods -l longhorn.io/component=share-manager -o wide --no-headers 2>/dev/null | awk '{print $1, $3, $7}'
    $K -n longhorn-system get volumes.longhorn.io -o custom-columns=N:.metadata.name,STATE:.status.state,ROBUST:.status.robustness,NODE:.status.currentNodeID --no-headers 2>/dev/null
  } >> "$OUT/$1/where.txt"
}

cmd_smtp_bg() {  # <variant> <count> — the delivery the power cut interrupts (the driver backgrounds it)
  local v=$1 n=${2:-20000}
  phase "$v" smtp-cut smtp --accounts "$ACCOUNTS" --count "$n" --workers 10 --offset 9000000 --drain-timeout 1800
}

cmd_stg_after() {  # <variant> — after the cut: what was stored, intact, and how the shape recovered
  local v=$1
  where "$v" after-cut
  phase "$v" jmap-read-after jmap-read --accounts "$ACCOUNTS" --duration 60 --workers 8
  lg verify-bodies --accounts "$ACCOUNTS" > "$OUT/$v/verify-after-cut.json" 2>> "$OUT/$v/verify.log"
  log "$v: after the cut — $(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print({k: d[k] for k in ("checked","identical","delivered_suffix","empty","different","fetch_errors","ok")})' "$OUT/$v/verify-after-cut.json" 2>&1)"
  sizes "$v" after-cut
}

cmd_stg_down() {  # <variant>
  local v=$1
  stalwart_down
  [[ $(base_of "$v") == v1-pg-cluster-* ]] && valkey_ha_down
  [[ $(base_of "$v") == *garage ]] && garage_down
  pg_reset_db stalwart
}

[[ ${BASH_SOURCE[0]} == "$0" ]] || return 0  # sourced: the functions only

case "${1:-}" in
  init) cmd_init ;;
  store) cmd_store "${2:?variant}" ;;
  shape) cmd_shape "${2:?variant}" "${3:-1}" ;;
  retention-min) cmd_retention_min ;;
  restore-again) cmd_restore_again "${2:?variant}" ;;
  pg-backup-again) cmd_pg_backup_again "${2:?variant}" ;;
  dev-all) cmd_dev_all ;;
  backup-restore) backup_restore "${2:?variant}" ;;
  store-backup) store_backup "${2:?variant}" ;;
  delete-account) delete_account "${2:?variant}" ;;
  pg-fresh) pg_fresh ;;
  samplers-up) samplers_up ;;
  stg-up) cmd_stg_up "${2:?variant}" "${3:-3}" ;;
  smtp-bg) cmd_smtp_bg "${2:?variant}" "${3:-20000}" ;;
  stg-after) cmd_stg_after "${2:?variant}" ;;
  stg-down) cmd_stg_down "${2:?variant}" ;;
  where) where "${2:?variant}" "${3:-now}" ;;
  *) sed -n '2,22p' "$0"; exit 2 ;;
esac
