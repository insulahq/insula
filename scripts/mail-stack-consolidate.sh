#!/usr/bin/env bash
# mail-stack-consolidate.sh — one-time operator script that migrates
# legacy two-PVC mail layout (stalwart-rocksdb-data local-path +
# bulwark-data Longhorn RWO) into the consolidated `mail-stack-data`
# local-path PVC with subPaths.
#
# Stage 1 of the A2 → A2.5 sequence:
#   - A2 ships this script + the empty mail-stack-data PVC manifest.
#   - Operator runs this script on the cluster being upgraded.
#   - A2.5 ships the Deployment manifest changes that switch the mounts
#     to mail-stack-data. By then the data is already there.
#
# Idempotent: if the new PVC already has the sentinel file
# `.mail-stack-consolidated-at`, the script exits 0 with no changes.
# Safe to re-run.
#
# Destructive ops:
#   - Scales stalwart-mail + bulwark Deployments to 0 (mail goes down
#     for the duration — typically 30-60s for the copy).
#   - Mounts both legacy PVCs RO and the new PVC RW in a one-shot Pod.
#   - Scales back to 1.
#   - DOES NOT delete the legacy PVCs — operator does that manually
#     after sanity-checking the new layout in the A2.5 cutover.
#
# Pre-flight:
#   - mailActiveNode is set in system_settings (script reads it via
#     platform-api admin endpoint OR direct DB query if no API
#     access).
#   - Both legacy PVCs exist (stalwart-rocksdb-data, bulwark-data).
#   - mail-stack-data PVC exists (provisioned but possibly Pending
#     until first consumer).
#   - kubectl context points at the target cluster.
#
# Usage:
#   ./scripts/mail-stack-consolidate.sh                     # auto-detect active node, dry-run preview
#   ./scripts/mail-stack-consolidate.sh --apply             # apply the migration
#   ./scripts/mail-stack-consolidate.sh --apply --node X    # explicit node override

set -euo pipefail

NS="mail"
LEGACY_STALWART_PVC="stalwart-rocksdb-data"
LEGACY_BULWARK_PVC="bulwark-data"
NEW_PVC="mail-stack-data"
SENTINEL=".mail-stack-consolidated-at"
DATA_MOVER_POD="mail-stack-data-mover"
DATA_MOVER_IMAGE="alpine:3.20"

APPLY=0
NODE_OVERRIDE=""
TIMEOUT_SECONDS=300

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)        APPLY=1; shift;;
    --node)         NODE_OVERRIDE="$2"; shift 2;;
    --timeout)      TIMEOUT_SECONDS="$2"; shift 2;;
    -h|--help)
      sed -n 's/^# \?//p' "$0" | head -40
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 2;;
  esac
done

log() { printf '[%s] %s\n' "$(date -Iseconds)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

# ─── Pre-flight ──────────────────────────────────────────────────────
log "Pre-flight checks (apply=${APPLY})"
kubectl get ns "${NS}" >/dev/null 2>&1 || die "namespace ${NS} not found"
kubectl get pvc "${LEGACY_STALWART_PVC}" -n "${NS}" >/dev/null 2>&1 || die "legacy stalwart PVC ${LEGACY_STALWART_PVC} not found"
kubectl get pvc "${LEGACY_BULWARK_PVC}" -n "${NS}" >/dev/null 2>&1 || die "legacy bulwark PVC ${LEGACY_BULWARK_PVC} not found"
kubectl get pvc "${NEW_PVC}" -n "${NS}" >/dev/null 2>&1 || die "new PVC ${NEW_PVC} not found — apply A2 manifests first (pvc-mail-stack.yaml)"

# Active mail node
if [[ -n "${NODE_OVERRIDE}" ]]; then
  ACTIVE_NODE="${NODE_OVERRIDE}"
else
  # Use the node where Stalwart's pod currently runs.
  ACTIVE_NODE=$(kubectl get pod -n "${NS}" -l app=stalwart-mail -o jsonpath='{.items[0].spec.nodeName}' 2>/dev/null || true)
  [[ -n "${ACTIVE_NODE}" ]] || die "could not detect mailActiveNode (no stalwart-mail pod); pass --node X"
fi
log "Active mail node: ${ACTIVE_NODE}"

# Pre-flight: ensure no HorizontalPodAutoscaler will scale us back up
# mid-cutover (would race with the data-mover Pod's RWO mount claim).
for d in stalwart-mail bulwark; do
  if kubectl get hpa -n "${NS}" -o jsonpath="{.items[?(@.spec.scaleTargetRef.name=='${d}')].metadata.name}" 2>/dev/null | grep -q .; then
    die "HPA targets Deployment ${d} — disable it before running this script (would re-scale to >0 mid-cutover)"
  fi
done

# Pre-flight: available disk space on the active node. Stalwart legacy
# was 20Gi; the copy phase has source AND dest live simultaneously so
# peak space need = current Stalwart usage * 2. Add 5Gi headroom.
log "Pre-flight: node disk space check (informational, not blocking)"
kubectl get nodes "${ACTIVE_NODE}" -o jsonpath='{.status.allocatable.ephemeral-storage}{"\n"}' || true

# Idempotency check: read the sentinel file from the new PVC by
# spawning a tiny inspector Pod. If sentinel exists, exit 0.
log "Checking idempotency sentinel on ${NEW_PVC}..."
# Use nanoseconds in suffix to survive rapid re-runs within the same
# second. `date +%s%N` is GNU date; portable fallback via $RANDOM.
SUFFIX="$(date +%s)-${RANDOM}${RANDOM}"
INSPECTOR_POD="mail-stack-data-inspector-${SUFFIX}"
# Use --overrides exclusively (no trailing --command args) — when both
# are set, kubectl's behaviour is version-dependent and the trailing
# args can silently overwrite the JSON `command` field. The container
# command is fully specified inside the JSON overrides.
kubectl run "${INSPECTOR_POD}" -n "${NS}" --restart=Never --image="${DATA_MOVER_IMAGE}" \
  --overrides="{
    \"apiVersion\":\"v1\",
    \"spec\":{
      \"nodeSelector\":{\"kubernetes.io/hostname\":\"${ACTIVE_NODE}\"},
      \"restartPolicy\":\"Never\",
      \"containers\":[{
        \"name\":\"inspect\",
        \"image\":\"${DATA_MOVER_IMAGE}\",
        \"command\":[\"sh\",\"-c\",\"ls -la /dst/${SENTINEL} 2>/dev/null && echo SENTINEL_EXISTS || echo SENTINEL_MISSING\"],
        \"volumeMounts\":[{\"name\":\"dst\",\"mountPath\":\"/dst\"}]
      }],
      \"volumes\":[{\"name\":\"dst\",\"persistentVolumeClaim\":{\"claimName\":\"${NEW_PVC}\"}}]
    }
  }" >/dev/null
# Wait for the Pod to reach a terminal phase. Ready=False is unreliable
# for one-shot pods (a fast-completing Pod may never become Ready=True
# at all, so Ready=False fires during Pending before the inspect runs).
# Poll the phase directly.
inspect_deadline=$(( $(date +%s) + 60 ))
while [ "$(date +%s)" -lt "${inspect_deadline}" ]; do
  phase=$(kubectl get pod "${INSPECTOR_POD}" -n "${NS}" -o jsonpath='{.status.phase}' 2>/dev/null || echo Pending)
  case "${phase}" in
    Succeeded|Failed) break;;
    *) sleep 2;;
  esac
done
INSPECT_OUT=$(kubectl logs "${INSPECTOR_POD}" -n "${NS}" 2>/dev/null || echo "SENTINEL_MISSING")
kubectl delete pod "${INSPECTOR_POD}" -n "${NS}" --wait=false >/dev/null 2>&1 || true
if grep -q SENTINEL_EXISTS <<<"${INSPECT_OUT}"; then
  log "Sentinel ${SENTINEL} present on ${NEW_PVC} — already consolidated. Nothing to do."
  exit 0
fi
log "Sentinel absent — proceeding with consolidation."

if [[ "${APPLY}" -ne 1 ]]; then
  cat <<EOF

DRY-RUN preview (no changes made). Re-run with --apply to execute.

The script will:
  1. Trigger a fresh stalwart-snapshot (CronJob 'stalwart-snapshot' Job).
  2. Scale stalwart-mail + bulwark Deployments to 0 (mail down ~30-60s).
  3. Wait for pods to terminate (PVCs released).
  4. Spawn one-shot ${DATA_MOVER_POD} Pod on ${ACTIVE_NODE}:
       - Mounts ${LEGACY_STALWART_PVC} at /src/stalwart (RO)
       - Mounts ${LEGACY_BULWARK_PVC}  at /src/bulwark  (RO)
       - Mounts ${NEW_PVC}             at /dst          (RW)
       - cp -a /src/stalwart/.  /dst/stalwart/
       - cp -a /src/bulwark/.   /dst/bulwark/
       - touch /dst/${SENTINEL}
  5. Verify sentinel + file counts.
  6. Scale stalwart-mail + bulwark back to 1.

LEGACY PVCs will NOT be deleted. A2.5 commit will switch Deployments
to mount ${NEW_PVC} with subPaths; after operator verifies mail works
end-to-end the legacy PVCs can be deleted with:
  kubectl delete pvc ${LEGACY_STALWART_PVC} ${LEGACY_BULWARK_PVC} -n ${NS}

EOF
  exit 0
fi

# ─── Apply path ─────────────────────────────────────────────────────
log "Stage 1: trigger fresh snapshot"
kubectl create job --from=cronjob/stalwart-snapshot "stalwart-snapshot-preconsolidate-$(date +%s)" -n "${NS}" || true

log "Stage 2: scale stalwart-mail + bulwark to 0"
kubectl scale deploy stalwart-mail bulwark -n "${NS}" --replicas=0
# Verify spec.replicas actually persisted to 0 (defends against an
# external operator concurrently scaling back up — kubectl wait below
# would still return success on pods that get re-created with 0 mid-wait).
for d in stalwart-mail bulwark; do
  r=$(kubectl get deploy "${d}" -n "${NS}" -o jsonpath='{.spec.replicas}')
  [[ "${r}" = "0" ]] || die "Deployment ${d} spec.replicas=${r} after scale (expected 0); aborting before data-mover Pod claims the RWO PVCs"
done
kubectl wait --for=delete pod -n "${NS}" -l app=stalwart-mail --timeout="${TIMEOUT_SECONDS}s" || true
kubectl wait --for=delete pod -n "${NS}" -l app=bulwark        --timeout="${TIMEOUT_SECONDS}s" || true
log "Both Deployments scaled to 0."

log "Stage 3: spawn data-mover Pod on ${ACTIVE_NODE}"
kubectl delete pod "${DATA_MOVER_POD}" -n "${NS}" --ignore-not-found --wait=true || true
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: ${DATA_MOVER_POD}
  namespace: ${NS}
  labels:
    app.kubernetes.io/part-of: hosting-platform
    app.kubernetes.io/component: mail-stack-consolidation
spec:
  restartPolicy: Never
  nodeSelector:
    kubernetes.io/hostname: ${ACTIVE_NODE}
  containers:
    - name: mover
      image: ${DATA_MOVER_IMAGE}
      command: ["sh", "-c"]
      args:
        - |
          set -e
          mkdir -p /dst/stalwart /dst/bulwark
          echo "[mover] copy stalwart subtree..."
          cp -a /src/stalwart/. /dst/stalwart/
          echo "[mover] copy bulwark subtree..."
          cp -a /src/bulwark/. /dst/bulwark/
          echo "[mover] verify counts..."
          # Exclude lost+found on both sides — the ext4 root creates
          # this dir on every PVC volume. The source dir won't have
          # one (it's *inside* the legacy PVC at the same depth), but
          # the dst /dst/stalwart subdir gets one if we accidentally
          # copy it. Safe to exclude unconditionally on both sides.
          src_stalwart=\$(find /src/stalwart -type f -not -path '*/lost+found/*' | wc -l)
          dst_stalwart=\$(find /dst/stalwart -type f -not -path '*/lost+found/*' | wc -l)
          src_bulwark=\$(find /src/bulwark -type f -not -path '*/lost+found/*' | wc -l)
          dst_bulwark=\$(find /dst/bulwark -type f -not -path '*/lost+found/*' | wc -l)
          echo "[mover] stalwart files: src=\$src_stalwart dst=\$dst_stalwart"
          echo "[mover] bulwark  files: src=\$src_bulwark dst=\$dst_bulwark"
          [ "\$src_stalwart" = "\$dst_stalwart" ] || { echo "[mover] stalwart file count mismatch"; exit 1; }
          [ "\$src_bulwark" = "\$dst_bulwark" ] || { echo "[mover] bulwark file count mismatch"; exit 1; }
          date -Iseconds > /dst/${SENTINEL}
          echo "[mover] OK — sentinel written"
      volumeMounts:
        - name: src-stalwart
          mountPath: /src/stalwart
          readOnly: true
        - name: src-bulwark
          mountPath: /src/bulwark
          readOnly: true
        - name: dst
          mountPath: /dst
  volumes:
    - name: src-stalwart
      persistentVolumeClaim:
        claimName: ${LEGACY_STALWART_PVC}
        readOnly: true
    - name: src-bulwark
      persistentVolumeClaim:
        claimName: ${LEGACY_BULWARK_PVC}
        readOnly: true
    - name: dst
      persistentVolumeClaim:
        claimName: ${NEW_PVC}
EOF

log "Waiting for data-mover Pod completion (timeout ${TIMEOUT_SECONDS}s)..."
# Poll Pod phase directly. Ready=False is unreliable for one-shot
# Pods (a fast-completing Pod may never become Ready=True so the
# Ready=False edge can fire during Pending before any copy happens).
deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
phase=Pending
while [ "$(date +%s)" -lt "${deadline}" ]; do
  phase=$(kubectl get pod "${DATA_MOVER_POD}" -n "${NS}" -o jsonpath='{.status.phase}' 2>/dev/null || echo Pending)
  case "${phase}" in
    Succeeded) break;;
    Failed)
      log "ERROR: data-mover Pod failed — dumping logs:"
      kubectl logs "${DATA_MOVER_POD}" -n "${NS}" || true
      die "consolidation failed"
      ;;
    *) sleep 5;;
  esac
done
if [ "${phase}" != "Succeeded" ]; then
  log "ERROR: data-mover Pod did not reach Succeeded in ${TIMEOUT_SECONDS}s (last phase=${phase})"
  kubectl logs "${DATA_MOVER_POD}" -n "${NS}" || true
  die "consolidation timeout"
fi

log "Data-mover logs:"
kubectl logs "${DATA_MOVER_POD}" -n "${NS}" || true

log "Stage 4: scale stalwart-mail + bulwark back to 1"
kubectl scale deploy stalwart-mail bulwark -n "${NS}" --replicas=1

log "Stage 5: cleanup data-mover Pod"
kubectl delete pod "${DATA_MOVER_POD}" -n "${NS}" --wait=false || true

log "SUCCESS. Consolidation sentinel written to ${NEW_PVC}/${SENTINEL}."
log ""
log "NEXT STEPS:"
log "  1. Wait for A2.5 commit to land on main → Flux reconciles."
log "  2. A2.5 will switch Stalwart + Bulwark Deployments to mount ${NEW_PVC} via subPaths."
log "  3. New pods will see the data already in place (no restore-from-snapshot needed)."
log "  4. After verifying mail works end-to-end, delete legacy PVCs:"
log "       kubectl delete pvc ${LEGACY_STALWART_PVC} ${LEGACY_BULWARK_PVC} -n ${NS}"
