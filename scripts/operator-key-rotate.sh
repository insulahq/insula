#!/usr/bin/env bash
# scripts/operator-key-rotate.sh
#
# Re-generate the OPERATOR AGE KEY — the keypair whose public half
# (recipient) encrypts every platform secrets bundle (Tier-1 DR
# artifact) and whose private half the operator holds offline.
#
# Use this when the operator private key is LOST, or as a deliberate
# rotation. What it does:
#   1. Generates a new age keypair (or takes --recipient for an
#      operator-held key that never touches the server)
#   2. Preserves any existing key files with a .old-<stamp> suffix —
#      never deletes them (they may still decrypt old bundles)
#   3. Updates the platform-operator-recipient ConfigMap the
#      secrets-backup CronJob encrypts to
#   4. Triggers a fresh secrets-bundle export so the NEWEST off-site
#      bundle is readable with the NEW key (skip with --skip-bundle)
#
# NOT destructive, but understand the consequences:
#   - Bundles exported BEFORE the rotation stay encrypted to the OLD
#     key. If that key is lost, those bundles are unrecoverable —
#     rotation does not (cannot) re-encrypt them.
#   - After rotating, copy the new private key offline immediately
#     (make secrets-fetch) and delete it from the server (shred -u).
#
# Usage:
#   insula operator-key rotate                       # interactive
#   insula operator-key rotate --yes                 # skip confirmation
#   insula operator-key rotate --recipient age1...   # operator-held key
#   insula operator-key rotate --skip-bundle         # no fresh export
#
# Also runnable standalone: ./scripts/operator-key-rotate.sh

set -Eeuo pipefail

# ----- options -----
ASSUME_YES=0
SKIP_BUNDLE=0
RECIPIENT_ARG=""
KUBECTL="${KUBECTL:-kubectl}"
NS=platform
CM_NAME=platform-operator-recipient
MARKER_DIR="${MARKER_DIR:-/var/lib/hosting-platform}"
KEY_DIR="${MARKER_DIR}/operator-key"

while [ $# -gt 0 ]; do
  case "$1" in
    --yes) ASSUME_YES=1; shift ;;
    --skip-bundle) SKIP_BUNDLE=1; shift ;;
    --recipient)
      [ $# -ge 2 ] || { echo "--recipient requires a value" >&2; exit 2; }
      RECIPIENT_ARG="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
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
log()  { echo "${C_CYAN}[operator-key]${C_OFF} $*"; }
warn() { echo "${C_YEL}[operator-key] WARN:${C_OFF} $*" >&2; }
die()  { echo "${C_RED}[operator-key] ERROR:${C_OFF} $*" >&2; exit 1; }

# ----- preflight -----
if ! $KUBECTL get ns "$NS" >/dev/null 2>&1; then
  # Bare kubectl with no config: fall back to the k3s admin kubeconfig
  # (same fallback the rest of the operator tooling uses).
  if [ -z "${KUBECONFIG:-}" ] && [ -r /etc/rancher/k3s/k3s.yaml ]; then
    export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
  fi
  $KUBECTL get ns "$NS" >/dev/null 2>&1 \
    || die "cannot reach the cluster ('$KUBECTL get ns $NS' failed). Run on a control-plane node, or set KUBECONFIG."
fi

CURRENT_RECIPIENT="$($KUBECTL get configmap "$CM_NAME" -n "$NS" -o jsonpath='{.data.recipient}' 2>/dev/null || true)"

echo ""
log "Operator age key rotation"
echo ""
echo "  Current recipient (cluster): ${CURRENT_RECIPIENT:-<none — ConfigMap missing>}"
if [ -f "${KEY_DIR}/operator-private.key" ]; then
  echo "  Private key on this host:    ${KEY_DIR}/operator-private.key (will be preserved as .old-<stamp>)"
else
  echo "  Private key on this host:    not present (held offline, or lost)"
fi
echo ""
echo "${C_YEL}Consequences:${C_OFF}"
echo "  - Bundles exported BEFORE this rotation stay encrypted to the OLD key."
echo "    If the old key is lost, those bundles are permanently unreadable."
echo "  - All FUTURE bundles (and the fresh export this script triggers)"
echo "    encrypt to the NEW key."
echo ""

if [ "$ASSUME_YES" -ne 1 ]; then
  printf "Type %srotate%s to proceed: " "$C_GRN" "$C_OFF"
  read -r answer
  [ "$answer" = "rotate" ] || die "aborted (expected 'rotate')."
fi

# ----- new key material -----
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
recipient=""
private_key=""

if [ -n "$RECIPIENT_ARG" ]; then
  # Operator supplied the public half — validate shape (comma-separated
  # list allowed for team-held multi-recipient setups), never write a
  # private key anywhere.
  IFS=',' read -ra _parts <<< "$RECIPIENT_ARG"
  for part in "${_parts[@]}"; do
    part="${part# }"; part="${part% }"
    # Same anchored shape check bootstrap.sh applies to --operator-age-recipient.
    if ! printf '%s' "$part" | grep -Eq '^age1[a-z0-9]{48,}$'; then
      die "invalid age recipient: '$part'. Expected an 'age1...' Bech32 string."
    fi
  done
  recipient="$RECIPIENT_ARG"
  log "Using operator-provided recipient(s) — no private key generated on this host."
else
  command -v age-keygen >/dev/null 2>&1 \
    || die "age-keygen not found on PATH (install the 'age' package)."
  keygen_out="$(age-keygen 2>/dev/null)" || die "age-keygen failed."
  recipient="$(printf '%s\n' "$keygen_out" | grep -E '^# public key:' | awk '{print $NF}')"
  private_key="$(printf '%s\n' "$keygen_out" | grep -v '^#')"
  keygen_out=""
  [ -n "$recipient" ] && [ -n "$private_key" ] \
    || die "age-keygen produced empty key material — refusing to continue."
fi

# ----- preserve old files, write new ones -----
mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"
for f in operator-private.key operator-recipient.pub; do
  if [ -f "${KEY_DIR}/${f}" ]; then
    mv "${KEY_DIR}/${f}" "${KEY_DIR}/${f}.old-${STAMP}"
    log "Preserved old ${f} → ${f}.old-${STAMP}"
  fi
done

if [ -n "$private_key" ]; then
  {
    echo "# created: $(date -u +%FT%TZ) (rotated on $(hostname))"
    echo "# public key: ${recipient}"
    echo "${private_key}"
  } > "${KEY_DIR}/operator-private.key"
  chmod 600 "${KEY_DIR}/operator-private.key"
  private_key=""
fi
printf '%s\n' "$recipient" > "${KEY_DIR}/operator-recipient.pub"
chmod 644 "${KEY_DIR}/operator-recipient.pub"

# ----- update the cluster recipient -----
$KUBECTL create configmap "$CM_NAME" \
  --namespace="$NS" \
  --from-literal=recipient="$recipient" \
  --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
log "ConfigMap ${NS}/${CM_NAME} updated."

# ----- fresh export so the newest bundle uses the new key -----
if [ "$SKIP_BUNDLE" -eq 1 ]; then
  warn "--skip-bundle: no fresh export. The next scheduled secrets-backup run encrypts to the new key."
elif ! $KUBECTL get cronjob platform-secrets-backup -n "$NS" >/dev/null 2>&1; then
  warn "CronJob ${NS}/platform-secrets-backup not found — no fresh export triggered."
else
  JOB="secrets-backup-keyrotate-$(date -u +%s)"
  log "Triggering a fresh secrets-bundle export (Job ${JOB})..."
  if $KUBECTL create job --from=cronjob/platform-secrets-backup "$JOB" -n "$NS" >/dev/null 2>&1; then
    if $KUBECTL wait --for=condition=complete "job/${JOB}" -n "$NS" --timeout=300s >/dev/null 2>&1; then
      log "Fresh bundle exported to the active backup target (encrypted to the new key)."
    else
      warn "Export Job did not complete in 5 min — check: $KUBECTL logs -n $NS job/${JOB}"
      warn "(A missing/unreachable active backup target is the usual cause. The next"
      warn " scheduled run — or the admin panel's DR → Secrets Bundle export — will"
      warn " produce a new-key bundle once the target is healthy.)"
    fi
  else
    warn "Could not create export Job — trigger one from the admin panel (DR → Secrets Bundle)."
  fi
fi

# ----- summary -----
echo ""
log "${C_GRN}Rotation complete.${C_OFF}"
echo ""
echo "  New recipient: ${recipient}"
if [ -f "${KEY_DIR}/operator-private.key" ]; then
  echo "  New private key: ${KEY_DIR}/operator-private.key   (mode 0600)"
  echo ""
  echo "${C_YEL}Do this now:${C_OFF}"
  echo "  1. From your workstation:  make secrets-fetch HOST=root@<this-node>"
  echo "  2. Verify the copy, then delete it here:  shred -u ${KEY_DIR}/operator-private.key"
fi
echo "  Old key files (if any) were preserved as *.old-${STAMP} — keep them as"
echo "  long as any pre-rotation bundle might still be needed."
