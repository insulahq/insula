#!/usr/bin/env bash
# integration-stalwart-storage-perf.sh — compares Stalwart-style storage
# performance between local-path (current) and Longhorn 1-replica PVCs.
#
# Target: single-server clusters (testing.phoenix-host.net). The script
# creates a dedicated `perf-test` namespace and a custom 1-replica
# StorageClass (ext4, dataLocality=best-effort) so the comparison
# isolates the Longhorn engine tax from sync-replication cost.
#
# Phases:
#   Phase 1 — fio floor (~16 min):
#     P1.1 4k randwrite QD=1 fsync=1   — RocksDB WAL pattern (latency-bound)
#     P1.2 4k randread  QD=32 direct=1 — RocksDB SST lookup pattern
#     P1.3 1M seqwrite  QD=4           — RocksDB compaction pattern
#     P1.4 64k randrw 70/30 QD=8       — mixed mail workload
#
#   Phase 2 — Stalwart JMAP end-to-end (--phase=2, ~45 min, opt-in):
#     P2.1 bulk import 5000 messages (write throughput)
#     P2.2 Email/query + Email/get random 1000 (read latency)
#     P2.3 mixed: 10 concurrent SMTP delivers + 10 IMAP IDLE × 5min
#
# Output: markdown report at /tmp/storage-perf-report.md on the node,
# plus raw fio JSON at /tmp/storage-perf-<backend>-<pattern>.json
#
# Idempotent: cleans up its namespace + custom SC on every run.
# Safe: does not touch the live mail namespace or PVC.

set -euo pipefail

NS="${NS:-perf-test}"
PVC_SIZE="${PVC_SIZE:-10Gi}"
FIO_RUNTIME="${FIO_RUNTIME:-60}"
FIO_WARMUP="${FIO_WARMUP:-30}"
PHASE="${PHASE:-1}"
SC_LONGHORN="perf-longhorn-1r-ext4"

REPORT="/tmp/storage-perf-report.md"
RESULTS_DIR="/tmp/storage-perf-results"

# ----- helpers --------------------------------------------------------------
log()  { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
fail() { printf '[%s] FAIL: %s\n' "$(date +%H:%M:%S)" "$*" >&2; exit 1; }

cleanup() {
  log "cleanup: deleting namespace $NS and StorageClass $SC_LONGHORN"
  kubectl delete namespace "$NS" --ignore-not-found --wait=true --timeout=120s >/dev/null 2>&1 || true
  kubectl delete storageclass "$SC_LONGHORN" --ignore-not-found >/dev/null 2>&1 || true
}

# ----- setup ----------------------------------------------------------------
setup() {
  log "setup: ensuring clean state"
  cleanup
  mkdir -p "$RESULTS_DIR"
  : > "$REPORT"

  log "setup: creating namespace $NS"
  kubectl create namespace "$NS" >/dev/null

  log "setup: creating 1-replica ext4 longhorn StorageClass $SC_LONGHORN"
  cat <<YAML | kubectl apply -f - >/dev/null
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ${SC_LONGHORN}
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Delete
volumeBindingMode: Immediate
parameters:
  numberOfReplicas: "1"
  dataLocality: "best-effort"
  fsType: "ext4"
  staleReplicaTimeout: "30"
YAML

  for backend in local-path "$SC_LONGHORN"; do
    log "setup: creating PVC perf-${backend} (sc=${backend})"
    cat <<YAML | kubectl apply -f - >/dev/null
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: perf-${backend}
  namespace: ${NS}
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: ${backend}
  resources:
    requests:
      storage: ${PVC_SIZE}
YAML
  done

  # local-path is WaitForFirstConsumer — won't bind until a Pod claims it.
  # We'll let the fio Pods trigger the bind. Verify longhorn bound.
  log "setup: waiting for longhorn PVC to bind (local-path binds on first Pod)"
  for i in $(seq 1 60); do
    local lh_status
    lh_status=$(kubectl -n "$NS" get pvc "perf-${SC_LONGHORN}" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    [[ "$lh_status" == "Bound" ]] && break
    sleep 2
  done
  kubectl -n "$NS" get pvc "perf-${SC_LONGHORN}" -o jsonpath='{.status.phase}' | grep -q Bound \
    || fail "longhorn PVC did not bind within 120s"
  log "setup: complete"
}

# ----- fio runner -----------------------------------------------------------
#
# fio patterns (each runs with $FIO_WARMUP s ramp + $FIO_RUNTIME s measure):
#   wal_4k_fsync     -- randwrite, 4k, QD=1, fsync=1, sync=1  (latency-bound)
#   sst_4k_qd32      -- randread,  4k, QD=32, direct=1         (IOPS read)
#   compaction_1m    -- write,     1M, QD=4                    (throughput)
#   mixed_64k_7030   -- randrw,    64k, QD=8, 70/30 rw         (mixed)
#
fio_pattern_args() {
  case "$1" in
    wal_4k_fsync)
      echo "--rw=randwrite --bs=4k --iodepth=1 --fsync=1 --sync=1 --direct=0 --size=512M --numjobs=1"
      ;;
    sst_4k_qd32)
      echo "--rw=randread --bs=4k --iodepth=32 --direct=1 --size=2G --numjobs=1"
      ;;
    compaction_1m)
      echo "--rw=write --bs=1M --iodepth=4 --direct=0 --size=2G --numjobs=1"
      ;;
    mixed_64k_7030)
      echo "--rw=randrw --rwmixread=70 --bs=64k --iodepth=8 --direct=0 --size=2G --numjobs=1"
      ;;
    *) fail "unknown fio pattern: $1" ;;
  esac
}

fio_run() {
  local backend="$1" pattern="$2"
  local pod="fio-${pattern//_/-}-${backend//_/-}"
  pod="${pod//./-}"  # k8s name sanity
  local args
  args=$(fio_pattern_args "$pattern")

  log "fio: ${backend} / ${pattern}  (warmup=${FIO_WARMUP}s, runtime=${FIO_RUNTIME}s)"

  cat <<YAML | kubectl apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: ${pod}
  namespace: ${NS}
spec:
  restartPolicy: Never
  containers:
  - name: fio
    image: debian:bookworm-slim
    command: ["bash", "-c"]
    args:
    - |
      set -e
      apt-get update -qq >/dev/null
      apt-get install -y -qq fio >/dev/null
      cd /data
      fio --name=${pattern} \\
          --filename=/data/fio.test \\
          --ramp_time=${FIO_WARMUP} \\
          --runtime=${FIO_RUNTIME} \\
          --time_based \\
          --group_reporting \\
          --output-format=json \\
          --output=/tmp/fio.json \\
          ${args}
      cat /tmp/fio.json
      rm -f /data/fio.test
    volumeMounts:
    - name: data
      mountPath: /data
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: perf-${backend}
YAML

  # wait for pod to complete (max 10 min — apt install + warmup + runtime)
  local deadline=$(( $(date +%s) + 600 ))
  while :; do
    local phase
    phase=$(kubectl -n "$NS" get pod "$pod" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    case "$phase" in
      Succeeded) break ;;
      Failed)
        kubectl -n "$NS" logs "$pod" || true
        fail "fio pod $pod failed"
        ;;
    esac
    [[ $(date +%s) -gt $deadline ]] && {
      kubectl -n "$NS" logs "$pod" || true
      fail "fio pod $pod timed out after 10 min"
    }
    sleep 5
  done

  # extract the JSON (last block in logs)
  local outfile="${RESULTS_DIR}/${backend}__${pattern}.json"
  kubectl -n "$NS" logs "$pod" | awk '/^{/,/^}$/' > "$outfile"
  kubectl -n "$NS" delete pod "$pod" --wait=false >/dev/null 2>&1 || true

  # validate JSON parsed
  jq -e '.jobs[0]' "$outfile" >/dev/null || fail "fio output for ${backend}/${pattern} not parseable"
  log "fio: ${backend} / ${pattern} done → ${outfile}"
}

# ----- report ---------------------------------------------------------------
fmt_num() { LC_ALL=C printf '%.0f' "$1" 2>/dev/null || echo "$1"; }
fmt_lat_us() { LC_ALL=C printf '%.1f' "$(echo "$1 / 1000" | bc -l)" 2>/dev/null || echo "$1"; }

extract_metrics() {
  local file="$1" pattern="$2"
  case "$pattern" in
    wal_4k_fsync|compaction_1m)
      # write-side
      jq -r '.jobs[0].write | "\(.iops) \(.bw_bytes) \(.clat_ns.percentile."50.000000" // 0) \(.clat_ns.percentile."99.000000" // 0)"' "$file"
      ;;
    sst_4k_qd32)
      # read-side
      jq -r '.jobs[0].read | "\(.iops) \(.bw_bytes) \(.clat_ns.percentile."50.000000" // 0) \(.clat_ns.percentile."99.000000" // 0)"' "$file"
      ;;
    mixed_64k_7030)
      # both
      jq -r '.jobs[0] | "\(.read.iops) \(.read.bw_bytes) \(.write.iops) \(.write.bw_bytes) \(.read.clat_ns.percentile."99.000000" // 0) \(.write.clat_ns.percentile."99.000000" // 0)"' "$file"
      ;;
  esac
}

report() {
  log "report: generating $REPORT"
  {
    echo "# Stalwart Storage Performance — Single-Node Comparison"
    echo
    echo "**Cluster:** $(kubectl get nodes -o jsonpath='{.items[0].metadata.name}') (single-node, $(kubectl version -o json 2>/dev/null | jq -r '.serverVersion.gitVersion'))"
    echo "**Date:** $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "**fio warmup / runtime:** ${FIO_WARMUP}s / ${FIO_RUNTIME}s"
    echo "**PVC size:** ${PVC_SIZE}"
    echo
    echo "Both backends land on the same physical disk (\`/dev/sda1\`) — this"
    echo "isolates the **Longhorn engine + iSCSI overhead** from any disk-class"
    echo "difference. 3-replica sync cost is intentionally **not** measured."
    echo

    echo "## Phase 1 — fio floor"
    echo

    # Per-pattern tables
    for pattern in wal_4k_fsync sst_4k_qd32 compaction_1m mixed_64k_7030; do
      case "$pattern" in
        wal_4k_fsync)    echo "### P1.1 — 4k randwrite QD=1 fsync=1 (RocksDB WAL pattern)";;
        sst_4k_qd32)     echo "### P1.2 — 4k randread QD=32 direct=1 (RocksDB SST lookup)";;
        compaction_1m)   echo "### P1.3 — 1M seqwrite QD=4 (RocksDB compaction)";;
        mixed_64k_7030)  echo "### P1.4 — 64k randrw 70/30 QD=8 (mixed mail workload)";;
      esac
      echo

      if [[ "$pattern" == "mixed_64k_7030" ]]; then
        printf '| backend | read IOPS | read MB/s | write IOPS | write MB/s | read p99 µs | write p99 µs |\n'
        printf '|---|---:|---:|---:|---:|---:|---:|\n'
        for backend in local-path "$SC_LONGHORN"; do
          local f="${RESULTS_DIR}/${backend}__${pattern}.json"
          [[ -f "$f" ]] || { printf '| %s | n/a | n/a | n/a | n/a | n/a | n/a |\n' "$backend"; continue; }
          read -r r_iops r_bw w_iops w_bw r_p99 w_p99 <<< "$(extract_metrics "$f" "$pattern")"
          printf '| %s | %s | %.1f | %s | %.1f | %s | %s |\n' \
            "$backend" \
            "$(fmt_num "$r_iops")" "$(echo "$r_bw / 1048576" | bc -l)" \
            "$(fmt_num "$w_iops")" "$(echo "$w_bw / 1048576" | bc -l)" \
            "$(fmt_lat_us "$r_p99")" "$(fmt_lat_us "$w_p99")"
        done
      else
        printf '| backend | IOPS | MB/s | p50 µs | p99 µs |\n'
        printf '|---|---:|---:|---:|---:|\n'
        for backend in local-path "$SC_LONGHORN"; do
          local f="${RESULTS_DIR}/${backend}__${pattern}.json"
          [[ -f "$f" ]] || { printf '| %s | n/a | n/a | n/a | n/a |\n' "$backend"; continue; }
          read -r iops bw p50 p99 <<< "$(extract_metrics "$f" "$pattern")"
          printf '| %s | %s | %.1f | %s | %s |\n' \
            "$backend" \
            "$(fmt_num "$iops")" \
            "$(echo "$bw / 1048576" | bc -l)" \
            "$(fmt_lat_us "$p50")" \
            "$(fmt_lat_us "$p99")"
        done
      fi
      echo
    done

    echo "## Raw JSON"
    echo
    for f in "$RESULTS_DIR"/*.json; do
      [[ -f "$f" ]] || continue
      echo "- \`$(basename "$f")\`"
    done
    echo
    echo "## Notes"
    echo
    echo "- **P1.1 (WAL pattern)** is the dominant signal for RocksDB write"
    echo "  amplification. p99 latency drives mail-delivery latency under load."
    echo "- **P1.2 (SST lookup)** drives IMAP \`FETCH\` and JMAP \`Email/get\`"
    echo "  warm-cache miss latency."
    echo "- **P1.4 (mixed)** approximates a busy mail node: IMAP IDLE + SMTP"
    echo "  delivery interleaved. Throughput here is what users actually feel."
    echo "- Numbers are single-node, no replication. 3-replica Longhorn would"
    echo "  add another ~2-3× write latency on top of whatever P1.1 shows."
  } > "$REPORT"
  log "report: written to $REPORT"
  cat "$REPORT"
}

# ----- main -----------------------------------------------------------------
main() {
  trap cleanup EXIT
  for tool in kubectl jq bc; do
    command -v "$tool" >/dev/null || fail "missing tool: $tool"
  done

  setup

  log "PHASE 1 — fio floor (~16 min)"
  for backend in local-path "$SC_LONGHORN"; do
    for pattern in wal_4k_fsync sst_4k_qd32 compaction_1m mixed_64k_7030; do
      fio_run "$backend" "$pattern"
    done
  done

  if [[ "$PHASE" == "2" ]]; then
    log "PHASE 2 — Stalwart JMAP end-to-end NOT YET IMPLEMENTED (would gate on phase 1 results)"
  fi

  report
}

main "$@"
