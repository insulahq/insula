#!/usr/bin/env bash
# lt.sh — Stalwart v1 evaluation harness (ADR-065): store engines, blob placement,
# stalwart-migrate, and a two-node cluster, all loaded with the same synthetic corpus.
#
# Runs ON a single-node lab cluster (DEV) as root, in the throwaway namespace $NS. It never
# touches the platform's `mail` namespace. Copy this directory to the node and run:
#
#   ./lt.sh init                 namespace, credentials, load-generator pod, resource sampler
#   ./lt.sh variant <v>          full run of one store variant (see VARIANTS), then removes it
#   ./lt.sh migrate-suite        0.16.27 store → stalwart-migrate → v1 RocksDB and v1 PostgreSQL,
#                                incl. a live copy under load, final run, verify, rollback
#   ./lt.sh cluster              v1 on PostgreSQL + Valkey, two pods
#   ./lt.sh all                  everything above, in order
#   ./lt.sh teardown             delete the namespace (results stay in $OUT)
#
# Variants: v016-rocks  v1-rocks  v1-pg  v1-pg-fs  v1-pg-s3  v1-pg-s3remote
#   v016-rocks  today's production shape (0.16.27, RocksDB, blobs inside)
#   v1-rocks    the same on v1
#   v1-pg       v1, PostgreSQL data store (dedicated CNPG cluster), blobs and search in PostgreSQL
#   v1-pg-fs    v1, PostgreSQL data store, blobs on a FileSystem volume
#   v1-pg-s3    v1, PostgreSQL data store, blobs in S3 (rclone serve s3 on a local volume —
#               an on-cluster S3, so network latency to a remote provider is NOT included)
#   v1-pg-s3remote  the same with an S3 on another machine: S3R_ENDPOINT, S3R_BUCKET,
#               S3R_ACCESS_KEY, S3R_SECRET_KEY (the bucket is emptied first)
#
# Results: $OUT/<variant>/<phase>.json (load-generator output), $OUT/sizes.jsonl (store sizes
# at each step), $OUT/phases.jsonl (phase start/end), $OUT/samples.jsonl (CPU/memory every 5 s).
# report.py turns them into the tables in the ADR.
#
# Production limits by default: Stalwart 1 CPU / 2 GiB (k8s/base/stalwart-mail), PostgreSQL
# 1 CPU / 2 GiB. Corpus: ACCOUNTS × PER_ACCOUNT messages plus one BIG mailbox (≈ 4.4 GB).
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
NS=${NS:-mail-lt}
RUN=${RUN:-$(date +%Y%m%d-%H%M)}
OUT=${OUT:-$HERE/results/$RUN}
K="k3s kubectl"
IMG_016=docker.io/stalwartlabs/stalwart:v0.16.27        # = k8s/base/stalwart-mail
IMG_V1=docker.io/stalwartlabs/stalwart:v1.0.1
IMG_MIGRATE=ghcr.io/stalwartlabs/stalwart-migrate:1.0.4
IMG_PG=ghcr.io/cloudnative-pg/postgresql:18.6-202610260820-minimal-trixie  # = k8s/base/database.yaml
IMG_PY=docker.io/library/python:3.15.2-slim-trixie
IMG_RCLONE=docker.io/rclone/rclone:1.75.2               # = the platform's rclone pin
IMG_VALKEY=docker.io/valkey/valkey:9.1.3-alpine         # = k8s/base/valkey
STALWART_CPU=${STALWART_CPU:-1000m}
STALWART_MEM=${STALWART_MEM:-2Gi}
PG_CPU=${PG_CPU:-1000m}
PG_MEM=${PG_MEM:-2Gi}
ACCOUNTS=${ACCOUNTS:-50}
PER_ACCOUNT=${PER_ACCOUNT:-600}
BIG=${BIG:-25000}
READ_SECONDS=${READ_SECONDS:-180}
MIXED_SECONDS=${MIXED_SECONDS:-300}

mkdir -p "$OUT"
kx() { $K -n "$NS" "$@"; }
log() { printf '[%s] %s\n' "$(date +%T)" "$*" | tee -a "$OUT/lt.log" >&2; }
die() { log "FAIL: $*"; exit 1; }
secret() { kx get secret lt-creds -o "jsonpath={.data.$1}" | base64 -d; }
mark() { printf '{"variant":"%s","phase":"%s","event":"%s","t":%s}\n' "$1" "$2" "$3" "$(date +%s.%N)" >> "$OUT/phases.jsonl"; }
pv_path() {
  local pv
  pv=$(kx get pvc "$1" -o jsonpath='{.spec.volumeName}' 2>/dev/null) || return 1
  [[ -n "$pv" ]] || return 1
  $K get pv "$pv" -o jsonpath='{.spec.hostPath.path}{.spec.local.path}'
}

# lg <loadgen args…> — run the load generator in its pod (LT_HOST selects the server).
lg() { kx exec -i lt-loadgen -- env LT_HOST="${LT_HOST:-lt-stalwart}" python3 /opt/lt/loadgen.py "$@"; }

# phase <variant> <name> <loadgen args…> — one measured step; JSON to $OUT/<variant>/<name>.json.
phase() {
  local v=$1 p=$2; shift 2
  mkdir -p "$OUT/$v"
  log "$v: $p ($*)"
  mark "$v" "$p" start
  lg "$@" > "$OUT/$v/$p.json" 2>> "$OUT/$v/$p.log"
  local rc=$?
  mark "$v" "$p" end
  python3 - "$OUT/$v/$p.json" <<'PY' | tee -a "$OUT/lt.log" >&2
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:  # noqa: BLE001
    print(f"  (no JSON: {e})"); sys.exit()
keys = ["messages", "msg_per_s", "mb_per_s", "accepted", "accept_msg_per_s", "stored_msg_per_s",
        "drain_wall_s", "ops_per_s", "wall_s", "ok", "total"]
print("  " + ", ".join(f"{k}={d[k]}" for k in keys if k in d)
      + f", errors={sum(d.get('errors', {}).values()) if isinstance(d.get('errors'), dict) else '-'}")
PY
  [[ $rc -eq 0 ]] || log "  $p exited $rc (see $OUT/$v/$p.log)"
  return $rc
}

# ── shared pieces ──────────────────────────────────────────────────────────────────

cmd_init() {
  $K get ns "$NS" >/dev/null 2>&1 || $K create ns "$NS" >/dev/null
  $K label ns "$NS" app.kubernetes.io/part-of=stalwart-loadtest --overwrite >/dev/null
  if ! kx get secret lt-creds >/dev/null 2>&1; then
    local admin; admin=$(openssl rand -hex 16)
    kx create secret generic lt-creds \
      --from-literal=admin="$admin" --from-literal=recoveryAdmin="admin:$admin" \
      --from-literal=user="$(openssl rand -hex 16)" --from-literal=pg="$(openssl rand -hex 16)" \
      --from-literal=s3ak="lt$(openssl rand -hex 6)" --from-literal=s3sk="$(openssl rand -hex 20)" >/dev/null
    kx create secret generic lt-pg-app --type=kubernetes.io/basic-auth \
      --from-literal=username=stalwart --from-literal=password="$(secret pg)" >/dev/null
  fi
  kx create configmap lt-scripts --from-file="$HERE/loadgen.py" --dry-run=client -o yaml | kx apply -f - >/dev/null
  kx apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: lt-loadgen
  labels: {app: lt-loadgen}
spec:
  terminationGracePeriodSeconds: 1
  containers:
    - name: loadgen
      image: $IMG_PY
      command: [sleep, infinity]
      env:
        - {name: LT_USER_PASSWORD, valueFrom: {secretKeyRef: {name: lt-creds, key: user}}}
        - {name: LT_ADMIN_PASSWORD, valueFrom: {secretKeyRef: {name: lt-creds, key: admin}}}
        - {name: LT_DOMAIN, value: loadtest.example.test}
      resources:
        requests: {cpu: 500m, memory: 256Mi}
        limits: {cpu: "3", memory: 1536Mi}
      volumeMounts: [{name: scripts, mountPath: /opt/lt}]
  volumes: [{name: scripts, configMap: {name: lt-scripts}}]
YAML
  kx wait --for=condition=Ready pod/lt-loadgen --timeout=300s >/dev/null || die "loadgen pod not ready"
  if [[ ! -f "$OUT/sampler.pid" ]] || ! kill -0 "$(cat "$OUT/sampler.pid")" 2>/dev/null; then
    nohup python3 "$HERE/sampler.py" "$NS" "$OUT/samples.jsonl" 5 >/dev/null 2>&1 &
    echo $! > "$OUT/sampler.pid"
  fi
  {
    echo "run=$RUN images: $IMG_016 $IMG_V1 $IMG_MIGRATE $IMG_PG $IMG_PY $IMG_RCLONE $IMG_VALKEY"
    echo "limits: stalwart $STALWART_CPU/$STALWART_MEM postgres $PG_CPU/$PG_MEM"
    echo "corpus: $ACCOUNTS accounts x $PER_ACCOUNT + big $BIG"
    $K get nodes -o wide | tail -n +2
    nproc; free -m | head -2; df -h / | tail -1
  } >> "$OUT/environment.txt"
  log "init: namespace $NS ready, sampler pid $(cat "$OUT/sampler.pid")"
}

cmd_pg_up() {
  kx get cluster lt-pg >/dev/null 2>&1 && return 0
  kx apply -f - >/dev/null <<YAML
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: lt-pg
spec:
  instances: 1
  imageName: $IMG_PG
  storage: {size: 60Gi, storageClass: local-path}
  resources:
    requests: {cpu: 500m, memory: 1Gi}
    limits: {cpu: "$PG_CPU", memory: $PG_MEM}
  postgresql:
    parameters:
      shared_buffers: 512MB
      effective_cache_size: 1536MB
      maintenance_work_mem: 128MB
      work_mem: 16MB
      max_wal_size: 4GB
      min_wal_size: 512MB
      checkpoint_timeout: 15min
      wal_compression: lz4
      default_toast_compression: lz4
      max_connections: "200"
      track_io_timing: "on"
  bootstrap:
    initdb:
      database: stalwart
      owner: stalwart
      secret: {name: lt-pg-app}
YAML
  local _
  for _ in $(seq 1 90); do
    [[ "$(kx get cluster lt-pg -o jsonpath='{.status.readyInstances}' 2>/dev/null)" == 1 ]] && break
    sleep 5
  done
  [[ "$(kx get cluster lt-pg -o jsonpath='{.status.readyInstances}')" == 1 ]] || die "lt-pg not ready"
  log "postgres: lt-pg ready"
}

psql_pg() { kx exec -i lt-pg-1 -c postgres -- psql -U postgres -v ON_ERROR_STOP=1 -At "$@"; }

pg_reset_db() {
  local db=${1:-stalwart}
  psql_pg -d postgres -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" -c "CREATE DATABASE $db OWNER stalwart" >/dev/null
  psql_pg -d postgres -c "SELECT pg_stat_reset_shared('wal')" -c "CHECKPOINT" >/dev/null
}

cmd_s3_up() {
  kx get deploy lt-s3 >/dev/null 2>&1 && return 0
  kx apply -f - >/dev/null <<YAML
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: lt-s3}
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: local-path
  resources: {requests: {storage: 60Gi}}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: lt-s3}
spec:
  replicas: 1
  strategy: {type: Recreate}
  selector: {matchLabels: {app: lt-s3}}
  template:
    metadata: {labels: {app: lt-s3}}
    spec:
      containers:
        - name: rclone
          image: $IMG_RCLONE
          args: [serve, s3, /data, --addr, ":9000", --auth-key, "\$(AK),\$(SK)", --vfs-cache-mode, "off"]
          env:
            - {name: AK, valueFrom: {secretKeyRef: {name: lt-creds, key: s3ak}}}
            - {name: SK, valueFrom: {secretKeyRef: {name: lt-creds, key: s3sk}}}
          resources:
            requests: {cpu: 100m, memory: 128Mi}
            limits: {cpu: "1", memory: 512Mi}
          volumeMounts: [{name: data, mountPath: /data}]
      volumes: [{name: data, persistentVolumeClaim: {claimName: lt-s3}}]
---
apiVersion: v1
kind: Service
metadata: {name: lt-s3}
spec:
  selector: {app: lt-s3}
  ports: [{name: s3, port: 9000}]
YAML
  kx rollout status deploy/lt-s3 --timeout=300s >/dev/null || die "lt-s3 not ready"
  log "s3: lt-s3 ready"
}

s3_reset() { kx exec deploy/lt-s3 -- sh -c 'rm -rf /data/stalwart && mkdir -p /data/stalwart'; }

# s3r <rclone args…> — rclone against the remote S3 (remote name "r"), in a one-off pod
s3r() {
  kx run "lt-rclone-$RANDOM" --rm -i --quiet --restart=Never --image="$IMG_RCLONE" \
    --env=RCLONE_CONFIG_R_TYPE=s3 --env=RCLONE_CONFIG_R_PROVIDER=Other \
    --env="RCLONE_CONFIG_R_ENDPOINT=$S3R_ENDPOINT" --env="RCLONE_CONFIG_R_ACCESS_KEY_ID=$S3R_ACCESS_KEY" \
    --env="RCLONE_CONFIG_R_SECRET_ACCESS_KEY=$S3R_SECRET_KEY" --env=RCLONE_CONFIG_R_FORCE_PATH_STYLE=true \
    -- "$@"
}

s3r_reset() {
  : "${S3R_ENDPOINT:?} ${S3R_BUCKET:?} ${S3R_ACCESS_KEY:?} ${S3R_SECRET_KEY:?}"
  s3r purge "r:$S3R_BUCKET" >/dev/null 2>&1
  s3r mkdir "r:$S3R_BUCKET" || die "cannot create bucket $S3R_BUCKET on $S3R_ENDPOINT"
}

cmd_valkey_up() {
  kx get deploy lt-valkey >/dev/null 2>&1 && return 0
  kx apply -f - >/dev/null <<YAML
apiVersion: apps/v1
kind: Deployment
metadata: {name: lt-valkey}
spec:
  replicas: 1
  selector: {matchLabels: {app: lt-valkey}}
  template:
    metadata: {labels: {app: lt-valkey}}
    spec:
      containers:
        - name: valkey
          image: $IMG_VALKEY
          args: [--save, "", --appendonly, "no", --maxmemory, 256mb]
          resources:
            requests: {cpu: 50m, memory: 64Mi}
            limits: {cpu: 500m, memory: 384Mi}
---
apiVersion: v1
kind: Service
metadata: {name: lt-valkey}
spec:
  selector: {app: lt-valkey}
  ports: [{name: redis, port: 6379}]
YAML
  kx rollout status deploy/lt-valkey --timeout=300s >/dev/null || die "lt-valkey not ready"
}

# ── Stalwart instances ─────────────────────────────────────────────────────────────

# pvc <name> — a fresh local-path volume
pvc() {
  kx apply -f - >/dev/null <<YAML
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: $1}
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: local-path
  resources: {requests: {storage: 60Gi}}
YAML
}

# stalwart_deploy <name> <image> <pvc> <root> <etc> <replicas> — root is where the store's
# data/ and blobs/ live (/var/lib/stalwart, or /var/lib/stalwart-v1 for a migration target), etc
# is the config directory. The launcher is production's (THP off, capability-free copy).
stalwart_deploy() {
  local name=$1 image=$2 claim=$3 root=$4 etc=$5 replicas=${6:-1}
  kx apply -f - >/dev/null <<YAML
apiVersion: apps/v1
kind: Deployment
metadata: {name: $name, labels: {app: lt-stalwart}}
spec:
  replicas: $replicas
  strategy: {type: Recreate}
  selector: {matchLabels: {app: lt-stalwart, lt-instance: $name}}
  template:
    metadata: {labels: {app: lt-stalwart, lt-instance: $name}}
    spec:
      terminationGracePeriodSeconds: 60
      securityContext:
        sysctls: [{name: net.ipv4.ip_unprivileged_port_start, value: "0"}]
      initContainers:
        - name: dirs
          image: $image
          securityContext: {runAsUser: 0}
          command: [sh, -c, "mkdir -p /pvc/data /pvc/blobs /pvc/etc && chown 2000:2000 /pvc/data /pvc/blobs /pvc/etc"]
          volumeMounts: [{name: store, mountPath: /pvc}]
        - name: stalwart-binary
          image: $image
          command: [sh, -c, "cp /usr/local/bin/stalwart /opt/stalwart-bin/stalwart && chmod 0555 /opt/stalwart-bin/stalwart"]
          volumeMounts: [{name: bin, mountPath: /opt/stalwart-bin}]
      containers:
        - name: stalwart
          image: $image
          command:
            - perl
            - -e
            - |
              my %nr = (x86_64 => 157, aarch64 => 167);
              chomp(my \$arch = \`uname -m\`);
              syscall(\$nr{\$arch}, 41, 1, 0, 0, 0) if exists \$nr{\$arch};
              exec { \$ARGV[0] } @ARGV or die "exec: \$!\n";
            - --
          args: [/opt/stalwart-bin/stalwart, --config, $etc/config.json]
          env:
            - {name: STALWART_RECOVERY_ADMIN, valueFrom: {secretKeyRef: {name: lt-creds, key: recoveryAdmin}}}
            - {name: MALLOC_ARENA_MAX, value: "2"}
          ports:
            - {name: smtp, containerPort: 25}
            - {name: submission, containerPort: 587}
            - {name: imap, containerPort: 143}
            - {name: http, containerPort: 8080}
          resources:
            requests: {cpu: 250m, memory: 512Mi}
            limits: {cpu: "$STALWART_CPU", memory: $STALWART_MEM}
          readinessProbe:
            exec: {command: [sh, -c, "curl -sf http://127.0.0.1:8080/healthz/live"]}
            periodSeconds: 2
            failureThreshold: 3
          volumeMounts:
            - {name: bin, mountPath: /opt/stalwart-bin, readOnly: true}
            - {name: store, mountPath: $root/data, subPath: data}
            - {name: store, mountPath: $root/blobs, subPath: blobs}
            - {name: store, mountPath: $etc, subPath: etc}
      volumes:
        - {name: bin, emptyDir: {}}
        - {name: store, persistentVolumeClaim: {claimName: $claim}}
---
apiVersion: v1
kind: Service
metadata: {name: lt-stalwart}
spec:
  selector: {app: lt-stalwart}
  ports:
    - {name: smtp, port: 25}
    - {name: submission, port: 587}
    - {name: imap, port: 143}
    - {name: http, port: 8080}
YAML
}

# wait_ready <deploy> [timeout] — every replica ready AND the HTTP listener answers through the Service
wait_ready() {
  local d=$1 timeout=${2:-600} t0=$SECONDS want
  want=$(kx get deploy "$d" -o jsonpath='{.spec.replicas}')
  while (( SECONDS - t0 < timeout )); do
    if [[ "$(kx get deploy "$d" -o jsonpath='{.status.readyReplicas}' 2>/dev/null)" == "$want" ]] &&
       kx exec lt-loadgen -- python3 -c "import urllib.request; urllib.request.urlopen('http://lt-stalwart:8080/healthz/live', timeout=3)" 2>/dev/null; then
      echo $(( SECONDS - t0 )); return 0
    fi
    sleep 1
  done
  return 1
}

restart_pods() {  # <deploy> — delete the pods (never `rollout restart`), print seconds to ready
  local d=$1
  kx delete pod -l "lt-instance=$d" --wait=true --timeout=180s >/dev/null
  wait_ready "$d"
}

variant_stores() {
  local pg ak sk
  case $1 in
    v016-rocks|v1-rocks) echo '{"dataStore":{"@type":"RocksDb","path":"/var/lib/stalwart/data"}}' ;;
    v1-pg*)
      pg=$(secret pg)
      local data='{"@type":"PostgreSql","host":"lt-pg-rw","port":5432,"database":"stalwart","authUsername":"stalwart","authSecret":{"@type":"Value","secret":"'"$pg"'"},"useTls":false}'
      case $1 in
        v1-pg) echo '{"dataStore":'"$data"'}' ;;
        v1-pg-fs) echo '{"dataStore":'"$data"',"blobStore":{"@type":"FileSystem","path":"/var/lib/stalwart/blobs","depth":2}}' ;;
        v1-pg-s3)
          ak=$(secret s3ak); sk=$(secret s3sk)
          echo '{"dataStore":'"$data"',"blobStore":{"@type":"S3","bucket":"stalwart","region":{"@type":"Custom","region":"us-east-1","url":"http://lt-s3:9000"},"accessKeyId":{"@type":"Value","value":"'"$ak"'"},"secretKey":{"@type":"Value","secret":"'"$sk"'"}}}' ;;
        v1-pg-s3remote)
          echo '{"dataStore":'"$data"',"blobStore":{"@type":"S3","bucket":"'"$S3R_BUCKET"'","region":{"@type":"Custom","region":"us-east-1","url":"'"$S3R_ENDPOINT"'"},"accessKeyId":{"@type":"Value","value":"'"$S3R_ACCESS_KEY"'"},"secretKey":{"@type":"Value","secret":"'"$S3R_SECRET_KEY"'"}}}' ;;
        v1-pg-cluster) echo '{"dataStore":'"$data"',"inMemoryStore":{"@type":"Redis","url":"redis://lt-valkey:6379"}}' ;;
      esac ;;
  esac
}

# stalwart_up <variant> [replicas] — fresh store, bootstrap, configure, accounts
stalwart_up() {
  local v=$1 replicas=${2:-1} ver=1 image=$IMG_V1 t0=$SECONDS s
  [[ $v == v016* ]] && { ver=0.16; image=$IMG_016; }
  stalwart_down  # a failed earlier variant must not leave its store behind
  [[ $v == v1-pg* ]] && { cmd_pg_up; pg_reset_db stalwart; }
  [[ $v == v1-pg-s3 ]] && { cmd_s3_up; s3_reset; }
  [[ $v == v1-pg-s3remote ]] && s3r_reset
  [[ $v == v1-pg-cluster ]] && cmd_valkey_up
  pvc lt-data
  stalwart_deploy lt-stalwart "$image" lt-data /var/lib/stalwart /etc/stalwart 1
  s=$(wait_ready lt-stalwart) || die "$v: not ready in bootstrap mode"
  log "$v: bootstrap mode ready in ${s}s"
  mkdir -p "$OUT/$v"
  lg setup-bootstrap --version "$ver" --stores "$(variant_stores "$v")" > "$OUT/$v/setup-bootstrap.json" ||
    die "$v: x:Bootstrap/set failed: $(cat "$OUT/$v/setup-bootstrap.json")"
  s=$(restart_pods lt-stalwart) || die "$v: not ready after bootstrap"
  log "$v: normal mode ready in ${s}s"
  lg setup-configure --version "$ver" --accounts "$ACCOUNTS" > "$OUT/$v/setup-configure.json" ||
    die "$v: configure failed: $(cat "$OUT/$v/setup-configure.json")"
  if [[ $v == v1-pg-cluster ]]; then
    echo '[["x:Coordinator/set",{"update":{"singleton":{"@type":"Default"}}},"c0"]]' |
      lg admin > "$OUT/$v/setup-coordinator.json" || die "$v: coordinator: $(cat "$OUT/$v/setup-coordinator.json")"
  fi
  s=$(restart_pods lt-stalwart) || die "$v: not ready after configure"
  if (( replicas > 1 )); then
    kx scale deploy lt-stalwart --replicas="$replicas" >/dev/null
    s=$(wait_ready lt-stalwart) || die "$v: $replicas replicas not ready"
  fi
  log "$v: configured, $replicas replica(s), setup took $(( SECONDS - t0 ))s"
}

stalwart_down() {  # also whatever a failed migration left (its pods carry app=lt-stalwart too)
  kx delete deploy lt-stalwart lt-stalwart-v1 --ignore-not-found --wait=true >/dev/null
  kx delete pod lt-rb016 lt-migrate --ignore-not-found --wait=true >/dev/null
  kx delete pvc lt-data lt-mig-target lt-mig-state --ignore-not-found --wait=true >/dev/null
}

# sizes <variant> <label> — every store this variant writes to
sizes() {
  local v=$1 label=$2 p dd db fd fb pgj='null' s3j='null'
  p=$(pv_path "${DATA_PVC:-lt-data}") || p=""
  dd=0; db=0; fd=0; fb=0
  if [[ -n "$p" ]]; then
    dd=$(du -sb "$p/data" 2>/dev/null | cut -f1); fd=$(find "$p/data" -type f 2>/dev/null | wc -l)
    db=$(du -sb "$p/blobs" 2>/dev/null | cut -f1); fb=$(find "$p/blobs" -type f 2>/dev/null | wc -l)
  fi
  if [[ $v == v1-pg* || $v == mig-pg* ]] && kx get pod lt-pg-1 >/dev/null 2>&1; then
    local db_name=stalwart; [[ $v == mig-pg* ]] && db_name=stalwart_mig
    pgj=$(psql_pg -d "$db_name" -c "SELECT json_build_object(
      'db_bytes', pg_database_size(current_database()),
      'wal_bytes', (SELECT wal_bytes FROM pg_stat_wal),
      'wal_fpi', (SELECT wal_fpi FROM pg_stat_wal),
      'tables', (SELECT json_agg(t) FROM (SELECT relname, pg_total_relation_size(relid) AS total,
                 pg_relation_size(relid) AS heap, n_live_tup, n_dead_tup,
                 last_autovacuum IS NOT NULL AS autovacuumed
                 FROM pg_stat_user_tables ORDER BY 2 DESC LIMIT 12) t))" 2>/dev/null) || pgj='null'
    local pgp; pgp=$(pv_path lt-pg-1) &&
      pgj=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d["pvc_bytes"]=int(sys.argv[2]); d["pg_wal_dir_bytes"]=int(sys.argv[3]); print(json.dumps(d))' \
        "$pgj" "$(du -sb "$pgp" | cut -f1)" "$(du -sb "$pgp"/pgdata/pg_wal 2>/dev/null | cut -f1 || echo 0)")
  fi
  if [[ $v == v1-pg-s3 ]]; then
    local sp; sp=$(pv_path lt-s3) &&
      s3j="{\"bytes\":$(du -sb "$sp" | cut -f1),\"files\":$(find "$sp" -type f | wc -l)}"
  fi
  if [[ $v == v1-pg-s3remote ]]; then  # rclone size --json → {"count":…,"bytes":…}
    s3j=$(s3r size --json "r:$S3R_BUCKET" 2>/dev/null | grep '^{') || s3j='null'
  fi
  printf '{"variant":"%s","label":"%s","t":%s,"data_bytes":%s,"data_files":%s,"blob_bytes":%s,"blob_files":%s,"pg":%s,"s3":%s}\n' \
    "$v" "$label" "$(date +%s)" "${dd:-0}" "$fd" "${db:-0}" "$fb" "$pgj" "$s3j" >> "$OUT/sizes.jsonl"
  log "$v: sizes@$label data=$(numfmt --to=iec "${dd:-0}") blobs=$(numfmt --to=iec "${db:-0}") ($fb files) pg=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print("-" if not d else f"{d[\"db_bytes\"]/2**30:.2f}GiB wal={d[\"wal_bytes\"]/2**30:.2f}GiB")' "$pgj" 2>/dev/null)"
}

# admin_task <maintenanceType> — enqueue a StoreMaintenance task
admin_task() {
  echo '[["x:Task/set",{"create":{"t":{"@type":"StoreMaintenance","maintenanceType":"'"$1"'"}}},"c0"]]' | lg admin
}

since() { python3 -c "import sys; print(round($EPOCHREALTIME - float(sys.argv[1]), 1))" "$1"; }

backup_cost() {  # <variant> — the cost of a full copy of the store, as the backups make one
  local v=$1 p t0 bytes
  p=$(pv_path lt-data)
  t0=$EPOCHREALTIME
  bytes=$(tar -cf - -C "$p" data blobs 2>/dev/null | wc -c)
  printf '{"variant":"%s","kind":"tar-pvc","bytes":%s,"seconds":%s}\n' "$v" "$bytes" "$(since "$t0")" >> "$OUT/backups.jsonl"
  if [[ $v == v1-pg* ]]; then
    t0=$EPOCHREALTIME
    bytes=$(kx exec lt-pg-1 -c postgres -- sh -c 'pg_basebackup -U postgres -D - -Ft -X none 2>/dev/null | wc -c')
    printf '{"variant":"%s","kind":"pg_basebackup","bytes":%s,"seconds":%s}\n' "$v" "$bytes" "$(since "$t0")" >> "$OUT/backups.jsonl"
  fi
  if [[ $v == v1-pg-s3 ]]; then
    local sp; sp=$(pv_path lt-s3); t0=$EPOCHREALTIME
    bytes=$(tar -cf - -C "$sp" . | wc -c)
    printf '{"variant":"%s","kind":"tar-s3","bytes":%s,"seconds":%s}\n' "$v" "$bytes" "$(since "$t0")" >> "$OUT/backups.jsonl"
  fi
  log "$v: backup cost recorded ($(tail -n 1 "$OUT/backups.jsonl"))"
}

# load_and_read <variant> — ingest the corpus and run every read workload
load_and_read() {
  local v=$1
  sizes "$v" empty
  phase "$v" append append --accounts "$ACCOUNTS" --per-account "$PER_ACCOUNT" --big "$BIG" --workers 8
  sizes "$v" after-append
  phase "$v" smtp smtp --accounts "$ACCOUNTS" --count 5000 --workers 10
  sizes "$v" after-smtp
  phase "$v" imap-read imap-read --accounts "$ACCOUNTS" --duration "$READ_SECONDS" --workers 16
  phase "$v" jmap-read jmap-read --accounts "$ACCOUNTS" --duration "$READ_SECONDS" --workers 16
  phase "$v" big big
  phase "$v" mixed mixed --accounts "$ACCOUNTS" --duration "$MIXED_SECONDS" --smtp-rate 5
  local s; s=$(restart_pods lt-stalwart) && printf '{"variant":"%s","restart_seconds":%s}\n' "$v" "$s" >> "$OUT/restarts.jsonl"
  log "$v: restart to ready ${s:-?}s"
  phase "$v" big-cold big
  backup_cost "$v"
}

# delete_and_reclaim <variant> — delete half of every mailbox, then follow the space
delete_and_reclaim() {
  local v=$1
  sizes "$v" before-delete
  echo '[["x:SpamTrainingSample/query",{"limit":1,"calculateTotal":true},"c0"]]' | lg admin > "$OUT/$v/spam-samples.json" 2>&1
  phase "$v" delete delete --accounts "$ACCOUNTS" --fraction 0.5
  sizes "$v" after-delete
  admin_task purgeAccounts > "$OUT/$v/purge-accounts.json"; sleep 60
  admin_task purgeBlob > "$OUT/$v/purge-blob-1.json"; sleep 120
  admin_task purgeBlob > "$OUT/$v/purge-blob-2.json"; sleep 60
  admin_task purgeData > "$OUT/$v/purge-data.json"; sleep 120
  sizes "$v" after-purge
  sleep 600
  sizes "$v" after-purge-10min
  if [[ $v == v1-pg* ]]; then
    local t0=$SECONDS
    psql_pg -d stalwart -c "VACUUM (ANALYZE)" >/dev/null
    sizes "$v" after-vacuum
    log "$v: VACUUM took $(( SECONDS - t0 ))s"
  fi
  phase "$v" append-reuse append --accounts "$ACCOUNTS" --per-account 150 --big 0 --offset 5000000 --workers 8
  sizes "$v" after-reappend
  if [[ $v == v1-pg* ]]; then
    local t0=$SECONDS
    psql_pg -d stalwart -c "VACUUM (FULL, ANALYZE)" >/dev/null
    sizes "$v" after-vacuum-full
    log "$v: VACUUM FULL took $(( SECONDS - t0 ))s (exclusive lock: mail is blocked throughout)"
  fi
}

cmd_variant() {
  local v=$1
  log "=== variant $v ==="
  stalwart_up "$v"
  load_and_read "$v"
  delete_and_reclaim "$v"
  stalwart_down
  [[ $v == v1-pg* ]] && pg_reset_db stalwart
  log "=== variant $v done ==="
}

# ── migration ──────────────────────────────────────────────────────────────────────

# migrate_pod <target-pvc> — stalwart-migrate with the 0.16 store mounted where the 0.16 server
# has it (read-only), the target where the v1 server will have it, and a state volume.
migrate_pod() {
  local target=$1
  kx delete pod lt-migrate --ignore-not-found --wait=true >/dev/null
  kx apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata: {name: lt-migrate}
spec:
  terminationGracePeriodSeconds: 30
  initContainers:
    - name: dirs
      image: $IMG_MIGRATE
      securityContext: {runAsUser: 0}
      command: [sh, -c, "mkdir -p /t/data /t/blobs /t/etc /t/rb /s/fwd /s/rb && chown 2000:2000 /t/data /t/blobs /t/etc /t/rb /s/fwd /s/rb"]
      volumeMounts: [{name: target, mountPath: /t}, {name: state, mountPath: /s}]
  containers:
    - name: migrate
      image: $IMG_MIGRATE
      command: [sleep, infinity]
      resources:
        requests: {cpu: 500m, memory: 512Mi}
        limits: {memory: 3Gi}
      volumeMounts:
        - {name: source, mountPath: /var/lib/stalwart/data, subPath: data, readOnly: true}
        - {name: source, mountPath: /etc/stalwart, subPath: etc, readOnly: true}
        - {name: target, mountPath: /var/lib/stalwart-v1/data, subPath: data}
        - {name: target, mountPath: /etc/stalwart-v1, subPath: etc}
        - {name: target, mountPath: /var/lib/stalwart-rb, subPath: rb}
        - {name: state, mountPath: /var/lib/stalwart-migrate, subPath: fwd}
        - {name: state, mountPath: /var/lib/stalwart-rb-state, subPath: rb}
  volumes:
    - {name: source, persistentVolumeClaim: {claimName: lt-data}}
    - {name: target, persistentVolumeClaim: {claimName: $target}}
    - {name: state, persistentVolumeClaim: {claimName: lt-mig-state}}
YAML
  kx wait --for=condition=Ready pod/lt-migrate --timeout=300s >/dev/null || die "lt-migrate not ready"
}

# mig <label> <stalwart-migrate args…> — timed, output kept
mig() {
  local label=$1; shift
  local t0=$SECONDS rc
  mark "$MV" "$label" start
  kx exec -i lt-migrate -- stalwart-migrate "$@" > "$OUT/$MV/$label.out" 2>&1
  rc=$?
  mark "$MV" "$label" end
  printf '{"variant":"%s","step":"%s","seconds":%s,"rc":%s}\n' "$MV" "$label" "$(( SECONDS - t0 ))" "$rc" >> "$OUT/migrations.jsonl"
  log "$MV: $label rc=$rc in $(( SECONDS - t0 ))s — $(grep -E 'verify:|accounts|error' "$OUT/$MV/$label.out" | tail -n 2 | tr '\n' ' ')"
  return $rc
}

MIG_ARGS=(--source /etc/stalwart/config.json --target /etc/stalwart-v1/config.json --state /var/lib/stalwart-migrate)

# migrate_to <rocks|pg> — the 0.16 store (already loaded) into a new v1 store, the way the
# platform would do it: live copy under load, delta, stop 0.16, final run, verify, start v1.
migrate_to() {
  local kind=$1 s
  MV=mig-$kind
  mkdir -p "$OUT/$MV"
  log "=== migration 0.16.27 → v1 $kind ==="
  kx delete pvc lt-mig-target lt-mig-state --ignore-not-found --wait=true >/dev/null
  pvc lt-mig-target; pvc lt-mig-state
  migrate_pod lt-mig-target
  if [[ $kind == rocks ]]; then
    kx exec -i lt-migrate -- sh -c 'cat > /etc/stalwart-v1/config.json' <<<'{"@type":"RocksDb","path":"/var/lib/stalwart-v1/data"}'
  else
    cmd_pg_up
    pg_reset_db stalwart_mig
    kx exec -i lt-migrate -- sh -c 'cat > /etc/stalwart-v1/config.json' \
      <<<'{"@type":"PostgreSql","host":"lt-pg-rw","port":5432,"database":"stalwart_mig","authUsername":"stalwart","authSecret":{"@type":"Value","secret":"'"$(secret pg)"'"},"useTls":false}'
  fi
  # prepare: questions answered with the defaults (Enter), as a first run of the platform's
  # automated prepare would; the report and answers are kept for review.
  kx exec -i lt-migrate -- sh -c 'yes "" | head -n 200 | script -qec "stalwart-migrate prepare --source /etc/stalwart/config.json --state /var/lib/stalwart-migrate" /dev/null' \
    > "$OUT/$MV/prepare.out" 2>&1
  kx exec lt-migrate -- sh -c 'cat /var/lib/stalwart-migrate/answers.toml; echo ----; cat /var/lib/stalwart-migrate/prepare-report.txt' > "$OUT/$MV/prepare-files.txt" 2>&1
  mig prepare-check prepare --non-interactive --source /etc/stalwart/config.json --state /var/lib/stalwart-migrate ||
    die "$MV: prepare left open questions (see $OUT/$MV/prepare.out)"

  # live copy, with 0.16 serving a mixed load at the same time
  phase "$MV" mixed-during-copy mixed --accounts "$ACCOUNTS" --duration 600 --smtp-rate 5 --offset 6000000 &
  local mixed_pid=$!
  mig run-1-live run "${MIG_ARGS[@]}"
  wait "$mixed_pid"
  DATA_PVC=lt-mig-target sizes "$MV" after-run-1
  phase "$MV" smtp-delta smtp --accounts "$ACCOUNTS" --count 500 --workers 4 --offset 7000000
  mig run-2-delta run "${MIG_ARGS[@]}"
  lg sample --accounts "$ACCOUNTS" > "$OUT/$MV/sample-source.json"

  # the window: 0.16 stopped → final run → verify → v1 up
  local window0=$SECONDS
  kx scale deploy lt-stalwart --replicas=0 >/dev/null
  kx wait --for=delete pod -l lt-instance=lt-stalwart --timeout=180s >/dev/null 2>&1
  mig run-final run --final --yes "${MIG_ARGS[@]}"
  mig verify-full verify --full "${MIG_ARGS[@]}"
  kx exec lt-migrate -- stalwart-migrate status --format json --state /var/lib/stalwart-migrate > "$OUT/$MV/status.json" 2>&1
  kx exec lt-migrate -- stalwart-migrate report --state /var/lib/stalwart-migrate --format csv > "$OUT/$MV/report.csv" 2>&1
  DATA_PVC=lt-mig-target sizes "$MV" after-final
  stalwart_deploy lt-stalwart-v1 "$IMG_V1" lt-mig-target /var/lib/stalwart-v1 /etc/stalwart-v1 1
  s=$(wait_ready lt-stalwart-v1) || die "$MV: v1 did not start on the migrated store"
  printf '{"variant":"%s","window_seconds":%s,"v1_start_seconds":%s}\n' "$MV" "$(( SECONDS - window0 ))" "$s" >> "$OUT/migrations.jsonl"
  log "$MV: maintenance window (stop → v1 ready) $(( SECONDS - window0 ))s"

  # after the switch: same mail, search index rebuild, reads
  lg sample --accounts "$ACCOUNTS" > "$OUT/$MV/sample-target.json"
  kx cp "$OUT/$MV/sample-source.json" "$NS/lt-loadgen:/tmp/src.json" >/dev/null
  kx cp "$OUT/$MV/sample-target.json" "$NS/lt-loadgen:/tmp/dst.json" >/dev/null
  phase "$MV" compare compare --source /tmp/src.json --target /tmp/dst.json
  local t0=$SECONDS q
  while (( SECONDS - t0 < 3600 )); do
    q=$(echo '[["x:IndexQueueStatus/get",{"ids":null},"c0"]]' | lg admin 2>/dev/null |
        python3 -c 'import json,sys; r=json.load(sys.stdin)[0][1]["list"]; print(sum(x.get("queuedUpdates",0)+x.get("queuedDeletions",0) for x in r))' 2>/dev/null) || q='?'
    [[ $q == 0 ]] && break
    sleep 10
  done
  printf '{"variant":"%s","index_rebuild_seconds":%s,"left":"%s"}\n' "$MV" "$(( SECONDS - t0 ))" "$q" >> "$OUT/migrations.jsonl"
  log "$MV: search index rebuilt in $(( SECONDS - t0 ))s (queue left: $q)"
  phase "$MV" imap-read imap-read --accounts "$ACCOUNTS" --duration 120 --workers 16
  phase "$MV" jmap-read jmap-read --accounts "$ACCOUNTS" --duration 120 --workers 16
  phase "$MV" big big
  [[ $kind == rocks ]] && rollback_after_cutover
  kx delete deploy lt-stalwart-v1 --ignore-not-found --wait=true >/dev/null
  kx delete pod lt-migrate --ignore-not-found --wait=true >/dev/null
  kx delete pvc lt-mig-target lt-mig-state --ignore-not-found --wait=true >/dev/null
  [[ $kind == pg ]] && psql_pg -d postgres -c "DROP DATABASE IF EXISTS stalwart_mig WITH (FORCE)" >/dev/null
  kx scale deploy lt-stalwart --replicas=1 >/dev/null
  wait_ready lt-stalwart >/dev/null || die "0.16 did not come back after the $kind migration"
  log "=== migration → v1 $kind done ==="
}

# rollback_after_cutover — v1 has served mail; copy it back into a new 0.16 store and start 0.16
rollback_after_cutover() {
  log "$MV: rollback after cutover"
  phase "$MV" smtp-on-v1 smtp --accounts "$ACCOUNTS" --count 300 --workers 4 --offset 8000000
  lg sample --accounts "$ACCOUNTS" > "$OUT/$MV/sample-v1-served.json"
  kx scale deploy lt-stalwart-v1 --replicas=0 >/dev/null
  kx wait --for=delete pod -l lt-instance=lt-stalwart-v1 --timeout=180s >/dev/null 2>&1
  # the rollback target must not exist yet: /var/lib/stalwart-rb is the (empty) parent
  kx exec -i lt-migrate -- sh -c 'cat > /etc/stalwart-v1/rollback.json' \
    <<<'{"@type":"RocksDb","path":"/var/lib/stalwart-rb/data"}'
  mig rollback rollback --yes --source /etc/stalwart-v1/config.json --target /etc/stalwart-v1/rollback.json \
    --state /var/lib/stalwart-rb-state --forward-state /var/lib/stalwart-migrate
  # 0.16 on the rolled-back store (the target volume's rb/ directory, config rollback.json)
  kx apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata: {name: lt-rb016, labels: {app: lt-stalwart, lt-instance: lt-rb016}}
spec:
  securityContext:
    sysctls: [{name: net.ipv4.ip_unprivileged_port_start, value: "0"}]
  containers:
    - name: stalwart
      image: $IMG_016
      args: [--config, /etc/stalwart-v1/rollback.json]
      env:
        - {name: STALWART_RECOVERY_ADMIN, valueFrom: {secretKeyRef: {name: lt-creds, key: recoveryAdmin}}}
      resources: {limits: {cpu: "$STALWART_CPU", memory: $STALWART_MEM}}
      readinessProbe:
        exec: {command: [sh, -c, "curl -sf http://127.0.0.1:8080/healthz/live"]}
        periodSeconds: 2
      volumeMounts:
        - {name: target, mountPath: /var/lib/stalwart-rb, subPath: rb}
        - {name: target, mountPath: /etc/stalwart-v1, subPath: etc}
  volumes:
    - {name: target, persistentVolumeClaim: {claimName: lt-mig-target}}
YAML
  kx wait --for=condition=Ready pod/lt-rb016 --timeout=600s >/dev/null || log "$MV: 0.16 did not start on the rolled-back store"
  lg sample --accounts "$ACCOUNTS" > "$OUT/$MV/sample-rolled-back.json"
  kx cp "$OUT/$MV/sample-v1-served.json" "$NS/lt-loadgen:/tmp/src.json" >/dev/null
  kx cp "$OUT/$MV/sample-rolled-back.json" "$NS/lt-loadgen:/tmp/dst.json" >/dev/null
  phase "$MV" compare-rollback compare --source /tmp/src.json --target /tmp/dst.json
  kx delete pod lt-rb016 --wait=true >/dev/null
}

cmd_migrate_suite() {
  local v=v016-rocks
  log "=== migrate-suite ==="
  stalwart_up "$v"
  load_and_read "$v"
  migrate_to rocks
  migrate_to pg
  delete_and_reclaim "$v"
  stalwart_down
  log "=== migrate-suite done ==="
}

# ── cluster ────────────────────────────────────────────────────────────────────────

cmd_cluster() {
  local v=v1-pg-cluster pods a b
  log "=== cluster ==="
  stalwart_up "$v" 2
  echo '[["x:ClusterNode/get",{"ids":null},"c0"]]' | lg admin > "$OUT/$v/cluster-nodes.json"
  sizes "$v" empty
  phase "$v" append append --accounts "$ACCOUNTS" --per-account 200 --big 5000 --workers 8
  sizes "$v" after-append
  mapfile -t pods < <(kx get pod -l lt-instance=lt-stalwart -o jsonpath='{range .items[*]}{.status.podIP}{"\n"}{end}')
  a=${pods[0]}; b=${pods[1]}
  phase "$v" idle-a-to-a idle-probe --via "$a" --watch "$a" --count 10   # same-node control
  phase "$v" idle-a-to-b idle-probe --via "$a" --watch "$b" --count 20
  phase "$v" idle-b-to-a idle-probe --via "$b" --watch "$a" --count 20
  phase "$v" imap-read imap-read --accounts "$ACCOUNTS" --duration 120 --workers 16
  phase "$v" jmap-read jmap-read --accounts "$ACCOUNTS" --duration 120 --workers 16
  # one pod lost in the middle of an SMTP ingest: every accepted message must still be stored
  phase "$v" smtp-failover smtp --accounts "$ACCOUNTS" --count 3000 --workers 10 --offset 9000000 &
  local smtp_pid=$!
  sleep 60
  kx delete pod "$(kx get pod -l lt-instance=lt-stalwart -o jsonpath='{.items[0].metadata.name}')" --wait=false >/dev/null
  log "$v: deleted one pod during the SMTP ingest"
  wait "$smtp_pid"
  sizes "$v" after-failover
  stalwart_down
  kx delete deploy lt-valkey --ignore-not-found >/dev/null
  pg_reset_db stalwart
  log "=== cluster done ==="
}

cmd_teardown() {
  [[ -f "$OUT/sampler.pid" ]] && kill "$(cat "$OUT/sampler.pid")" 2>/dev/null
  $K delete ns "$NS" --ignore-not-found --wait=true >/dev/null
  log "teardown: namespace $NS deleted; results in $OUT"
}

cmd_all() {  # each stage in a subshell: a stage that dies does not stop the others
  cmd_init
  ( cmd_migrate_suite ) || log "migrate-suite failed — continuing"
  local v
  for v in v1-rocks v1-pg v1-pg-fs v1-pg-s3; do ( cmd_variant "$v" ) || log "variant $v failed — continuing"; done
  if [[ -n "${S3R_ENDPOINT:-}" ]]; then ( cmd_variant v1-pg-s3remote ) || log "variant v1-pg-s3remote failed — continuing"; fi
  ( cmd_cluster ) || log "cluster failed — continuing"
  python3 "$HERE/report.py" "$OUT" > "$OUT/report.md" 2>> "$OUT/lt.log"
  log "=== all done — results in $OUT ==="
}

case "${1:-}" in
  init) cmd_init ;;
  variant) cmd_variant "${2:?variant}" ;;
  migrate-suite) cmd_migrate_suite ;;
  cluster) cmd_cluster ;;
  pg-up) cmd_pg_up ;;
  all) cmd_all ;;
  teardown) cmd_teardown ;;
  stalwart-up) stalwart_up "${2:?variant}" "${3:-1}" ;;
  stalwart-down) stalwart_down ;;
  phase) shift; phase "$@" ;;
  sizes) sizes "${2:?variant}" "${3:?label}" ;;
  *) sed -n '2,32p' "$0"; exit 2 ;;
esac
