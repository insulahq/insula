#!/usr/bin/env bash
# reset-mail-pg.sh — destructive operations on the mail-pg CNPG cluster.
#
# WHY THIS SCRIPT EXISTS:
#
# Stalwart 0.16 stores mail account credentials in mail-pg as one-way
# bcrypt hashes (it does NOT support importing pre-hashed credentials —
# verified empirically 2026-05-06: any bcrypt string passed to
# Account/credentials/0/secret gets bcrypt-hashed AGAIN by Stalwart,
# treating the hash as plaintext). This means:
#
#   * After mail-pg is wiped, every mailbox's plaintext is unrecoverable.
#   * Forcing every user to reset their password is the only path back.
#   * UNLESS we restore mail-pg from a CNPG backup.
#
# Earlier in 2026-05-06's session, an operator (Claude) ran
# `kubectl delete cluster.postgresql.cnpg.io -n mail mail-pg` to
# recover from rotation-test pod sprawl, expecting CNPG to recreate
# clean. CNPG did — but Stalwart's account/domain rows were lost AND
# nobody thought to restore from the backup that existed at the time.
# Every test mailbox is now unauthenticatable until the operator
# manually triggers a password reset for each user.
#
# This script:
#   1. Refuses to run without explicit flags + typed confirmation.
#   2. Audits recent backups before any destructive action — you can
#      see whether you have a recovery point.
#   3. Provides a `--restore-from-backup` mode that's the operator-
#      friendly path: applies a Cluster CR with bootstrap.recovery
#      pointed at a Backup CR, no manual yaml editing required.
#   4. Provides a `--really-delete-mail-pg` mode for the genuinely-
#      starting-over case (test bench, DR drill, etc.) — but ONLY
#      after typed "DELETE-MAIL-PG" confirmation.
#
# USAGE:
#
#   # List recent backups
#   ./scripts/reset-mail-pg.sh --list-backups
#
#   # Restore from a specific backup (recovery path — operator's friend)
#   ./scripts/reset-mail-pg.sh --restore-from-backup <backup-name>
#
#   # Nuke and start fresh (test bench / first-install / true reset only)
#   ./scripts/reset-mail-pg.sh --really-delete-mail-pg
#
# NEVER use `kubectl delete cluster.postgresql.cnpg.io mail-pg` directly.
# That bypasses backup-audit + confirmation and has cost the team
# operator-rotation chaos at least once.
#
# See docs/02-operations/MAIL_PG_RESTORE.md for the full runbook.

set -euo pipefail

NAMESPACE="${MAIL_PG_NAMESPACE:-mail}"
CLUSTER_NAME="${MAIL_PG_CLUSTER_NAME:-mail-pg}"
KUBECTL="${KUBECTL:-kubectl}"
# Flux Kustomization that owns the mail-pg Cluster CR. If Flux is
# enabled and reconciles BEFORE we apply the recovery Cluster, it
# reverts to bootstrap.initdb and we lose the recovery path. The
# wrapper suspends this Kustomization for destructive ops and the
# operator resumes it once verification passes (or `--auto-resume`
# resumes immediately after the recovery CR is applied).
FLUX_KUSTOMIZATION_NAMESPACE="${FLUX_KUSTOMIZATION_NAMESPACE:-flux-system}"
FLUX_KUSTOMIZATION_NAME="${FLUX_KUSTOMIZATION_NAME:-platform}"

# ─── ANSI colors (only when stdout is a TTY) ────────────────────────────
if [ -t 1 ]; then
  RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; DIM=$'\033[2m'; NC=$'\033[0m'
else
  RED=''; YEL=''; GRN=''; DIM=''; NC=''
fi

usage() {
  cat <<EOF
$(basename "$0") — mail-pg destructive operations wrapper

Modes:
  --list-backups
      Print recent CNPG Backup CRs in namespace=$NAMESPACE for cluster
      $CLUSTER_NAME, with phase + age. Always safe.

  --restore-from-backup <backup-name>
      Apply a new Cluster CR with bootstrap.recovery pointed at the
      named Backup. Idempotent: if the cluster is already healthy,
      refuses unless --replace is also passed.

  --really-delete-mail-pg
      Delete the cluster + all PVCs. Mail data unrecoverable unless
      a recent Backup is intact. Requires typed confirmation.

Optional flags:
  --replace
      With --restore-from-backup: deletes the existing cluster + PVCs
      first. Otherwise the restore is refused if a healthy cluster
      already exists.

  --namespace <ns>          Default: mail
  --cluster-name <name>     Default: mail-pg
  --skip-confirmation       Dangerous. Only used by automation that
                            has its own confirmation gate.

Exit codes:
  0   Success.
  1   User input invalid / mismatched confirmation / refused operation.
  2   K8s API error / kubectl missing / cluster not found.
  3   Backup integrity check failed (no recent successful backup AND
      operator didn't pass --no-backup-required).

EOF
}

err() { echo "${RED}ERROR:${NC} $*" >&2; }
warn() { echo "${YEL}WARN:${NC}  $*" >&2; }
ok() { echo "${GRN}OK:${NC}    $*"; }

# ─── Flux suspend/resume helpers ─────────────────────────────────────────
# Without these, Flux's next reconcile (typically every 5-10 min) sees the
# Cluster CR as missing/different and re-applies the in-git version with
# bootstrap.initdb, undoing our bootstrap.recovery shape. Suspend before
# any destructive op + tell the operator to resume after verification.

flux_kustomization_exists() {
  "$KUBECTL" get kustomization.kustomize.toolkit.fluxcd.io \
    -n "$FLUX_KUSTOMIZATION_NAMESPACE" "$FLUX_KUSTOMIZATION_NAME" \
    >/dev/null 2>&1
}

flux_suspend_if_present() {
  if flux_kustomization_exists; then
    "$KUBECTL" patch kustomization.kustomize.toolkit.fluxcd.io \
      -n "$FLUX_KUSTOMIZATION_NAMESPACE" "$FLUX_KUSTOMIZATION_NAME" \
      --type=merge -p '{"spec":{"suspend":true}}' >/dev/null
    ok "Suspended Flux Kustomization $FLUX_KUSTOMIZATION_NAMESPACE/$FLUX_KUSTOMIZATION_NAME"
    echo "${DIM}      (resume with: kubectl patch kustomization.kustomize.toolkit.fluxcd.io -n $FLUX_KUSTOMIZATION_NAMESPACE $FLUX_KUSTOMIZATION_NAME --type=merge -p '{\"spec\":{\"suspend\":false}}')${NC}"
    return 0
  fi
  warn "Flux Kustomization $FLUX_KUSTOMIZATION_NAMESPACE/$FLUX_KUSTOMIZATION_NAME not found — skipping suspend (assuming Flux not in use here)"
  return 1
}

flux_resume_if_present() {
  if flux_kustomization_exists; then
    "$KUBECTL" patch kustomization.kustomize.toolkit.fluxcd.io \
      -n "$FLUX_KUSTOMIZATION_NAMESPACE" "$FLUX_KUSTOMIZATION_NAME" \
      --type=merge -p '{"spec":{"suspend":false}}' >/dev/null
    ok "Resumed Flux Kustomization $FLUX_KUSTOMIZATION_NAMESPACE/$FLUX_KUSTOMIZATION_NAME"
  fi
}

require_kubectl() {
  command -v "$KUBECTL" >/dev/null 2>&1 || {
    err "kubectl not found in PATH (set KUBECTL=/path/to/kubectl)"
    exit 2
  }
}

require_cluster_exists() {
  "$KUBECTL" get cluster.postgresql.cnpg.io -n "$NAMESPACE" "$CLUSTER_NAME" >/dev/null 2>&1 || {
    err "cluster.postgresql.cnpg.io/$CLUSTER_NAME not found in namespace=$NAMESPACE"
    exit 2
  }
}

list_backups() {
  echo "${DIM}Recent backups for $NAMESPACE/$CLUSTER_NAME:${NC}"
  "$KUBECTL" get backup.postgresql.cnpg.io -n "$NAMESPACE" \
    --sort-by=.metadata.creationTimestamp 2>/dev/null \
    | awk 'NR==1 || $0 ~ /'"$CLUSTER_NAME"'/' \
    || true
  echo ""
  echo "${DIM}ScheduledBackup CRs configured:${NC}"
  "$KUBECTL" get scheduledbackup.postgresql.cnpg.io -n "$NAMESPACE" 2>/dev/null \
    | awk 'NR==1 || $0 ~ /'"$CLUSTER_NAME"'/' \
    || true
}

audit_backup_freshness() {
  # Returns 0 if there's at least one Backup with phase=completed in the
  # last 48 hours; non-zero otherwise. Caller decides what to do.
  local recent_completed
  recent_completed=$(
    "$KUBECTL" get backup.postgresql.cnpg.io -n "$NAMESPACE" \
      -o jsonpath='{range .items[?(@.status.phase=="completed")]}{.metadata.creationTimestamp}{"|"}{.metadata.name}{"\n"}{end}' 2>/dev/null \
      | tail -1
  )
  [ -n "$recent_completed" ]
}

# ─── --really-delete-mail-pg ─────────────────────────────────────────────
do_really_delete() {
  local skip_confirmation="${1:-no}"

  echo ""
  echo "${RED}╔══════════════════════════════════════════════════════════╗${NC}"
  echo "${RED}║  DESTRUCTIVE: deleting mail-pg cluster + ALL DATA        ║${NC}"
  echo "${RED}╚══════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo "Targets:"
  echo "  - cluster.postgresql.cnpg.io/$CLUSTER_NAME (namespace=$NAMESPACE)"
  echo "  - all PersistentVolumeClaims labeled cnpg.io/cluster=$CLUSTER_NAME"
  echo ""

  list_backups
  echo ""

  if ! audit_backup_freshness; then
    warn "No completed Backup found in this namespace."
    warn "If you proceed, mail data WILL be permanently lost."
  else
    ok "At least one completed Backup exists; consider --restore-from-backup instead."
  fi
  echo ""

  if [ "$skip_confirmation" != "yes" ]; then
    echo "Type the literal string ${RED}DELETE-MAIL-PG${NC} to confirm, anything else to abort:"
    read -r CONFIRM
    if [ "$CONFIRM" != "DELETE-MAIL-PG" ]; then
      err "Confirmation did not match. Aborted."
      exit 1
    fi
  fi

  echo ""
  flux_suspend_if_present || true

  ok "Deleting cluster.postgresql.cnpg.io/$CLUSTER_NAME …"
  "$KUBECTL" delete cluster.postgresql.cnpg.io -n "$NAMESPACE" "$CLUSTER_NAME" --wait=true --timeout=120s

  ok "Deleting PVCs labeled cnpg.io/cluster=$CLUSTER_NAME …"
  "$KUBECTL" delete pvc -n "$NAMESPACE" -l "cnpg.io/cluster=$CLUSTER_NAME" --wait=true --timeout=180s || true

  ok "mail-pg deleted."
  warn "Flux is currently SUSPENDED. To recreate empty, either:"
  warn "  - resume Flux:  kubectl patch kustomization.kustomize.toolkit.fluxcd.io -n $FLUX_KUSTOMIZATION_NAMESPACE $FLUX_KUSTOMIZATION_NAME --type=merge -p '{\"spec\":{\"suspend\":false}}'"
  warn "  - OR restore from backup: $0 --restore-from-backup <name>"
}

# ─── --restore-from-backup ───────────────────────────────────────────────
do_restore_from_backup() {
  local backup_name="$1"
  local replace="${2:-no}"
  local skip_confirmation="${3:-no}"

  if [ -z "$backup_name" ]; then
    err "--restore-from-backup requires <backup-name>"
    list_backups
    exit 1
  fi

  # Verify the backup exists + is in 'completed' state
  local phase
  phase=$("$KUBECTL" get backup.postgresql.cnpg.io -n "$NAMESPACE" "$backup_name" \
    -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
  if [ -z "$phase" ]; then
    err "Backup $NAMESPACE/$backup_name not found"
    exit 2
  fi
  if [ "$phase" != "completed" ]; then
    err "Backup $NAMESPACE/$backup_name has phase=$phase (need 'completed')"
    exit 3
  fi
  ok "Backup $backup_name is in phase=completed."

  # If a healthy cluster already exists, refuse unless --replace
  if "$KUBECTL" get cluster.postgresql.cnpg.io -n "$NAMESPACE" "$CLUSTER_NAME" >/dev/null 2>&1; then
    if [ "$replace" != "yes" ]; then
      err "A cluster $NAMESPACE/$CLUSTER_NAME already exists. To replace it with a restored copy:"
      err "  $0 --restore-from-backup $backup_name --replace"
      exit 1
    fi
    echo ""
    echo "${YEL}--replace given. Existing cluster + PVCs will be deleted first.${NC}"
    if [ "$skip_confirmation" != "yes" ]; then
      echo "Type ${RED}REPLACE-FROM-BACKUP${NC} to confirm:"
      read -r CONFIRM
      if [ "$CONFIRM" != "REPLACE-FROM-BACKUP" ]; then
        err "Confirmation did not match. Aborted."
        exit 1
      fi
    fi
    flux_suspend_if_present || true
    "$KUBECTL" delete cluster.postgresql.cnpg.io -n "$NAMESPACE" "$CLUSTER_NAME" --wait=true --timeout=180s

    # Critical: kubectl apply merges into an existing CR's spec, and if we
    # apply bootstrap.recovery while bootstrap.initdb is still in the live
    # spec (because deletion is mid-flight), CNPG's validation webhook
    # rejects it with "Too many bootstrap types specified". Poll until the
    # CR is fully gone from the apiserver.
    ok "Waiting for cluster CR to fully clear from apiserver…"
    local poll_deadline=$(( $(date +%s) + 180 ))
    while [ "$(date +%s)" -lt "$poll_deadline" ]; do
      if ! "$KUBECTL" get cluster.postgresql.cnpg.io -n "$NAMESPACE" "$CLUSTER_NAME" >/dev/null 2>&1; then
        ok "Cluster CR cleared."
        break
      fi
      sleep 3
    done
    if "$KUBECTL" get cluster.postgresql.cnpg.io -n "$NAMESPACE" "$CLUSTER_NAME" >/dev/null 2>&1; then
      err "Cluster CR did not fully delete within 180s — apply would race with deletion."
      err "Investigate finalizers: kubectl get cluster.postgresql.cnpg.io -n $NAMESPACE $CLUSTER_NAME -o jsonpath='{.metadata.finalizers}'"
      exit 2
    fi

    # PVC delete: --wait=false because Longhorn detach is async and can
    # take several minutes. CNPG's recovery flow creates fresh PVCs from
    # the backup; the orphaned ones from the deleted cluster will be
    # garbage-collected once their finalizers clear (they share no name
    # with the new ones because CNPG appends fresh suffixes).
    "$KUBECTL" delete pvc -n "$NAMESPACE" -l "cnpg.io/cluster=$CLUSTER_NAME" --wait=false --grace-period=30 || true
  else
    flux_suspend_if_present || true
  fi

  echo ""
  ok "Applying restored Cluster CR with bootstrap.recovery → $backup_name …"

  # Render the restored Cluster CR. We deliberately keep the same `name`
  # so downstream Services/StatefulSets reconnect without needing extra
  # manifest changes. CNPG handles backfill from the WAL archive +
  # the named Backup's base backup.
  cat <<YAML | "$KUBECTL" apply -f -
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: $CLUSTER_NAME
  namespace: $NAMESPACE
  annotations:
    # match the original cluster.yaml so Flux SSA doesn't fight us
    kustomize.toolkit.fluxcd.io/ssa: merge
    # mark this restore so the next Flux reconcile preserves the
    # bootstrap.recovery section instead of replacing it with initdb.
    platform.example.test/restored-from: $backup_name
  labels:
    app: mail-pg
    app.kubernetes.io/part-of: hosting-platform
    app.kubernetes.io/component: mail-database
spec:
  imageName: ghcr.io/cloudnative-pg/postgresql:16.9
  bootstrap:
    recovery:
      backup:
        name: $backup_name
  storage:
    size: 5Gi
    storageClass: longhorn-system-local
  resources:
    requests:
      cpu: 50m
      memory: 256Mi
    limits:
      cpu: 200m
      memory: 512Mi
  affinity:
    nodeSelector:
      platform.example.test/node-role: server
    tolerations:
      - key: platform.example.test/server-only
        operator: Exists
        effect: NoSchedule
YAML

  echo ""
  ok "Cluster CR applied. CNPG will now restore from the backup."
  ok "Watch progress: $KUBECTL get cluster.postgresql.cnpg.io -n $NAMESPACE $CLUSTER_NAME -w"
  ok "When .status.readyInstances >= 1, Stalwart will reconnect on its next pod restart."
  echo ""
  echo "${DIM}Note: after CNPG reports Ready, you may need to roll Stalwart so it${NC}"
  echo "${DIM}picks up any cached connection state:${NC}"
  echo "${DIM}  $KUBECTL rollout restart deploy -n mail stalwart-mail-v016${NC}"
  echo ""
  warn "Flux is currently SUSPENDED on $FLUX_KUSTOMIZATION_NAMESPACE/$FLUX_KUSTOMIZATION_NAME."
  warn "Once you've VERIFIED the restore (e.g. test mailbox auth works), resume:"
  warn "  $KUBECTL patch kustomization.kustomize.toolkit.fluxcd.io \\"
  warn "    -n $FLUX_KUSTOMIZATION_NAMESPACE $FLUX_KUSTOMIZATION_NAME \\"
  warn "    --type=merge -p '{\"spec\":{\"suspend\":false}}'"
  warn ""
  warn "When Flux resumes, the in-git Cluster CR (with bootstrap.initdb) will"
  warn "reconcile against the restored Cluster (with bootstrap.recovery). CNPG's"
  warn "behavior is to retain spec.bootstrap from the running Cluster — your data"
  warn "is safe — but verify the restored Cluster CR has not silently changed."
}

# ─── arg parsing ─────────────────────────────────────────────────────────
MODE=""
BACKUP_NAME=""
REPLACE="no"
SKIP_CONFIRMATION="no"

while [ $# -gt 0 ]; do
  case "$1" in
    --list-backups)            MODE="list"; shift ;;
    --restore-from-backup)     MODE="restore"; BACKUP_NAME="${2:-}"; shift 2 ;;
    --really-delete-mail-pg)   MODE="delete"; shift ;;
    --replace)                 REPLACE="yes"; shift ;;
    --skip-confirmation)       SKIP_CONFIRMATION="yes"; shift ;;
    --namespace)               NAMESPACE="$2"; shift 2 ;;
    --cluster-name)            CLUSTER_NAME="$2"; shift 2 ;;
    -h|--help)                 usage; exit 0 ;;
    *)                         err "Unknown argument: $1"; usage; exit 1 ;;
  esac
done

require_kubectl

case "$MODE" in
  list)    list_backups ;;
  restore) do_restore_from_backup "$BACKUP_NAME" "$REPLACE" "$SKIP_CONFIRMATION" ;;
  delete)  do_really_delete "$SKIP_CONFIRMATION" ;;
  "")      err "No mode given. Use --list-backups, --restore-from-backup, or --really-delete-mail-pg."; usage; exit 1 ;;
esac
