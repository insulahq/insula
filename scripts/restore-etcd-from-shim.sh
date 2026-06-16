#!/usr/bin/env bash
# restore-etcd-from-shim.sh — R-X11 restore tooling for SYSTEM.etcd.
#
# Pulls the newest (or operator-named) etcd snapshot from the
# shim's `s3://system/etcd/<cluster_id>/` bucket and runs `k3s
# etcd-snapshot restore` on the control-plane node.
#
# CLUSTER-ID NAMESPACING (collision safety): etcd snapshots are
# namespaced under the stable per-cluster `cluster_id` so that two
# clusters sharing one upstream S3 target can never cross-restore.
# Pulling ANOTHER cluster's etcd into this one is catastrophic —
# the namespace makes `--latest` always scoped to THIS cluster.
# The prefix is resolved from the live CronJob's SHIM_PREFIX env
# (the exact value the upload writes, so paths always match);
# `--cluster-id <id>` overrides when the CronJob isn't reachable
# (e.g. a bare-metal rebuild before Flux has synced).
#
# RUN THIS ON A CONTROL-PLANE NODE — k3s etcd snapshot restore
# is local: it stops the local k3s, replaces the local etcd
# database, then restarts. For a multi-node cluster this is the
# canonical "rebuild from disaster" flow per k3s docs.
#
# Pre-flight:
#   * MUST run as root on the target control-plane node
#   * backup-rclone-shim DaemonSet pod must be Ready on this node
#     (internalTrafficPolicy=Local; the local shim is what we read)
#   * `rclone` CLI must be installed on the node (we use it via the
#     shim's S3 endpoint with HKDF-derived creds read from the
#     backup-rclone-shim-creds Secret)
#
# Usage (ONLINE — cluster is up, reads via the in-cluster shim):
#   sudo ./scripts/restore-etcd-from-shim.sh --latest
#   sudo ./scripts/restore-etcd-from-shim.sh --name <host>-<ts>.db
#   sudo ./scripts/restore-etcd-from-shim.sh --list
#   sudo ./scripts/restore-etcd-from-shim.sh --dry-run --latest
#   sudo ./scripts/restore-etcd-from-shim.sh --cluster-id <uuid> --latest
#
# Usage (OFFLINE — fresh node / cluster DOWN; NO kubectl, NO shim):
#   Reads the DECRYPTED `system` upstream target from the DR-bundle
#   descriptor (dr-system-target.json, carried in the age-encrypted bundle
#   that `platform-ops dr verify/restore` consumes) and pulls the etcd
#   snapshot DIRECTLY from the real upstream S3:
#     sudo ./scripts/restore-etcd-from-shim.sh --offline \
#          --bundle <secrets-*.tar.age> --age-key <operator-private.key> --latest
#     ./scripts/restore-etcd-from-shim.sh --offline --descriptor <dr-system-target.json> --list
#   (--list / --dry-run need no root and make NO cluster contact — the
#   way to prove break-glass works before a real disaster.) S3 upstreams
#   only; SFTP/CIFS fall back to a local snapshot or the online path.
#   This breaks the etcd chicken-and-egg: the off-site copy no longer
#   needs the kube-API that's down. Prefer restore-etcd-local.sh (Tier 0)
#   first if this node's local k3s snapshots survived.
#
# Exit codes:
#   0   success
#   1   pre-flight failed
#   2   rclone copy failed
#   3   k3s etcd-snapshot restore failed

set -euo pipefail

MODE=""
SNAP_NAME=""
DRY_RUN=0
CLUSTER_ID=""
KUBECTL=${KUBECTL:-kubectl}
# OFFLINE break-glass (no cluster): read the real upstream target from a
# DR-bundle descriptor and talk DIRECTLY to it — no kubectl, no shim.
OFFLINE=0
BUNDLE=""
AGE_KEY=""
DESCRIPTOR=""
AGE_BIN="${AGE_BIN:-age}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --latest)     MODE="latest"; shift ;;
    --list)       MODE="list"; shift ;;
    --name)       MODE="name"; SNAP_NAME="${2:?--name requires a snapshot filename}"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --cluster-id) CLUSTER_ID="${2:?--cluster-id requires a value}"; shift 2 ;;
    --offline)    OFFLINE=1; shift ;;
    --bundle)     BUNDLE="${2:?--bundle requires a path to the age-encrypted secrets bundle}"; shift 2 ;;
    --age-key)    AGE_KEY="${2:?--age-key requires a path to the operator age private key}"; shift 2 ;;
    --descriptor) DESCRIPTOR="${2:?--descriptor requires a path to a dr-system-target.json}"; shift 2 ;;
    -h|--help)
      sed -n '1,/^set -euo/p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# --bundle / --age-key / --descriptor imply offline.
if [[ -n "$BUNDLE" || -n "$DESCRIPTOR" ]]; then OFFLINE=1; fi

if [[ -z "$MODE" ]]; then
  echo "ERROR: --latest, --list, or --name <snap> required" >&2
  exit 1
fi

log() { printf '\033[34m[restore-etcd]\033[0m %s\n' "$1"; }
fail() { printf '\033[31m[restore-etcd FAIL]\033[0m %s\n' "$1" >&2; exit 1; }

# Run rclone with the S3 credentials injected via the ENVIRONMENT of the
# rclone child only — never as argv flags (which leak through
# /proc/<pid>/cmdline to any process on the host). ACCESS_KEY/SECRET_KEY are
# set by whichever mode-branch ran below; RCLONE_FLAGS carries only the
# non-sensitive options. (Security review HIGH-1.)
rclone_s3() {
  env RCLONE_S3_ACCESS_KEY_ID="$ACCESS_KEY" RCLONE_S3_SECRET_ACCESS_KEY="$SECRET_KEY" \
    rclone "${RCLONE_FLAGS[@]}" "$@"
}

# ── Pre-flight ───────────────────────────────────────────────────────
if [[ "$MODE" == "name" || "$MODE" == "latest" ]] && [[ "$DRY_RUN" -eq 0 && "$(id -u)" -ne 0 ]]; then
  fail "Must run as root for k3s etcd-snapshot restore. Re-run with sudo."
fi
if ! command -v rclone >/dev/null 2>&1; then
  fail "rclone CLI not installed. apt install rclone (or download from rclone.org)"
fi

# `S3_ROOT` is the bucket/key root the snapshots live under, addressed via
# `:s3:$S3_ROOT/`. RCLONE_FLAGS carries the S3 connection. Both are set by
# exactly one of the two branches below.
RCLONE_FLAGS=()
S3_ROOT=""

if [[ "$OFFLINE" -eq 1 ]]; then
  # ── OFFLINE break-glass: NO kubectl, NO shim ───────────────────────
  # Read the DECRYPTED system-class upstream target from the DR-bundle
  # descriptor and talk DIRECTLY to the real upstream S3. This is the
  # fresh-node / cluster-down path: there is no kube-API to read the shim
  # ClusterIP/creds from, so everything comes from the bundle the operator
  # carries. The descriptor's etcdKeyPrefix is already cluster_id-namespaced.
  command -v python3 >/dev/null 2>&1 || fail "python3 required to parse the descriptor in --offline mode"

  DESC_JSON=""
  if [[ -n "$DESCRIPTOR" ]]; then
    [[ -f "$DESCRIPTOR" ]] || fail "--descriptor file not found: $DESCRIPTOR"
    DESC_JSON=$(cat "$DESCRIPTOR")
    # The descriptor holds plaintext upstream credentials. We don't auto-
    # delete it (the operator typically reuses it across --list then
    # --latest), but make the cleanup obligation loud. (Security review HIGH-2.)
    log "WARNING: $DESCRIPTOR contains PLAINTEXT upstream credentials — 'shred -u $DESCRIPTOR' when done."
  else
    [[ -n "$BUNDLE" && -n "$AGE_KEY" ]] || fail "--offline needs --bundle <tar.age> --age-key <key> (or --descriptor <json>)"
    [[ -f "$BUNDLE" ]] || fail "--bundle file not found: $BUNDLE"
    [[ -f "$AGE_KEY" ]] || fail "--age-key file not found: $AGE_KEY"
    command -v "$AGE_BIN" >/dev/null 2>&1 || fail "$AGE_BIN (age) required to decrypt the bundle in --offline mode"
    # Stream-decrypt and extract ONLY the descriptor member to stdout — the
    # plaintext bundle never touches disk. The tar member name is verbatim
    # 'dr-system-target.json' (tar-stream writes names without a './'
    # prefix). Capture age stderr so a wrong-key / corrupt-bundle failure is
    # actionable instead of a bare "could not extract". (Security review
    # MEDIUM-2 / LOW-1.)
    AGE_ERR=$(mktemp "${TMPDIR:-/dev/shm}/restore-etcd-age-err.XXXXXX" 2>/dev/null || mktemp)
    trap 'rm -f "$AGE_ERR"' EXIT
    DESC_JSON=$("$AGE_BIN" -d -i "$AGE_KEY" "$BUNDLE" 2>"$AGE_ERR" \
      | tar -xO dr-system-target.json 2>/dev/null || true)
    if [[ -z "$DESC_JSON" ]]; then
      fail "Could not extract dr-system-target.json from the bundle: $(head -2 "$AGE_ERR" | tr '\n' ' '). (Wrong age key, corrupt bundle, or the bundle predates a bound SYSTEM target — re-export via /admin/system-backup/export-secrets-bundle after binding one, or pass --descriptor.)"
    fi
  fi

  # Parse exactly the fields we need. python3 reads the JSON from stdin so
  # no secret ever lands in argv/env of a child process.
  field() { printf '%s' "$DESC_JSON" | FIELD="$1" python3 -c "import json,os,sys;d=json.load(sys.stdin);print(d.get(os.environ['FIELD'],'') or '')" 2>/dev/null || true; }
  STORAGE_TYPE=$(field storageType)
  ETCD_KEY_PREFIX=$(field etcdKeyPrefix)
  [[ "$STORAGE_TYPE" == "s3" ]] || fail "Offline restore currently supports S3 upstreams only (descriptor storageType='$STORAGE_TYPE'). For SFTP/CIFS, restore from a local snapshot (restore-etcd-local.sh) or via the in-cluster shim once the cluster is up."
  S3_ENDPOINT=$(field s3Endpoint)
  S3_REGION=$(field s3Region)
  S3_BUCKET=$(field s3Bucket)
  ACCESS_KEY=$(field s3AccessKey)
  SECRET_KEY=$(field s3SecretKey)
  PATH_STYLE=$(field s3UsePathStyle)
  [[ -n "$S3_ENDPOINT" && -n "$S3_BUCKET" && -n "$ACCESS_KEY" && -n "$SECRET_KEY" && -n "$ETCD_KEY_PREFIX" ]] \
    || fail "Descriptor missing required S3 fields (endpoint/bucket/accessKey/secretKey/etcdKeyPrefix)."
  # Guard (mirror the online guard): the resolved key prefix MUST be
  # cluster_id-namespaced under system/etcd — never a bare/shared path.
  # Accept both `system/etcd/<id>` (bucket-root target, no operator prefix)
  # and `<prefix>/system/etcd/<id>`; require a NON-empty cluster-id segment.
  case "$ETCD_KEY_PREFIX" in
    system/etcd/?* | */system/etcd/?*) : ;;
    *) fail "Refusing to restore from a non-namespaced etcd key prefix '$ETCD_KEY_PREFIX' (expected '[<prefix>/]system/etcd/<cluster_id>')." ;;
  esac
  # The individual creds are now in ACCESS_KEY/SECRET_KEY; drop the full JSON
  # blob from memory so it doesn't linger for the script's lifetime. (MEDIUM-3.)
  unset DESC_JSON

  # Credentials go via env (rclone_s3), NOT argv — see HIGH-1 above.
  RCLONE_FLAGS=(
    --s3-provider=Other
    --s3-endpoint="$S3_ENDPOINT"
    --s3-region="${S3_REGION:-auto}"
    --s3-no-check-bucket
  )
  # Honour the descriptor's path-style (real upstreams vary: Hetzner is
  # path-style, AWS virtual-hosted). The shim path always forced it.
  if [[ "$PATH_STYLE" == "True" || "$PATH_STYLE" == "true" || -z "$PATH_STYLE" ]]; then
    RCLONE_FLAGS+=(--s3-force-path-style)
  fi
  S3_ROOT="$S3_BUCKET/$ETCD_KEY_PREFIX"
  log "OFFLINE mode — reading directly from the upstream S3 (no cluster): :s3:$S3_ROOT/"
else
  # ── ONLINE: kubectl → in-cluster shim (cluster is up) ──────────────
  # Resolve shim creds from the cluster Secret. We use kubectl to
  # pull them — the script runs on a control-plane node so kubectl
  # reaches the local apiserver.
  log "Reading backup-rclone-shim-creds Secret for shim S3 creds"
  ACCESS_KEY=$($KUBECTL -n platform get secret backup-rclone-shim-creds -o jsonpath='{.data.access_key}' 2>/dev/null | base64 -d || true)
  SECRET_KEY=$($KUBECTL -n platform get secret backup-rclone-shim-creds -o jsonpath='{.data.secret_key}' 2>/dev/null | base64 -d || true)
  if [[ -z "$ACCESS_KEY" || -z "$SECRET_KEY" ]]; then
    fail "backup-rclone-shim-creds Secret missing or empty. Bind SYSTEM shim class first (PUT /api/v1/admin/backup-rclone-shim/assignments/system). If the cluster is DOWN, use --offline --bundle <tar.age> --age-key <key>."
  fi

  # Resolve the shim's S3 endpoint to its ClusterIP, NOT the
  # `.svc.cluster.local` DNS name. This script runs on a node HOST (k3s
  # etcd-snapshot restore is a local operation), and the host does NOT resolve
  # cluster DNS — that's pod-network only (and in a real etcd disaster CoreDNS is
  # down too — that's what --offline is for). The ClusterIP is kube-proxy-routed
  # and reachable from the host. Fall back to the DNS name only if the ClusterIP
  # can't be read.
  SHIM_IP=$($KUBECTL -n platform get svc backup-rclone-shim -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)
  if [[ -n "$SHIM_IP" && "$SHIM_IP" != "None" ]]; then
    SHIM_ENDPOINT="http://${SHIM_IP}:9000"
  else
    SHIM_ENDPOINT="http://backup-rclone-shim.platform.svc.cluster.local:9000"
    log "WARN: could not read shim ClusterIP; using in-cluster DNS (likely unresolvable from a node host). If the cluster is down, use --offline."
  fi
  log "shim S3 endpoint: $SHIM_ENDPOINT"

  # Credentials go via env (rclone_s3), NOT argv — see HIGH-1 above.
  RCLONE_FLAGS=(
    --s3-provider=Other
    --s3-endpoint="$SHIM_ENDPOINT"
    --s3-force-path-style
    --s3-region=auto
    --s3-no-check-bucket
  )

  # ── Resolve the cluster_id-namespaced upload prefix ────────────────
  # Order of precedence:
  #   1. --cluster-id <id> override → `etcd/<id>` (operator escape hatch
  #      for a bare-metal rebuild where the CronJob isn't applied yet).
  #   2. The live CronJob's SHIM_PREFIX env — the AUTHORITATIVE source:
  #      it is the exact value the upload writes to, so the restore path
  #      can never drift from where snapshots actually landed.
  # We deliberately do NOT fall back to a bare `etcd/` — a silent un-
  # namespaced read is the very cross-cluster footgun this prevents.
  ETCD_PREFIX=""
  if [[ -n "$CLUSTER_ID" ]]; then
    ETCD_PREFIX="etcd/$CLUSTER_ID"
    log "Using --cluster-id override → prefix $ETCD_PREFIX"
  else
    ETCD_PREFIX=$($KUBECTL -n platform get cronjob etcd-snap-via-shim \
      -o jsonpath='{.spec.jobTemplate.spec.template.spec.containers[?(@.name=="rclone")].env[?(@.name=="SHIM_PREFIX")].value}' \
      2>/dev/null || true)
    if [[ -z "$ETCD_PREFIX" ]]; then
      fail "Could not read SHIM_PREFIX from the etcd-snap-via-shim CronJob (is it applied?). Pass --cluster-id <uuid> to target a cluster's snapshots explicitly. The cluster_id is platform_settings → cluster_id (SELECT setting_value FROM platform_settings WHERE setting_key='cluster_id')."
    fi
    log "Resolved upload prefix from CronJob SHIM_PREFIX → $ETCD_PREFIX"
  fi
  # Guard: the prefix MUST be cluster_id-namespaced (`etcd/<id>`), never a
  # bare `etcd`. A bare prefix means an un-upgraded cluster — restoring from
  # the shared root risks pulling another cluster's snapshot.
  if [[ "$ETCD_PREFIX" == "etcd" || "$ETCD_PREFIX" != etcd/* ]]; then
    fail "Refusing to restore from un-namespaced prefix '$ETCD_PREFIX'. Expected 'etcd/<cluster_id>'. Pass --cluster-id <uuid> explicitly if you really mean to read a specific cluster's snapshots."
  fi
  S3_ROOT="system/$ETCD_PREFIX"
fi

# ── List ─────────────────────────────────────────────────────────────
if [[ "$MODE" == "list" ]]; then
  log "Available etcd snapshots in :s3:$S3_ROOT/:"
  rclone_s3 lsf ":s3:$S3_ROOT/" \
    | grep '\.db$' \
    | sort
  exit 0
fi

# ── Resolve target snapshot ──────────────────────────────────────────
if [[ "$MODE" == "latest" ]]; then
  SNAP_NAME=$(rclone_s3 lsf ":s3:$S3_ROOT/" \
    | grep '\.db$' \
    | sort -r | head -1)
  if [[ -z "$SNAP_NAME" ]]; then
    fail "No etcd snapshots found in :s3:$S3_ROOT/. Has the etcd-snap-via-shim CronJob run yet? Check kubectl -n platform get cronjob etcd-snap-via-shim"
  fi
  log "Resolved --latest → $SNAP_NAME"
fi

DEST=/var/lib/rancher/k3s/server/db/snapshots/restore-from-shim-$(date -u +%Y%m%d-%H%M%S).db
log "Will download :s3:$S3_ROOT/$SNAP_NAME → $DEST"

if [[ $DRY_RUN -eq 1 ]]; then
  log "DRY-RUN — skipping download + restore"
  exit 0
fi

# ── Download ────────────────────────────────────────────────────────
log "Downloading snapshot..."
if ! rclone_s3 copyto ":s3:$S3_ROOT/$SNAP_NAME" "$DEST"; then
  fail "rclone download failed"
fi
log "Downloaded $(du -h "$DEST" | cut -f1) to $DEST"

# Optional: download + verify .meta sidecar
META_DEST="$DEST.meta"
if rclone_s3 copyto ":s3:$S3_ROOT/$SNAP_NAME.meta" "$META_DEST" 2>/dev/null; then
  log "Snapshot metadata: $(cat "$META_DEST")"
  EXPECTED_SHA=$(grep -oE '"sha256":"[a-f0-9]+"' "$META_DEST" | cut -d '"' -f 4 || true)
  if [[ -n "$EXPECTED_SHA" ]]; then
    ACTUAL_SHA=$(sha256sum "$DEST" | cut -d ' ' -f 1)
    if [[ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]]; then
      fail "sha256 mismatch: expected $EXPECTED_SHA, got $ACTUAL_SHA. Aborting restore."
    fi
    log "sha256 verified: $ACTUAL_SHA"
  fi
fi

# ── Restore ──────────────────────────────────────────────────────────
log "Stopping k3s..."
systemctl stop k3s

log "Restoring etcd snapshot via k3s..."
if ! k3s etcd-snapshot restore --name "$(basename "$DEST")"; then
  fail "k3s etcd-snapshot restore failed. The on-disk snapshot is at $DEST — operator can retry manually."
fi

log "Starting k3s..."
systemctl start k3s

log "etcd restore COMPLETE. The cluster is now in the post-restore state."
log "Verify with: kubectl get nodes; kubectl -n platform get pods"
log ""
log "If the restored cluster is missing recent changes (last few hours),"
log "verify the snapshot timestamp matches your RPO target. List with:"
log "  ./scripts/restore-etcd-from-shim.sh --list"
