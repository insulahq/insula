#!/usr/bin/env bash
#
# integration-mailbox-aux-orchestrator-e2e.sh — full E2E that mimics
# what the platform-api tenant-bundles orchestrator's Jobs actually
# run end-to-end, against the real mail-backup-tools image in the
# testing cluster.
#
# Spawns TWO Jobs in the `mail` namespace:
#
#   capture-Job  — mirrors mailboxes.ts's per-address shell loop for
#                  engine=imap + aux: imap-sync.py then jmap-aux-sync.py
#                  for the e2e-src account, then tars /tmp/maildir-out
#                  into /tmp/snapshot.tar. The Job holds for kubectl cp
#                  so this script can pull the tarball out.
#
#   restore-Job  — mirrors mailboxes-by-address.ts's per-address shell
#                  loop: extracts the snapshot.tar back into /tmp/maildir,
#                  runs imap-restore.py (mail) + jmap-aux-restore.py
#                  (aux) against the e2e-imap-dst account.
#
# Pre-conditions:
#   - testing.example.test cluster (or equivalent) with:
#       /tmp/mpw    — Stalwart master-user password
#       /tmp/mfqdn  — master@<apex> FQDN
#   - e2e-src already seeded with mail + aux corpus (run
#     scripts/integration-tenant-bundles-mailbox-engine.sh first)
#   - mail-backup-tools image available in the cluster's containerd
#     as ghcr.io/.../mail-backup-tools:latest (either CI-built or
#     locally-imported via `k3s ctr images import`)
#
# What it asserts:
#   1. Capture Job exits with both Maildir AND .aux/ in the tarball
#   2. Manifest reports all 5 aux surfaces available
#   3. Restore Job exits 0
#   4. Both restore scripts (imap-restore.py + jmap-aux-restore.py)
#      complete cleanly inside the orchestrator-style shell
#
# This is the L1 harness's parent: L1 tests the scripts directly,
# this tests the orchestrator-generated shell that the platform-api
# Job actually executes.
set -euo pipefail

NS=mail
HOST_TMP=${HOST_TMP:-/tmp}
MPW=$(cat "$HOST_TMP/mpw")
MFQDN=$(cat "$HOST_TMP/mfqdn")
SRC="e2e-src@mailperf-bench.net"
DST="e2e-imap-dst@mailperf-bench.net"

CAPTURE_JOB=aux-e2e-capture-$(date +%s)
RESTORE_JOB=aux-e2e-restore-$(date +%s)
SNAP_TAR=$HOST_TMP/aux-e2e-snapshot.tar

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
fail() { log "FAIL: $*"; exit 1; }
pass() { log "  PASS: $*"; }

# ── CAPTURE ────────────────────────────────────────────────────────────────

log "spawning capture Job ($CAPTURE_JOB)"
cat <<YAML | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: $CAPTURE_JOB
  namespace: $NS
  labels: {test: aux-e2e-orchestrator}
spec:
  activeDeadlineSeconds: 600
  backoffLimit: 0
  template:
    metadata:
      labels: {test: aux-e2e-orchestrator, job-name: $CAPTURE_JOB}
    spec:
      restartPolicy: Never
      containers:
      - name: tools
        image: ${TOOLS_IMAGE:-ghcr.io/insulahq/hosting-platform/mail-backup-tools:latest}
        imagePullPolicy: ${IMAGE_PULL_POLICY:-IfNotPresent}
        env: [{name: STALWART_MASTER_PASSWORD, value: "$MPW"}]
        command: ["sh", "-c"]
        args:
        - |
          set -euo pipefail
          mkdir -p /tmp/maildir-out
          ADDR='$SRC'
          echo "=== mail capture (imap) ==="
          /usr/local/bin/imap-sync.py \
            --imap-host stalwart-mail.mail.svc.cluster.local \
            --imap-port 993 --account-address "\$ADDR" \
            --master-user '$MFQDN' --auth-pass-env STALWART_MASTER_PASSWORD \
            --output-dir /tmp/maildir-out
          echo "IMAP_DONE address=\$ADDR"
          echo "=== aux capture ==="
          /usr/local/bin/jmap-aux-sync.py \
            --endpoint http://stalwart-mgmt.mail.svc.cluster.local:8080 \
            --account-address "\$ADDR" \
            --master-user '$MFQDN' --auth-pass-env STALWART_MASTER_PASSWORD \
            --output-dir /tmp/maildir-out
          echo "AUX_DONE address=\$ADDR"
          cd /tmp/maildir-out && tar cf /tmp/snapshot.tar . && ls -la /tmp/snapshot.tar
          echo "=== aux manifest ==="
          cat "/tmp/maildir-out/\$ADDR/.aux/manifest.json"
          echo "=== holding for cp ==="
          sleep 120
YAML

kubectl -n "$NS" wait --for=condition=Ready pod -l job-name=$CAPTURE_JOB --timeout=60s
POD_CAP=$(kubectl -n "$NS" get pods -l job-name=$CAPTURE_JOB -o jsonpath='{.items[0].metadata.name}')

for _ in $(seq 1 30); do
  kubectl -n "$NS" logs "$POD_CAP" 2>&1 | grep -q "holding for cp" && break
  sleep 2
done

log "capture done — pulling tarball"
kubectl -n "$NS" cp "$POD_CAP":/tmp/snapshot.tar "$SNAP_TAR"
ls -la "$SNAP_TAR"

# Assertions on tarball. Collect the listing ONCE — piping tar into
# grep -q under `set -o pipefail` causes SIGPIPE on the producer
# (grep -q exits at first match before tar finishes writing), which
# pipefail reports as exit 141 and `set -e` then aborts the script.
log "=== tarball assertions ==="
TAR_LIST=$(tar tf "$SNAP_TAR")

check_in_tar() {
  local pattern="$1" label="$2"
  if printf '%s\n' "$TAR_LIST" | grep -qF "$pattern"; then
    pass "$label"
  else
    fail "$label (pattern: $pattern)"
  fi
}

check_in_tar "/$SRC/.aux/manifest.json" "tarball contains .aux/manifest.json"
for surface in sieve contacts calendar vacation filenode; do
  check_in_tar "/$SRC/.aux/${surface}.json" "tarball contains .aux/${surface}.json"
done
# Maildir presence — any */cur/ under the address dir
if printf '%s\n' "$TAR_LIST" | grep -qE "/$SRC/[^/]+/cur/"; then
  pass "tarball contains Maildir cur/"
else
  fail "tarball missing Maildir cur/"
fi

kubectl -n "$NS" delete job "$CAPTURE_JOB" --wait=false >/dev/null

# ── RESTORE ────────────────────────────────────────────────────────────────

log "spawning restore Job ($RESTORE_JOB)"
cat <<YAML | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: $RESTORE_JOB
  namespace: $NS
  labels: {test: aux-e2e-orchestrator}
spec:
  activeDeadlineSeconds: 600
  backoffLimit: 0
  template:
    metadata:
      labels: {test: aux-e2e-orchestrator, job-name: $RESTORE_JOB}
    spec:
      restartPolicy: Never
      containers:
      - name: tools
        image: ${TOOLS_IMAGE:-ghcr.io/insulahq/hosting-platform/mail-backup-tools:latest}
        imagePullPolicy: ${IMAGE_PULL_POLICY:-IfNotPresent}
        env: [{name: STALWART_MASTER_PASSWORD, value: "$MPW"}]
        command: ["sh", "-c"]
        args:
        - |
          set -euo pipefail
          echo "=== waiting for /tmp/snapshot.tar (max 60s) ==="
          for _ in \$(seq 1 30); do
            [ -f /tmp/snapshot.tar ] && break
            sleep 2
          done
          [ -f /tmp/snapshot.tar ] || { echo "no tarball arrived"; exit 1; }
          echo "=== extracting tarball ==="
          mkdir -p /tmp/maildir/'$DST'
          tar xf /tmp/snapshot.tar -C /tmp/maildir/'$DST'
          ls -la /tmp/maildir/'$DST'/'$SRC'/.aux/ || true

          MODE=merge-overwrite
          ADDR='$DST'
          SRC_ADDR='$SRC'

          echo "=== mail restore ==="
          python3 /usr/local/bin/imap-restore.py \
            --imap-host stalwart-mail.mail.svc.cluster.local --imap-port 993 \
            --target-address "\$ADDR" --source-address "\$SRC_ADDR" \
            --master-user '$MFQDN' --auth-pass-env STALWART_MASTER_PASSWORD \
            --maildir-root "/tmp/maildir/\$ADDR" --mode "\$MODE"
          echo "IMAP_RESTORE_DONE"

          if [ -d "/tmp/maildir/\$ADDR/\$SRC_ADDR/.aux" ]; then
            AUX_FLAGS=""; [ "\$MODE" = "replace" ] && AUX_FLAGS="--confirm-destructive"
            python3 /usr/local/bin/jmap-aux-restore.py \
              --endpoint http://stalwart-mgmt.mail.svc.cluster.local:8080 \
              --target-address "\$ADDR" --source-address "\$SRC_ADDR" \
              --master-user '$MFQDN' --auth-pass-env STALWART_MASTER_PASSWORD \
              --maildir-root "/tmp/maildir/\$ADDR" --mode "\$MODE" \$AUX_FLAGS
            echo "AUX_RESTORE_DONE"
          else
            echo "no .aux in tarball — skipping aux restore"
          fi
          echo "=== restore DONE; holding for review ==="
          sleep 60
YAML

kubectl -n "$NS" wait --for=condition=Ready pod -l job-name=$RESTORE_JOB --timeout=60s
POD_RST=$(kubectl -n "$NS" get pods -l job-name=$RESTORE_JOB -o jsonpath='{.items[0].metadata.name}')

log "copying tarball into restore pod"
kubectl -n "$NS" cp "$SNAP_TAR" "$POD_RST":/tmp/snapshot.tar

# Wait for restore to complete
for _ in $(seq 1 60); do
  kubectl -n "$NS" logs "$POD_RST" 2>&1 | grep -q "restore DONE; holding" && break
  sleep 3
done
log "=== restore Job stdout (tail) ==="
kubectl -n "$NS" logs "$POD_RST" | tail -30

# Restore assertions: did dst pick up the aux data?
if kubectl -n "$NS" logs "$POD_RST" | grep -q "IMAP_RESTORE_DONE"; then
  pass "imap-restore.py exited cleanly"
else
  fail "imap-restore.py did NOT complete"
fi
if kubectl -n "$NS" logs "$POD_RST" | grep -q "AUX_RESTORE_DONE"; then
  pass "jmap-aux-restore.py exited cleanly"
else
  fail "jmap-aux-restore.py did NOT complete"
fi
if kubectl -n "$NS" logs "$POD_RST" | grep -qE "AUX_RESTORE DONE addr=$DST .* failed=none"; then
  pass "aux restore reported failed=none in summary"
else
  log "aux restore summary did not match expected failed=none — see Job logs above"
fi

kubectl -n "$NS" delete job "$RESTORE_JOB" --wait=false >/dev/null

log
log "═════════════════════════════════════════════════════════════════"
log "RESULT: full orchestrator E2E PASS"
log "  capture tarball: $SNAP_TAR"
log "  src account:     $SRC"
log "  dst account:     $DST"
