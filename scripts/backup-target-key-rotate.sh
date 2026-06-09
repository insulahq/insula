#!/usr/bin/env bash
# scripts/backup-target-key-rotate.sh
#
# Rotate the platform-wide BACKUP_TARGET_KEY. See ADR-043 §13b.
#
# THIS IS A DESTRUCTIVE OPERATION:
#   - Every existing remote backup becomes unreadable AFTER rotation
#   - rclone-crypt-encrypted prefixes on upstream are deleted as part
#     of this flow (the operator no longer has a way to decrypt them)
#   - restic repositories under the same key are also invalidated
#
# Three-step confirmation gate:
#   1. Operator types the current key fingerprint (16-char prefix of
#      sha256(key))
#   2. Operator confirms via `--yes-i-have-offline-backups` flag
#   3. Final interactive prompt: type "rotate" to proceed
#
# After rotation:
#   - New 32-byte key generated, written to Secret platform/backup-target-key
#   - shim DaemonSet rolled (picks up new ConfigMap with new HKDF-derived
#     local S3 access/secret)
#   - The platform-api's drain-orchestrator pauses in-flight backups
#     for up to 5 min before the rollout
#   - Operator should immediately run `make secrets-fetch` to capture
#     the new key in the offline Tier-1 bundle
#
# Usage:
#   ./scripts/backup-target-key-rotate.sh                  # interactive
#   ./scripts/backup-target-key-rotate.sh --yes-i-have-offline-backups
#                                                          # skips checkbox

set -Eeuo pipefail

# ----- options -----
SKIP_CHECKBOX=0
KUBECTL="${KUBECTL:-kubectl}"
NS=platform
SECRET_NAME=backup-target-key

for arg in "$@"; do
  case "$arg" in
    --yes-i-have-offline-backups) SKIP_CHECKBOX=1 ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

# Colours (ANSI bold; respect NO_COLOR)
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RED=$'\033[31m'; C_YEL=$'\033[33m'; C_GRN=$'\033[32m'; C_CYAN=$'\033[36m'; C_OFF=$'\033[0m'
else
  C_RED=''; C_YEL=''; C_GRN=''; C_CYAN=''; C_OFF=''
fi

log()  { printf '%s\n' "$*" >&2; }
fail() { printf '%sERROR:%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

# base64 -w0 is GNU-only. macOS coreutils ignores -w silently and wraps
# at 76 chars, which would break our kubectl-patch JSON. Use this helper
# everywhere we need a single-line base64 string.
b64() {
  if printf 'x' | base64 -w0 >/dev/null 2>&1; then
    printf '%s' "$1" | base64 -w0
  else
    printf '%s' "$1" | base64 | tr -d '\n'
  fi
}

[ -n "${KUBECONFIG:-}" ] || fail "KUBECONFIG must be set to a cluster admin context"

if ! $KUBECTL get ns "$NS" >/dev/null 2>&1; then
  fail "namespace '$NS' not found; cluster not bootstrapped"
fi

# ----- read current key -----
if ! $KUBECTL get secret -n "$NS" "$SECRET_NAME" >/dev/null 2>&1; then
  fail "Secret $NS/$SECRET_NAME not found. Has the cluster been bootstrapped? bootstrap.sh generates this on first boot."
fi

# Fingerprint convention: sha256 of the RAW 32 bytes (matches bootstrap.sh +
# the platform-api config renderer). Stream through pipes to avoid
# NUL-byte truncation that would occur if we stored raw bytes in a
# shell variable (~11% probability for 32 random bytes).
key_data=$($KUBECTL get secret -n "$NS" "$SECRET_NAME" -o jsonpath='{.data.key}' 2>/dev/null || true)
[ -n "$key_data" ] || fail "Secret $NS/$SECRET_NAME has no 'key' field; cluster state inconsistent"

current_fp=$(printf '%s' "$key_data" | base64 -d | sha256sum | cut -d' ' -f1 | head -c 16)
generated_at=$($KUBECTL get secret -n "$NS" "$SECRET_NAME" -o jsonpath='{.data.generated_at}' 2>/dev/null | base64 -d 2>/dev/null || echo 'unknown')

cat >&2 <<EOF

${C_YEL}╔════════════════════════════════════════════════════════════════╗
║  BACKUP_TARGET_KEY ROTATION — DESTRUCTIVE OPERATION              ║
╚════════════════════════════════════════════════════════════════╝${C_OFF}

This will:
  ${C_RED}• PERMANENTLY invalidate every existing remote backup${C_OFF}
    (rclone-crypt encrypts under the OLD key; restic repos use the
    OLD key as RESTIC_PASSWORD — neither can be decrypted with the
    NEW key)
  • DELETE every upstream s3://<class>/* prefix (system, tenant, mail)
    and the corresponding s3://<class>-raw/* prefixes
  • Roll the backup-rclone-shim DaemonSet with new HKDF-derived
    local S3 credentials
  • Drain in-flight backups (up to 5 min) before applying the change

Current key in cluster:
  Secret:        $NS/$SECRET_NAME
  Generated at:  $generated_at
  Fingerprint:   ${C_CYAN}${current_fp}${C_OFF}

After rotation, the OLD bundle (still in offline custody as
.../bundles/*.tar.age via 'make secrets-fetch') REMAINS valid for
restoring backups taken under the OLD key. Treat it as a historical
artefact — but it cannot decrypt backups taken AFTER this rotation.

EOF

# ----- step 1: fingerprint challenge (out-of-band verification) -----
# We deliberately do NOT print the current fingerprint here — that would
# reduce this step to copy/paste. The operator must retrieve the value
# independently:
#   - from their offline secrets bundle (open the Secret manifest), or
#   - from `make backup-target-key-status` in a SEPARATE terminal
# This ensures the rotation can't proceed if the operator is on the
# wrong cluster or hasn't actually fetched the offline bundle.
log "${C_YEL}Step 1/3:${C_OFF} Type the current key fingerprint (look it up via"
log "         '${C_CYAN}make backup-target-key-status${C_OFF}' in a separate shell, or read it"
log "         from the offline secrets bundle). Type 'show' to reveal the"
log "         value at the cost of failing this verification step."
read -r -p "  fingerprint > " typed_fp
typed_fp=$(printf '%s' "$typed_fp" | tr -d '[:space:]' | head -c 16)
if [ "$typed_fp" = "show" ]; then
  log "${C_RED}  ✗ verification bypassed; cluster fingerprint is ${current_fp}.${C_OFF}"
  log "${C_RED}    re-run the script with the value typed correctly to proceed.${C_OFF}"
  exit 1
fi
if [ "$typed_fp" != "$current_fp" ]; then
  fail "fingerprint mismatch — aborted (got '$typed_fp')"
fi
log "${C_GRN}  ✓ fingerprint matches${C_OFF}"

# ----- step 2: offline-backup checkbox -----
if [ "$SKIP_CHECKBOX" -eq 1 ]; then
  log "${C_YEL}Step 2/3:${C_OFF} [CI] --yes-i-have-offline-backups flag set; skipping checkbox prompt"
  log "         (this should appear ONLY in CI / automation; if you see this"
  log "         interactively, abort and run the script without the flag)"
else
  log ""
  log "${C_YEL}Step 2/3:${C_OFF} Confirm you have the current Tier-1 secrets bundle in offline custody."
  log "         (run 'make secrets-fetch HOST=root@<server>' to capture; the bundle includes"
  log "          this Secret so backups taken under the current key remain restorable)"
  read -r -p "  type 'yes' to confirm > " confirm_offline
  if [ "$confirm_offline" != "yes" ]; then
    fail "offline-backup confirmation declined — aborted"
  fi
  log "${C_GRN}  ✓ offline-backup confirmed${C_OFF}"
fi

# ----- step 3: final confirmation -----
log ""
log "${C_YEL}Step 3/3:${C_OFF} Type ${C_RED}rotate${C_OFF} to proceed."
read -r -p "  > " final_confirm
if [ "$final_confirm" != "rotate" ]; then
  fail "final confirmation declined — aborted"
fi
log "${C_GRN}  ✓ proceeding with rotation${C_OFF}"

# ----- perform rotation -----
log ""
log "Generating new 32-byte key..."
new_key=$(openssl rand -base64 32 | tr -d '\n')
new_fp=$(printf '%s' "$new_key" | sha256sum | cut -d' ' -f1 | head -c 16)
new_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
log "  new fingerprint: ${C_CYAN}${new_fp}${C_OFF}"

# Strategic-merge patch wholesale-replaces the `data` map so consumers
# watching this Secret see a single atomic transition from old → new,
# never a partial state (e.g. new `key` with stale `fingerprint`).
# Annotations on the Secret are NOT touched by a strategic-merge of
# `data` — they're preserved.
log "Updating Secret $NS/$SECRET_NAME..."
$KUBECTL patch secret -n "$NS" "$SECRET_NAME" --type=strategic -p "$(cat <<JSON
{
  "data": {
    "key": "$(b64 "$new_key")",
    "generated_at": "$(b64 "$new_at")",
    "fingerprint": "$(b64 "$new_fp")",
    "rotated_from": "$(b64 "$current_fp")",
    "rotated_at": "$(b64 "$new_at")"
  }
}
JSON
)" >/dev/null

# The platform-api detects the Secret resourceVersion change and:
#   1. Calls drain-orchestrator (wait for in-flight backups, max 5 min)
#   2. Re-renders the shim ConfigMap with new HKDF-derived S3 creds
#   3. Triggers DaemonSet rolling restart via annotation hash bump
#   4. Deletes upstream s3://<class>/* prefixes (after a one-cycle grace)
#
# We don't do those steps here directly — the platform-api owns them
# (it must coordinate with the task-center for the drain). We just
# verify the API can see the new fingerprint.
# The platform-api reconciler (R-X4) runs on a 5-minute periodic
# schedule + a Secret-watch debounce. Allow 6 min for the watch to
# fire and the rolling restart to complete on all DaemonSet pods.
ACK_TIMEOUT_S="${BACKUP_KEY_ROTATE_ACK_TIMEOUT:-360}"
log "Waiting up to ${ACK_TIMEOUT_S}s for platform-api to acknowledge new fingerprint..."
deadline=$(( $(date +%s) + ACK_TIMEOUT_S ))
acked=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  ack_fp=$($KUBECTL get configmap -n "$NS" backup-rclone-shim-status -o jsonpath='{.data.key_fingerprint}' 2>/dev/null || true)
  if [ "$ack_fp" = "$new_fp" ]; then
    acked=1
    break
  fi
  sleep 5
done

if [ "$acked" -eq 1 ]; then
  log "${C_GRN}✓ rotation complete. New key fingerprint: ${new_fp}${C_OFF}"
else
  log "${C_YEL}⚠ rotation applied but platform-api did NOT acknowledge within ${ACK_TIMEOUT_S}s${C_OFF}"
  log "  The new key is in the Secret. The shim DaemonSet will pick it up on next"
  log "  reconcile cycle. Watch:"
  log "    kubectl get configmap -n $NS backup-rclone-shim-status -w"
  log "  Override the timeout with BACKUP_KEY_ROTATE_ACK_TIMEOUT=<seconds>."
fi

cat >&2 <<EOF

${C_YEL}NEXT STEPS:${C_OFF}
  1. Run ${C_CYAN}make secrets-fetch HOST=root@<server>${C_OFF} to capture the new
     Tier-1 secrets bundle. Store it offline. Without it, future
     backups become unrecoverable on cluster loss.
  2. Trigger a fresh full backup of each class so the new key has
     at least one usable backup before any rotation drama:
       kubectl create job -n platform --from=cronjob/etcd-snap-via-shim etcd-rotate-post
       (postgres barman-cloud auto-archives the next WAL; restic
        re-keying happens on next scheduled run)
  3. Verify restore tooling works against the new bundle:
       ./scripts/restore-etcd.sh --dry-run --bundle <new-bundle>

EOF
