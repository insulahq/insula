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
#   ./lt.sh migrate-gentle       init, then the PostgreSQL migration again with fewer write and
#                                blob slots in the live runs (MIG_LIVE_ARGS), under the same load
#   ./lt.sh followup             init, variant v1-pg-meili, migrate-gentle, cluster, report
#   ./lt.sh cluster              v1 on PostgreSQL + Valkey, two pods
#   ./lt.sh all                  everything above, in order
#   ./lt.sh teardown             delete the namespace (results stay in $OUT)
#
# Variants: v016-rocks  v1-rocks  v1-pg  v1-pg-fs  v1-pg-meili  v1-pg-s3  v1-pg-s3remote
#   v016-rocks  today's production shape (0.16.27, RocksDB, blobs inside)
#   v1-rocks    the same on v1
#   v1-pg       v1, PostgreSQL data store (dedicated CNPG cluster), blobs and search in PostgreSQL
#   v1-pg-fs    v1, PostgreSQL data store, blobs on a FileSystem volume
#   v1-pg-meili v1-pg-fs with the full-text index in Meilisearch instead of PostgreSQL
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
IMG_RCLONE=docker.io/rclone/rclone:1.76.0               # = the platform's rclone pin
IMG_VALKEY=docker.io/valkey/valkey:9.1.3-alpine         # = k8s/base/valkey
IMG_MEILI=docker.io/getmeili/meilisearch:v1.56.0
STALWART_CPU=${STALWART_CPU:-1000m}
STALWART_MEM=${STALWART_MEM:-2Gi}
PG_CPU=${PG_CPU:-1000m}
PG_MEM=${PG_MEM:-2Gi}
PG_SHARED_BUFFERS=${PG_SHARED_BUFFERS:-512MB}
PG_INSTANCES=${PG_INSTANCES:-1}     # > 1: streaming replicas (CNPG HA), each with a full copy
PG_SYNC=${PG_SYNC:-off}             # on: one synchronous standby (ANY 1) — no committed mail lost on failover
PG_ANTI_AFFINITY=${PG_ANTI_AFFINITY:-false}  # true on a multi-node cluster: one instance per node
PG_SC=${PG_SC:-local-path}
# BLOB_SC: the blob directory of a FileSystem variant on its own volume of this storage class
# (empty: a subPath of the data volume); BLOB_ACCESS ReadWriteMany for a volume several pods share
BLOB_SC=${BLOB_SC:-}
BLOB_ACCESS=${BLOB_ACCESS:-ReadWriteOnce}
MEILI_CPU=${MEILI_CPU:-1000m}  # PostgreSQL's budget again, on top of it: the report counts both per op
MEILI_MEM=${MEILI_MEM:-2Gi}
ACCOUNTS=${ACCOUNTS:-50}
PER_ACCOUNT=${PER_ACCOUNT:-600}
BIG=${BIG:-25000}
READ_SECONDS=${READ_SECONDS:-180}
MIXED_SECONDS=${MIXED_SECONDS:-300}
# Extra stalwart-migrate options for the two live runs (0.16 still serving), and a suffix for
# the result name. The final run always goes at full speed: 0.16 is stopped by then.
MIG_LIVE_ARGS=${MIG_LIVE_ARGS:-}
MIG_TAG=${MIG_TAG:-}
# Every migration starts from the same 0.16 store, which keeps what the previous one delivered.
# A message number reused there carries the same Message-ID, and Stalwart drops it as a
# duplicate after accepting it, so an SMTP phase would wait for mail that is never stored.
# Each migration sends from its own range: MIG_OFF advances by 100000 per migration.
MIG_N=0
MIG_OFF=0

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
lg() { kx exec -i lt-loadgen -- env LT_HOST="${LT_HOST:-lt-stalwart}" LT_RAISE_UPLOAD_QUOTA="${LT_RAISE_UPLOAD_QUOTA:-0}" python3 /opt/lt/loadgen.py "$@"; }

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
  kx create configmap lt-scripts --from-file="$HERE/loadgen.py" --from-file="$HERE/failover-probe.py" --dry-run=client -o yaml | kx apply -f - >/dev/null
  kx apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: lt-loadgen
  labels: {app: lt-loadgen}
spec:
  terminationGracePeriodSeconds: 1${LOADGEN_NODE:+
  nodeSelector: {kubernetes.io/hostname: $LOADGEN_NODE\}}
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
  local sync="" plugins=""
  [[ $PG_SYNC == on ]] && sync=$'\n    synchronous: {method: any, number: 1, dataDurability: required}'
  # WAL archiving through the barman-cloud plugin, as the platform's system-db does (r2.sh objstore_up)
  [[ ${PG_WAL_ARCHIVE:-off} == on ]] &&
    plugins=$'\n  plugins:\n    - {name: barman-cloud.cloudnative-pg.io, isWALArchiver: true, parameters: {barmanObjectName: lt-objstore}}'
  kx apply -f - >/dev/null <<YAML
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: lt-pg
spec:
  instances: $PG_INSTANCES
  imageName: $IMG_PG
  affinity: {enablePodAntiAffinity: $PG_ANTI_AFFINITY, topologyKey: kubernetes.io/hostname, podAntiAffinityType: required}${plugins}
  storage: {size: 60Gi, storageClass: $PG_SC}
  resources:
    requests: {cpu: 500m, memory: 512Mi}
    limits: {cpu: "$PG_CPU", memory: $PG_MEM}
  postgresql:${sync}
    parameters:
      shared_buffers: $PG_SHARED_BUFFERS
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
    # pg_basebackup in the pod (backup_cost) connects over the local socket; CNPG's default
    # pg_hba has no local replication entry
    pg_hba: ["local replication postgres peer"]
  bootstrap:
    initdb:
      database: stalwart
      owner: stalwart
      secret: {name: lt-pg-app}
YAML
  local _
  for _ in $(seq 1 180); do
    [[ "$(kx get cluster lt-pg -o jsonpath='{.status.readyInstances}' 2>/dev/null)" == "$PG_INSTANCES" ]] && break
    sleep 5
  done
  [[ "$(kx get cluster lt-pg -o jsonpath='{.status.readyInstances}')" == "$PG_INSTANCES" ]] || die "lt-pg not ready"
  log "postgres: lt-pg ready ($PG_INSTANCES instance(s), synchronous standby: $PG_SYNC)"
}

pg_primary() { kx get cluster lt-pg -o jsonpath='{.status.currentPrimary}' 2>/dev/null || echo lt-pg-1; }
psql_pg() { kx exec -i "$(pg_primary)" -c postgres -- psql -U postgres -v ON_ERROR_STOP=1 -At "$@"; }

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

# Valkey with Sentinel, the shape of the platform's dormant k8s/base/valkey (3 pods, each a valkey
# and a sentinel container, quorum 2, platform sizing: valkey 64 MB maxmemory / 96 Mi limit,
# sentinel 48 Mi), without its password (namespace-internal test). Option C's in-memory store and
# coordinator.
VALKEY_NODES=${VALKEY_NODES:-3}
sentinel_store() {
  local i urls=""
  for i in $(seq 0 $(( VALKEY_NODES - 1 ))); do urls+="\"redis://lt-valkey-ha-$i.lt-valkey-hl.$NS.svc.cluster.local:26379\":true,"; done
  echo '{"@type":"RedisSentinel","urls":{'"${urls%,}"'},"serviceName":"mymaster"}'
}
valkey_ha_up() {
  kx get sts lt-valkey-ha >/dev/null 2>&1 && return 0
  kx apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Service
metadata: {name: lt-valkey-hl}
spec:
  clusterIP: None
  publishNotReadyAddresses: true
  selector: {app: lt-valkey-ha}
  ports: [{name: redis, port: 6379}, {name: sentinel, port: 26379}]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: {name: lt-valkey-ha}
spec:
  serviceName: lt-valkey-hl
  replicas: $VALKEY_NODES
  podManagementPolicy: Parallel
  selector: {matchLabels: {app: lt-valkey-ha}}
  template:
    metadata: {labels: {app: lt-valkey-ha}}
    spec:
      topologySpreadConstraints:
        - {maxSkew: 1, topologyKey: kubernetes.io/hostname, whenUnsatisfiable: ScheduleAnyway, labelSelector: {matchLabels: {app: lt-valkey-ha}}}
      initContainers:
        - name: config
          image: $IMG_VALKEY
          command:
            - sh
            - -c
            - |
              me=\$(hostname).lt-valkey-hl.$NS.svc.cluster.local
              primary=lt-valkey-ha-0.lt-valkey-hl.$NS.svc.cluster.local
              cat > /etc/valkey/valkey.conf <<EOF
              port 6379
              maxmemory 64mb
              maxmemory-policy allkeys-lru
              save ""
              appendonly no
              repl-timeout 60
              replica-read-only yes
              replica-announce-ip \$me
              EOF
              [ "\$(hostname)" = lt-valkey-ha-0 ] || echo "replicaof \$primary 6379" >> /etc/valkey/valkey.conf
              cat > /etc/valkey/sentinel.conf <<EOF
              port 26379
              sentinel resolve-hostnames yes
              sentinel announce-hostnames yes
              sentinel announce-ip \$me
              sentinel monitor mymaster \$primary 6379 2
              sentinel down-after-milliseconds mymaster 5000
              sentinel failover-timeout mymaster 30000
              sentinel parallel-syncs mymaster 1
              EOF
              sed -i 's/^ *//' /etc/valkey/valkey.conf /etc/valkey/sentinel.conf
          volumeMounts: [{name: conf, mountPath: /etc/valkey}]
      containers:
        - name: valkey
          image: $IMG_VALKEY
          args: [/etc/valkey/valkey.conf]
          resources:
            requests: {cpu: 25m, memory: 64Mi}
            limits: {cpu: 250m, memory: 96Mi}
          volumeMounts: [{name: conf, mountPath: /etc/valkey}]
        - name: sentinel
          image: $IMG_VALKEY
          command: [sh, -c, "until getent hosts lt-valkey-ha-0.lt-valkey-hl.$NS.svc.cluster.local; do sleep 1; done; exec valkey-sentinel /etc/valkey/sentinel.conf"]
          resources:
            requests: {cpu: 10m, memory: 32Mi}
            limits: {cpu: 100m, memory: 48Mi}
          volumeMounts: [{name: conf, mountPath: /etc/valkey}]
      volumes: [{name: conf, emptyDir: {}}]
YAML
  kx rollout status sts/lt-valkey-ha --timeout=300s >/dev/null || die "lt-valkey-ha not ready"
  local _ q
  for _ in $(seq 1 30); do
    q=$(kx exec lt-valkey-ha-0 -c sentinel -- valkey-cli -p 26379 sentinel ckquorum mymaster 2>/dev/null)
    [[ $q == OK* ]] && break; sleep 2
  done
  log "valkey-ha: $VALKEY_NODES nodes, sentinel: ${q:-no answer}"
}
valkey_ha_down() { kx delete sts lt-valkey-ha --ignore-not-found --wait=true >/dev/null; kx delete svc lt-valkey-hl --ignore-not-found >/dev/null; }

# Garage (garagehq.deuxfleurs.fr, AGPL), an S3 for small self-hosted clusters: GARAGE_NODES pods,
# each object stored on min(3, nodes) of them (replication_factor). The multi-node path for blobs
# that no single node holds alone.
IMG_GARAGE=docker.io/dxflrs/garage:v2.5.0
GARAGE_NODES=${GARAGE_NODES:-1}
GARAGE_SC=${GARAGE_SC:-local-path}
garage_up() {
  garage_down
  local rf=$(( GARAGE_NODES < 3 ? GARAGE_NODES : 3 ))
  kx create secret generic lt-garage --from-literal=rpc="$(openssl rand -hex 32)" \
    --from-literal=admin="$(openssl rand -hex 24)" --dry-run=client -o yaml | kx apply -f - >/dev/null
  kx apply -f - >/dev/null <<YAML
apiVersion: v1
kind: ConfigMap
metadata: {name: lt-garage}
data:
  garage.toml: |
    metadata_dir = "/data/meta"
    data_dir = "/data/blocks"
    db_engine = "lmdb"
    replication_factor = $rf
    consistency_mode = "consistent"
    compression_level = "none"
    rpc_bind_addr = "[::]:3901"
    bootstrap_peers = []
    [kubernetes_discovery]
    namespace = "$NS"
    service_name = "lt-garage"
    skip_crd = false
    [s3_api]
    s3_region = "garage"
    api_bind_addr = "[::]:3900"
    [admin]
    api_bind_addr = "[::]:3903"
---
apiVersion: v1
kind: ServiceAccount
metadata: {name: lt-garage}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: {name: lt-garage}
rules:
  - {apiGroups: [deuxfleurs.fr], resources: [garagenodes], verbs: [get, list, watch, create, update, patch, delete]}
  - {apiGroups: [apiextensions.k8s.io], resources: [customresourcedefinitions], verbs: [get, list, watch, create, update, patch]}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: {name: lt-garage}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: lt-garage}
subjects: [{kind: ServiceAccount, name: lt-garage, namespace: $NS}]
---
apiVersion: v1
kind: Service
metadata: {name: lt-garage}
spec:
  selector: {app: lt-garage}
  ports: [{name: s3, port: 3900}, {name: admin, port: 3903}]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: {name: lt-garage}
spec:
  serviceName: lt-garage
  replicas: $GARAGE_NODES
  podManagementPolicy: Parallel
  selector: {matchLabels: {app: lt-garage}}
  template:
    metadata: {labels: {app: lt-garage}}
    spec:
      serviceAccountName: lt-garage
      topologySpreadConstraints:
        - {maxSkew: 1, topologyKey: kubernetes.io/hostname, whenUnsatisfiable: DoNotSchedule, labelSelector: {matchLabels: {app: lt-garage}}}
      containers:
        - name: garage
          image: $IMG_GARAGE
          env:
            - {name: GARAGE_RPC_SECRET, valueFrom: {secretKeyRef: {name: lt-garage, key: rpc}}}
            - {name: GARAGE_ADMIN_TOKEN, valueFrom: {secretKeyRef: {name: lt-garage, key: admin}}}
          resources:
            requests: {cpu: 100m, memory: 128Mi}
            limits: {cpu: "1", memory: 1Gi}
          volumeMounts:
            - {name: data, mountPath: /data}
            - {name: conf, mountPath: /etc/garage.toml, subPath: garage.toml}
      volumes: [{name: conf, configMap: {name: lt-garage}}]
  volumeClaimTemplates:
    - metadata: {name: data}
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: $GARAGE_SC
        resources: {requests: {storage: 60Gi}}
YAML
  kx rollout status sts/lt-garage --timeout=600s >/dev/null || die "lt-garage not ready"
  local g="kx exec lt-garage-0 -- /garage" ids id _ n
  for _ in $(seq 1 60); do
    n=$($g status 2>/dev/null | grep -c -E '^[0-9a-f]{16}')
    (( n >= GARAGE_NODES )) && break; sleep 3
  done
  ids=$($g status 2>/dev/null | grep -o -E '^[0-9a-f]{16}')
  for id in $ids; do $g layout assign -z dc1 -c 50G "$id" >/dev/null || die "garage: layout assign $id"; done
  $g layout apply --version 1 >/dev/null || die "garage: layout apply"
  $g bucket create stalwart >/dev/null || die "garage: bucket"
  local key; key=$($g key create lt-stalwart 2>&1)
  local kid ksec
  kid=$(grep -o -E 'GK[0-9a-f]{24}' <<<"$key" | head -1)
  ksec=$(grep -i -E 'secret' <<<"$key" | grep -o -E '[0-9a-f]{64}' | head -1)
  [[ -n $kid && -n $ksec ]] || die "garage: key not parsed: $(head -c 300 <<<"$key" | tr -d '0-9a-f' | head -c 120)"
  $g bucket allow --read --write --owner stalwart --key lt-stalwart >/dev/null || die "garage: bucket allow"
  kx create secret generic lt-garage-key --from-literal=id="$kid" --from-literal=secret="$ksec" \
    --dry-run=client -o yaml | kx apply -f - >/dev/null
  log "garage: $GARAGE_NODES node(s), replication factor $rf, bucket ready"
}
garage_blob_store() {
  echo '"blobStore":{"@type":"S3","bucket":"stalwart","region":{"@type":"Custom","region":"garage","url":"http://lt-garage:3900"},"accessKeyId":{"@type":"Value","value":"'"$(kx get secret lt-garage-key -o jsonpath='{.data.id}' | base64 -d)"'"},"secretKey":{"@type":"Value","secret":"'"$(kx get secret lt-garage-key -o jsonpath='{.data.secret}' | base64 -d)"'"}}'
}
garage_down() {
  kx delete sts lt-garage --ignore-not-found --wait=true >/dev/null
  local i; for i in $(seq 0 4); do kx delete pvc "data-lt-garage-$i" --ignore-not-found --wait=false >/dev/null; done
  kx delete garagenodes.deuxfleurs.fr --all --ignore-not-found >/dev/null 2>&1
}

# retention_apply <variant> — RETENTION_JSON: {"spam": {SpamClassifier fields}, "data": {DataRetention
# fields}} written before the restart that applies them (ADR-065 Decision 7: deleted mail retained as
# briefly as possible)
retention_apply() {
  local v=$1 calls
  calls=$(python3 -c 'import json,sys; r=json.loads(sys.argv[1]); c=[]
if r.get("spam"): c.append(["x:SpamClassifier/set",{"update":{"singleton":r["spam"]}},"s"])
if r.get("data"): c.append(["x:DataRetention/set",{"update":{"singleton":r["data"]}},"d"])
print(json.dumps(c))' "$RETENTION_JSON") || die "$v: RETENTION_JSON is not JSON"
  echo "$calls" | lg admin > "$OUT/$v/setup-retention.json" || die "$v: retention: $(head -c 400 "$OUT/$v/setup-retention.json")"
  grep -q '"notUpdated"' "$OUT/$v/setup-retention.json" && die "$v: retention refused: $(head -c 600 "$OUT/$v/setup-retention.json")"
  log "$v: retention settings applied ($RETENTION_JSON)"
}

# ── Stalwart instances ─────────────────────────────────────────────────────────────

# pvc <name> [storage class] [access mode] [size] — a fresh volume (local-path, ReadWriteOnce, 60Gi by
# default; local-path does not enforce the size, Longhorn reserves it: 60Gi did not fit on DEV's disk)
pvc() {
  kx apply -f - >/dev/null <<YAML
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: $1}
spec:
  accessModes: [${3:-ReadWriteOnce}]
  storageClassName: ${2:-local-path}
  resources: {requests: {storage: ${4:-60Gi}}}
YAML
}

# lt-longhorn: a Longhorn class for the blob-volume tests, with LONGHORN_REPLICAS copies of every
# block (1 on single-node DEV; 3 on the staging cluster, one per node). RWX volumes are served by a
# share-manager pod over NFSv4.
LONGHORN_REPLICAS=${LONGHORN_REPLICAS:-1}
longhorn_sc() {
  $K apply -f - >/dev/null <<YAML
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: lt-longhorn
  labels: {app.kubernetes.io/part-of: stalwart-loadtest}
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Delete
volumeBindingMode: Immediate
parameters:
  numberOfReplicas: "$LONGHORN_REPLICAS"
  staleReplicaTimeout: "30"
  fsType: ext4
  dataLocality: disabled
  nfsOptions: "vers=4.1,noresvport,softerr,timeo=600,retrans=5"
YAML
}

# stalwart_deploy <name> <image> <pvc> <root> <etc> <replicas> — root is where the store's
# data/ and blobs/ live (/var/lib/stalwart, or /var/lib/stalwart-v1 for a migration target), etc
# is the config directory. The launcher is production's (THP off, capability-free copy).
stalwart_deploy() {
  local name=$1 image=$2 claim=$3 root=$4 etc=$5 replicas=${6:-1}
  # the blob directory: a subPath of the store volume, or its own volume (BLOB_SC)
  local blob_mount="{name: store, mountPath: $root/blobs, subPath: blobs}" blob_vol="" init_blobs=""
  if [[ -n $BLOB_SC ]]; then
    blob_mount="{name: blobs, mountPath: $root/blobs}"
    blob_vol="- {name: blobs, persistentVolumeClaim: {claimName: lt-blobs}}"
    init_blobs=", {name: blobs, mountPath: /blobs}"
  fi
  # CONFIG_SECRET=1: no shared store volume — every pod copies config.json from the Secret lt-config
  # into its own emptyDir (pods on several nodes; the stores are all remote: PostgreSQL, S3, RWX)
  local store_vol="{name: store, persistentVolumeClaim: {claimName: $claim}}" conf_vol="" conf_cp="" init_conf=""
  if [[ -n ${USE_CONFIG_SECRET:-} ]]; then  # set by stalwart_up once the Secret exists
    store_vol="{name: store, emptyDir: {}}"
    conf_vol="- {name: conf, secret: {secretName: lt-config}}"
    conf_cp=" && cp /conf/config.json /pvc/etc/config.json && chown 2000:2000 /pvc/etc/config.json"
    init_conf=", {name: conf, mountPath: /conf}"
  fi
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
      topologySpreadConstraints:  # one pod per node where there are several (staging)
        - {maxSkew: 1, topologyKey: kubernetes.io/hostname, whenUnsatisfiable: ScheduleAnyway, labelSelector: {matchLabels: {lt-instance: $name}}}${STALWART_NODE:+
      nodeSelector: {kubernetes.io/hostname: $STALWART_NODE\}}${STALWART_AVOID_NODE:+
      affinity: {nodeAffinity: {requiredDuringSchedulingIgnoredDuringExecution: {nodeSelectorTerms: [{matchExpressions: [{key: kubernetes.io/hostname, operator: NotIn, values: [$STALWART_AVOID_NODE]\}]\}]\}\}\}}
      initContainers:
        - name: dirs
          image: $image
          securityContext: {runAsUser: 0}
          command: [sh, -c, "mkdir -p /pvc/data /pvc/blobs /pvc/etc && chown 2000:2000 /pvc/data /pvc/blobs /pvc/etc && if [ -d /blobs ]; then chown 2000:2000 /blobs; fi${conf_cp}"]
          volumeMounts: [{name: store, mountPath: /pvc}$init_blobs$init_conf]
        - name: stalwart-binary
          image: $image
          # tmp + mv, as production's: after a node restart the pod's emptyDir still holds the 0555
          # copy, and cp onto it fails (Permission denied) — the pod never starts again
          command: [sh, -c, "cp /usr/local/bin/stalwart /opt/stalwart-bin/stalwart.tmp && chmod 0555 /opt/stalwart-bin/stalwart.tmp && mv -f /opt/stalwart-bin/stalwart.tmp /opt/stalwart-bin/stalwart"]
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
            - {name: imaps, containerPort: 993}
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
            - $blob_mount
            - {name: store, mountPath: $etc, subPath: etc}
      volumes:
        - {name: bin, emptyDir: {}}
        - $store_vol
        $blob_vol
        $conf_vol
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
    - {name: imaps, port: 993}
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

meili_up() {  # a fresh, empty Meilisearch for one variant (development mode: no key, namespace-internal)
  meili_down
  pvc lt-meili
  kx apply -f - >/dev/null <<YAML
apiVersion: apps/v1
kind: Deployment
metadata: {name: lt-meili}
spec:
  replicas: 1
  strategy: {type: Recreate}
  selector: {matchLabels: {app: lt-meili}}
  template:
    metadata: {labels: {app: lt-meili}}
    spec:
      containers:
        - name: meilisearch
          image: $IMG_MEILI
          env:
            - {name: MEILI_ENV, value: development}
            - {name: MEILI_NO_ANALYTICS, value: "true"}
            - {name: MEILI_DB_PATH, value: /meili_data/data.ms}
          ports: [{containerPort: 7700}]
          resources:
            requests: {cpu: 250m, memory: 512Mi}
            limits: {cpu: "$MEILI_CPU", memory: $MEILI_MEM}
          volumeMounts: [{name: data, mountPath: /meili_data}]
      volumes: [{name: data, persistentVolumeClaim: {claimName: lt-meili}}]
---
apiVersion: v1
kind: Service
metadata: {name: lt-meili}
spec:
  selector: {app: lt-meili}
  ports: [{name: http, port: 7700}]
YAML
  kx rollout status deploy/lt-meili --timeout=300s >/dev/null || die "lt-meili not ready"
}
meili_exact() {
  # v1 creates its indexes with Meilisearch's default typo tolerance, so a search for an invoice
  # number also returns its neighbours (in DinD, zq197x matched 1 message exactly and 22 with one
  # letter off). A deployment has to switch it off; v1 leaves the setting alone after that,
  # across restarts and new mail. Runs once the indexes exist (after setup).
  kx exec -i lt-loadgen -- python3 - <<'PY' > "$OUT/$1/meili-typo.json" || die "$1: typo tolerance not switched off"
import json, time, urllib.request
base = "http://lt-meili:7700"
def call(path, body=None, method="GET"):
    req = urllib.request.Request(base + path, method=method, headers={"Content-Type": "application/json"},
                                 data=None if body is None else json.dumps(body).encode())
    return json.load(urllib.request.urlopen(req, timeout=30))
out = {}
for idx in [i["uid"] for i in call("/indexes?limit=100")["results"]]:
    task = call(f"/indexes/{idx}/settings/typo-tolerance", {"enabled": False}, "PATCH")["taskUid"]
    for _ in range(120):
        st = call(f"/tasks/{task}")["status"]
        if st in ("succeeded", "failed", "canceled"):
            break
        time.sleep(0.5)
    out[idx] = {"task": st, "enabled": call(f"/indexes/{idx}/settings/typo-tolerance")["enabled"]}
print(json.dumps(out))
if not out or any(v["task"] != "succeeded" or v["enabled"] for v in out.values()):
    raise SystemExit(1)
PY
  log "$1: Meilisearch typo tolerance off ($(cat "$OUT/$1/meili-typo.json"))"
}
meili_down() {
  kx delete deploy lt-meili --ignore-not-found --wait=true >/dev/null
  kx delete pvc lt-meili --ignore-not-found --wait=true >/dev/null
}
# A variant name may carry a +tag (v1-pg-fs+lhrwx): the same store shape on another volume or
# cluster layout, with its own results directory. The shape is the part before the +.
base_of() { echo "${1%%+*}"; }

variant_stores() {
  local pg ak sk b; b=$(base_of "$1")
  local fs='"blobStore":{"@type":"FileSystem","path":"/var/lib/stalwart/blobs","depth":2}'
  case $b in
    v016-rocks|v1-rocks) echo '{"dataStore":{"@type":"RocksDb","path":"/var/lib/stalwart/data"}}' ;;
    v1-pg*)
      pg=$(secret pg)
      local data='{"@type":"PostgreSql","host":"lt-pg-rw","port":5432,"database":"stalwart","authUsername":"stalwart","authSecret":{"@type":"Value","secret":"'"$pg"'"},"useTls":false}'
      case $b in
        v1-pg) echo '{"dataStore":'"$data"'}' ;;
        v1-pg-fs) echo '{"dataStore":'"$data"','"$fs"'}' ;;
        v1-pg-meili) echo '{"dataStore":'"$data"','"$fs"',"searchStore":{"@type":"Meilisearch","url":"http://lt-meili:7700"}}' ;;
        v1-pg-s3)
          ak=$(secret s3ak); sk=$(secret s3sk)
          echo '{"dataStore":'"$data"',"blobStore":{"@type":"S3","bucket":"stalwart","region":{"@type":"Custom","region":"us-east-1","url":"http://lt-s3:9000"},"accessKeyId":{"@type":"Value","value":"'"$ak"'"},"secretKey":{"@type":"Value","secret":"'"$sk"'"}}}' ;;
        v1-pg-s3remote)
          echo '{"dataStore":'"$data"',"blobStore":{"@type":"S3","bucket":"'"$S3R_BUCKET"'","region":{"@type":"Custom","region":"us-east-1","url":"'"$S3R_ENDPOINT"'"},"accessKeyId":{"@type":"Value","value":"'"$S3R_ACCESS_KEY"'"},"secretKey":{"@type":"Value","secret":"'"$S3R_SECRET_KEY"'"}}}' ;;
        v1-pg-garage)  # Garage, an S3 that replicates every object over GARAGE_NODES nodes
          echo '{"dataStore":'"$data"','"$(garage_blob_store)"'}' ;;
        v1-pg-cluster-garage)  # option C with Garage for the blobs: nothing on any one node's disk
          echo '{"dataStore":'"$data"','"$(garage_blob_store)"',"inMemoryStore":'"$(sentinel_store)"'}' ;;
        v1-pg-cluster) echo '{"dataStore":'"$data"',"inMemoryStore":{"@type":"Redis","url":"redis://lt-valkey:6379"}}' ;;
        v1-pg-cluster-ha)  # FS blobs on a shared volume (BLOB_SC/BLOB_ACCESS), Valkey with Sentinel
          echo '{"dataStore":'"$data"','"$fs"',"inMemoryStore":'"$(sentinel_store)"'}' ;;
      esac ;;
  esac
}

# stalwart_up <variant> [replicas] — fresh store, bootstrap, configure, accounts
stalwart_up() {
  local v=$1 replicas=${2:-1} ver=1 image=$IMG_V1 t0=$SECONDS s b; b=$(base_of "$1")
  [[ $b == v016* ]] && { ver=0.16; image=$IMG_016; }
  stalwart_down  # a failed earlier variant must not leave its store behind
  [[ $b == v1-pg* ]] && { cmd_pg_up; pg_reset_db stalwart; }
  [[ $b == v1-pg-s3 ]] && { cmd_s3_up; s3_reset; }
  [[ $b == v1-pg-s3remote ]] && s3r_reset
  [[ $b == v1-pg-cluster ]] && cmd_valkey_up
  [[ $b == v1-pg-cluster-ha || $b == v1-pg-cluster-garage ]] && valkey_ha_up
  [[ $b == v1-pg-garage || $b == v1-pg-cluster-garage ]] && garage_up
  [[ $b == v1-pg-meili ]] && meili_up
  [[ ${DATA_SC:-} == lt-longhorn || $BLOB_SC == lt-longhorn ]] && longhorn_sc
  # DATA_SC/DATA_ACCESS: the volume with the config (and RocksDB) — ReadWriteMany when pods on several
  # nodes share it (staging); BLOB_SC: the blob directory on its own volume
  pvc lt-data "${DATA_SC:-local-path}" "${DATA_ACCESS:-ReadWriteOnce}" "${DATA_SIZE:-60Gi}"
  [[ -n $BLOB_SC ]] && pvc lt-blobs "$BLOB_SC" "$BLOB_ACCESS" "${BLOB_SIZE:-15Gi}"
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
  if [[ $b == v1-pg-cluster ]]; then
    echo '[["x:Coordinator/set",{"update":{"singleton":{"@type":"Default"}}},"c0"]]' |
      lg admin > "$OUT/$v/setup-coordinator.json" || die "$v: coordinator: $(cat "$OUT/$v/setup-coordinator.json")"
  fi
  if [[ $b == v1-pg-cluster-ha || $b == v1-pg-cluster-garage ]]; then
    echo '[["x:Coordinator/set",{"update":{"singleton":'"$(sentinel_store)"'}},"c0"]]' |
      lg admin > "$OUT/$v/setup-coordinator.json" || die "$v: coordinator: $(cat "$OUT/$v/setup-coordinator.json")"
    grep -q '"updated"' "$OUT/$v/setup-coordinator.json" || die "$v: coordinator not set: $(head -c 400 "$OUT/$v/setup-coordinator.json")"
  fi
  [[ -n ${RETENTION_JSON:-} ]] && retention_apply "$v"
  s=$(restart_pods lt-stalwart) || die "$v: not ready after configure"
  [[ $b == v1-pg-meili ]] && meili_exact "$v"
  if [[ -n ${CONFIG_SECRET:-} ]]; then  # from here on, pods carry their config from the Secret
    kx exec deploy/lt-stalwart -c stalwart -- cat /etc/stalwart/config.json > "$OUT/$v/config.json.tmp" &&
      kx create secret generic lt-config --from-file=config.json="$OUT/$v/config.json.tmp" --dry-run=client -o yaml | kx apply -f - >/dev/null ||
      die "$v: config not captured"
    rm -f "$OUT/$v/config.json.tmp"
    USE_CONFIG_SECRET=1 stalwart_deploy lt-stalwart "$image" lt-data /var/lib/stalwart /etc/stalwart 1
    s=$(wait_ready lt-stalwart) || die "$v: not ready with the config from the Secret"
  fi
  if (( replicas > 1 )); then
    kx scale deploy lt-stalwart --replicas="$replicas" >/dev/null
    s=$(wait_ready lt-stalwart) || die "$v: $replicas replicas not ready"
  fi
  log "$v: configured, $replicas replica(s), setup took $(( SECONDS - t0 ))s"
}

stalwart_down() {  # also whatever a failed migration left (its pods carry app=lt-stalwart too)
  kx delete deploy lt-stalwart lt-stalwart-v1 --ignore-not-found --wait=true >/dev/null
  kx delete pod lt-rb016 lt-migrate --ignore-not-found --wait=true >/dev/null
  kx delete pvc lt-data lt-blobs lt-mig-target lt-mig-state --ignore-not-found --wait=true >/dev/null
  meili_down
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
  if [[ $v == v1-pg* || $v == mig-pg* ]] && kx get pod "$(pg_primary)" >/dev/null 2>&1; then
    local db_name=stalwart; [[ $v == mig-pg* ]] && db_name=stalwart_mig
    pgj=$(psql_pg -d "$db_name" -c "SELECT json_build_object(
      'db_bytes', pg_database_size(current_database()),
      'wal_bytes', (SELECT wal_bytes FROM pg_stat_wal),
      'wal_fpi', (SELECT wal_fpi FROM pg_stat_wal),
      'tables', (SELECT json_agg(t) FROM (SELECT relname, pg_total_relation_size(relid) AS total,
                 pg_relation_size(relid) AS heap, n_live_tup, n_dead_tup,
                 last_autovacuum IS NOT NULL AS autovacuumed
                 FROM pg_stat_user_tables ORDER BY 2 DESC LIMIT 12) t))" 2>/dev/null) || pgj='null'
    local pgp; pgp=$(pv_path "$(pg_primary)") &&
      pgj=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d["pvc_bytes"]=int(sys.argv[2]); d["pg_wal_dir_bytes"]=int(sys.argv[3]); print(json.dumps(d))' \
        "$pgj" "$(du -sb "$pgp" | cut -f1)" "$(du -sb "$pgp"/pgdata/pg_wal 2>/dev/null | cut -f1 || echo 0)")
    # every instance's volume, allocated blocks (what the disk loses), pg_wal apart
    local i ip inst='['
    for i in $(seq 1 "$PG_INSTANCES"); do
      ip=$(pv_path "lt-pg-$i") || continue
      inst+="{\"name\":\"lt-pg-$i\",\"alloc\":$(du -s -B1 "$ip" | cut -f1),\"wal_alloc\":$(du -s -B1 "$ip"/pgdata/pg_wal 2>/dev/null | cut -f1 || echo 0)},"
    done
    inst="${inst%,}]"
    pgj=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d["instances"]=json.loads(sys.argv[2]); print(json.dumps(d))' "$pgj" "$inst" 2>/dev/null || echo "$pgj")
  fi
  # allocated bytes of the Stalwart volumes: a small file still takes a whole 4 KiB block
  local da=0 ba=0 bp
  [[ -n "$p" ]] && { da=$(du -s -B1 "$p/data" 2>/dev/null | cut -f1); ba=$(du -s -B1 "$p/blobs" 2>/dev/null | cut -f1); }
  if [[ -n $BLOB_SC ]] && bp=$(pv_path lt-blobs) && [[ -n $bp ]]; then  # a separate blob volume on a hostPath class
    db=$(du -sb "$bp" | cut -f1); ba=$(du -s -B1 "$bp" | cut -f1); fb=$(find "$bp" -type f | wc -l)
  elif [[ -n $BLOB_SC ]]; then  # Longhorn: measure inside the pod
    read -r db ba fb < <(kx exec deploy/lt-stalwart -c stalwart -- sh -c 'echo $(du -sb /var/lib/stalwart/blobs | cut -f1) $(du -s -B1 /var/lib/stalwart/blobs | cut -f1) $(find /var/lib/stalwart/blobs -type f | wc -l)' 2>/dev/null) || true
  fi
  if [[ $(base_of "$v") == v1-pg-s3 ]]; then
    local sp; sp=$(pv_path lt-s3) &&
      s3j="{\"bytes\":$(du -sb "$sp" | cut -f1),\"files\":$(find "$sp" -type f | wc -l)}"
  fi
  if [[ $(base_of "$v") == v1-pg-s3remote ]]; then  # rclone size --json → {"count":…,"bytes":…}
    s3j=$(s3r size --json "r:$S3R_BUCKET" 2>/dev/null | grep '^{') || s3j='null'
  fi
  local searchj='null' mp
  if [[ $(base_of "$v") == v1-pg-meili ]] && mp=$(pv_path lt-meili); then
    searchj="{\"bytes\":$(du -sb "$mp" | cut -f1)}"
  fi
  if [[ $(base_of "$v") == v1-pg*garage ]]; then  # every Garage node's data volume (the replicas of each blob)
    local gi gp g='{"nodes":['
    for gi in $(seq 0 $(( GARAGE_NODES - 1 ))); do
      gp=$(pv_path "data-lt-garage-$gi") || continue
      g+="{\"node\":$gi,\"bytes\":$(du -sb "$gp" | cut -f1),\"alloc\":$(du -s -B1 "$gp" | cut -f1)},"
    done
    s3j="${g%,}]}"
  fi
  printf '{"variant":"%s","label":"%s","t":%s,"data_bytes":%s,"data_files":%s,"blob_bytes":%s,"blob_files":%s,"data_alloc":%s,"blob_alloc":%s,"pg":%s,"s3":%s,"search":%s}\n' \
    "$v" "$label" "$(date +%s)" "${dd:-0}" "$fd" "${db:-0}" "$fb" "${da:-0}" "${ba:-0}" "$pgj" "$s3j" "$searchj" >> "$OUT/sizes.jsonl"
  log "$v: sizes@$label data=$(numfmt --to=iec "${dd:-0}") blobs=$(numfmt --to=iec "${db:-0}") ($fb files) pg=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print("%.2fGiB wal=%.2fGiB" % (d["db_bytes"] / 2**30, d["wal_bytes"] / 2**30) if d else "-")' "$pgj" 2>/dev/null)"
}

# admin_task <maintenanceType> — enqueue a StoreMaintenance task
admin_task() {
  echo '[["x:Task/set",{"create":{"t":{"@type":"StoreMaintenance","maintenanceType":"'"$1"'"}}},"c0"]]' | lg admin
}
tasks_left() {  # <task type> — how many tasks of that type the server still holds (v1 x:Task)
  echo '[["x:Task/get",{"ids":null},"c0"]]' | lg admin 2>/dev/null |
    python3 -c 'import json,sys; print(sum(1 for t in json.load(sys.stdin)[0][1].get("list", []) if t.get("@type") == sys.argv[1]))' "$1" 2>/dev/null || echo '?'
}
await_tasks() {  # <variant> <task type> <label> — wait (≤ 20 min) until no task of that type is left
  local t0=$SECONDS n
  while (( SECONDS - t0 < 1200 )); do
    n=$(tasks_left "$2"); [[ $n == 0 ]] && break; sleep 10
  done
  printf '{"variant":"%s","step":"%s","seconds":%s,"left":"%s"}\n' "$1" "$3" "$(( SECONDS - t0 ))" "$n" >> "$OUT/reclaim.jsonl"
  log "$1: $3 — $2 tasks drained in $(( SECONDS - t0 ))s (left: $n)"
}

since() { python3 -c "import sys; print(round($EPOCHREALTIME - float(sys.argv[1]), 1))" "$1"; }

pg_basebackup_cost() {  # <variant> — a full base backup of the test cluster, streamed and counted
  local v=$1 t0 bytes
  t0=$EPOCHREALTIME
  # --checkpoint=fast: the default spread checkpoint first waits up to checkpoint_completion_target
  # × checkpoint_timeout (13.5 min here; 832 MB took 503 s on DEV) — a delay before the copy, which
  # CNPG's backups also take by default (immediateCheckpoint: false), not the copy's cost
  bytes=$(kx exec lt-pg-1 -c postgres -- sh -c 'pg_basebackup -U postgres -D - -Ft -X none --checkpoint=fast | wc -c' \
    2> "$OUT/$v/pg_basebackup.err")
  # a refused connection streams nothing: report it instead of recording a 0-byte backup
  (( ${bytes:-0} > 0 )) || log "$v: pg_basebackup failed: $(head -c 300 "$OUT/$v/pg_basebackup.err")"
  printf '{"variant":"%s","kind":"pg_basebackup","bytes":%s,"seconds":%s}\n' "$v" "${bytes:-0}" "$(since "$t0")" >> "$OUT/backups.jsonl"
}
backup_cost() {  # <variant> — the cost of a full copy of the store, as the backups make one
  local v=$1 p t0 bytes
  p=$(pv_path lt-data)
  t0=$EPOCHREALTIME
  bytes=$(tar -cf - -C "$p" data blobs 2>/dev/null | wc -c)
  printf '{"variant":"%s","kind":"tar-pvc","bytes":%s,"seconds":%s}\n' "$v" "$bytes" "$(since "$t0")" >> "$OUT/backups.jsonl"
  [[ $v == v1-pg* ]] && pg_basebackup_cost "$v"
  if [[ $(base_of "$v") == v1-pg-s3 ]]; then
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
release_samples() {  # <variant> — what the store frees once the spam classifier lets go
  # v1 keeps the blob of every unencrypted message appended into INBOX (and of every message a user
  # marks Junk / not Junk, replies, address-book senders) as a spam-classifier training sample for
  # SpamClassifier.holdSamplesFor, 180 days by default — after the message is deleted, too. On DEV
  # the corpus left 47,500 samples, and deleting half the mail freed nothing. Destroying the samples
  # stands in for their expiry; a shorter hold takes effect for new samples after a restart.
  local v=$1 t0=$SECONDS n=0 ids total
  total=$(echo '[["x:SpamTrainingSample/query",{"limit":1,"calculateTotal":true},"c0"]]' | lg admin 2>/dev/null |
          python3 -c 'import json,sys; print(json.load(sys.stdin)[0][1].get("total", 0))' 2>/dev/null) || total='?'
  while :; do
    ids=$(echo '[["x:SpamTrainingSample/query",{"limit":500},"c0"]]' | lg admin 2>/dev/null |
          python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)[0][1].get("ids", [])))' 2>/dev/null) || break
    [[ $ids == "[]" ]] && break
    echo '[["x:SpamTrainingSample/set",{"destroy":'"$ids"'},"c0"]]' | lg admin > /dev/null 2>&1 || break
    n=$(( n + 1 )); (( n > 400 )) && break  # 500 per call: JMAP caps objects per set
  done
  admin_task purgeBlob > "$OUT/$v/purge-blob-samples.json"; sleep 15
  await_tasks "$v" StoreMaintenance blob-purge-after-samples
  printf '{"variant":"%s","step":"release-samples","samples":"%s","seconds":%s}\n' "$v" "$total" "$(( SECONDS - t0 ))" >> "$OUT/reclaim.jsonl"
  sizes "$v" after-sample-release
  log "$v: $total training samples released and blobs purged in $(( SECONDS - t0 ))s"
}
delete_and_reclaim() {
  local v=$1
  sizes "$v" before-delete
  echo '[["x:SpamTrainingSample/query",{"limit":1,"calculateTotal":true},"c0"]]' | lg admin > "$OUT/$v/spam-samples.json" 2>&1
  phase "$v" delete delete --accounts "$ACCOUNTS" --fraction 0.5
  sizes "$v" after-delete
  # v1 frees a deleted message in three steps: the index queue processes the deletion, a per-account
  # purge drops the message and its blob link, and only then can a blob purge delete the blob. On the
  # first DEV run both blob purges ran while 46 account purges were still pending, and nothing was
  # freed. Without a manual purge the blob cleanup runs daily at 04:00 (blobCleanupSchedule).
  admin_task purgeAccounts > "$OUT/$v/purge-accounts.json"
  if [[ $v == v1* ]]; then sleep 15; await_tasks "$v" AccountMaintenance account-purge; else sleep 60; fi
  admin_task purgeBlob > "$OUT/$v/purge-blob-1.json"
  if [[ $v == v1* ]]; then sleep 15; await_tasks "$v" StoreMaintenance blob-purge; else sleep 120; fi
  admin_task purgeData > "$OUT/$v/purge-data.json"; sleep 120
  sizes "$v" after-purge
  sleep 600
  sizes "$v" after-purge-10min
  [[ $v == v1* ]] && release_samples "$v"
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
  MV=mig-$kind${MIG_TAG:+-$MIG_TAG}
  MIG_OFF=$(( MIG_N * 100000 )); MIG_N=$(( MIG_N + 1 ))
  local live; read -ra live <<<"$MIG_LIVE_ARGS"
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
  phase "$MV" mixed-during-copy mixed --accounts "$ACCOUNTS" --duration 600 --smtp-rate 5 --offset $(( 6000000 + MIG_OFF )) &
  local mixed_pid=$!
  mig run-1-live run "${MIG_ARGS[@]}" "${live[@]}"
  wait "$mixed_pid"
  DATA_PVC=lt-mig-target sizes "$MV" after-run-1
  phase "$MV" smtp-delta smtp --accounts "$ACCOUNTS" --count 500 --workers 4 --offset $(( 7000000 + MIG_OFF ))
  mig run-2-delta run "${MIG_ARGS[@]}" "${live[@]}"
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
  if [[ $kind == pg ]]; then
    # On the first DEV run, JMAP text search on the freshly migrated PostgreSQL store took 1.8 s
    # p95 against 41 ms on a store filled by mail: the index tables were bulk-written by the
    # rebuild just before. Record their planner statistics, ANALYZE, and read again.
    psql_pg -d stalwart_mig -c "SELECT json_agg(t) FROM (SELECT relname, n_live_tup, n_mod_since_analyze,
      last_analyze, last_autoanalyze FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC
      LIMIT 12) t" > "$OUT/$MV/table-stats-before-analyze.json" 2>&1
    local ta=$SECONDS
    psql_pg -d stalwart_mig -c "ANALYZE" >/dev/null
    printf '{"variant":"%s","step":"analyze","seconds":%s,"rc":0}\n' "$MV" "$(( SECONDS - ta ))" >> "$OUT/migrations.jsonl"
    log "$MV: ANALYZE in $(( SECONDS - ta ))s"
    phase "$MV" jmap-read-analyzed jmap-read --accounts "$ACCOUNTS" --duration 120 --workers 16
    pg_basebackup_cost "$MV"  # every byte of mail in one database: option B's base backup
    log "$MV: backup cost recorded ($(tail -n 1 "$OUT/backups.jsonl"))"
  fi
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
  phase "$MV" smtp-on-v1 smtp --accounts "$ACCOUNTS" --count 300 --workers 4 --offset $(( 8000000 + MIG_OFF ))
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
cmd_migrate_gentle() {  # what the live copy costs clients when it copies fewer accounts and blobs at once
  local v=v016-rocks
  MIG_LIVE_ARGS=${MIG_LIVE_ARGS:---concurrency 2 --blob-concurrency 2}
  MIG_TAG=${MIG_TAG:-gentle}
  log "=== migrate-gentle (live runs: $MIG_LIVE_ARGS) ==="
  stalwart_up "$v"
  sizes "$v" empty
  phase "$v" append append --accounts "$ACCOUNTS" --per-account "$PER_ACCOUNT" --big "$BIG" --workers 8
  phase "$v" smtp smtp --accounts "$ACCOUNTS" --count 5000 --workers 10
  sizes "$v" after-smtp
  phase "$v" mixed mixed --accounts "$ACCOUNTS" --duration "$MIXED_SECONDS" --smtp-rate 5
  migrate_to pg  # the proposed target (ADR-065 option B); compares with mig-pg of the first run
  stalwart_down
  log "=== migrate-gentle done ==="
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
  # 20,000 messages take ~100 s at the ~200 msg/s v1 on PostgreSQL accepts, so the pod is deleted
  # mid-ingest (the first run sent 3,000 in 15 s and deleted the pod after the ingest had ended)
  phase "$v" smtp-failover smtp --accounts "$ACCOUNTS" --count 20000 --workers 10 --offset 9000000 &
  local smtp_pid=$!
  sleep 30
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

[[ ${BASH_SOURCE[0]} == "$0" ]] || return 0  # sourced by r2.sh: the functions only

case "${1:-}" in
  init) cmd_init ;;
  variant) cmd_variant "${2:?variant}" ;;
  migrate-suite) cmd_migrate_suite ;;
  migrate-gentle) cmd_init; cmd_migrate_gentle ;;
  followup)  # what the first DEV run raised: search outside PostgreSQL, a gentler live copy
    cmd_init
    ( cmd_variant v1-pg-meili ) || log "variant v1-pg-meili failed — continuing"
    ( cmd_migrate_gentle ) || log "migrate-gentle failed — continuing"
    ( cmd_cluster ) || log "cluster failed — continuing"
    python3 "$HERE/report.py" "$OUT" > "$OUT/report.md" 2>> "$OUT/lt.log"
    log "=== followup done — results in $OUT ===" ;;
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
