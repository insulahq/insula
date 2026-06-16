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
#   snapshot DIRECTLY from the real upstream (S3 / SFTP / CIFS):
#     sudo ./scripts/restore-etcd-from-shim.sh --offline \
#          --bundle <secrets-*.tar.age> --age-key <operator-private.key> --latest
#     ./scripts/restore-etcd-from-shim.sh --offline --descriptor <dr-system-target.json> --list
#   (--list / --dry-run need no root and make NO cluster contact — the
#   way to prove break-glass works before a real disaster.) All shim-
#   supported protocols work offline (S3, SFTP, CIFS/SMB) — rclone speaks
#   them directly; creds go via a 0600 rendered rclone.conf, never argv.
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

# Unified rclone invocation — credentials NEVER on argv (they leak via
# /proc/<pid>/cmdline; security review HIGH-1):
#  - OFFLINE: a rendered 0600 rclone.conf ($RCLONE_CONF) carries the upstream
#    section (s3 / sftp / smb). Creds live only in that file (chmod 600,
#    shredded on exit). The remote is always `upstream:`.
#  - ONLINE: the shim is always S3 — creds go via the rclone S3 env vars,
#    non-sensitive options in RCLONE_FLAGS. The remote is always `:s3:`.
rclone_up() {
  if [[ -n "${RCLONE_CONF:-}" ]]; then
    rclone --config "$RCLONE_CONF" "$@"
  else
    env RCLONE_S3_ACCESS_KEY_ID="$ACCESS_KEY" RCLONE_S3_SECRET_ACCESS_KEY="$SECRET_KEY" \
      rclone "${RCLONE_FLAGS[@]}" "$@"
  fi
}

# ── Pre-flight ───────────────────────────────────────────────────────
if [[ "$MODE" == "name" || "$MODE" == "latest" ]] && [[ "$DRY_RUN" -eq 0 && "$(id -u)" -ne 0 ]]; then
  fail "Must run as root for k3s etcd-snapshot restore. Re-run with sudo."
fi
if ! command -v rclone >/dev/null 2>&1; then
  fail "rclone CLI not installed. apt install rclone (or download from rclone.org)"
fi

# `REMOTE_BASE` is the full rclone remote+path prefix the snapshots live under
# (`:s3:<bucket>/<key>` online, `upstream:<path>` offline). RCLONE_FLAGS (S3
# online) / RCLONE_CONF (rendered, offline) carry the connection. Exactly one
# branch below sets these.
RCLONE_FLAGS=()
REMOTE_BASE=""
RCLONE_CONF=""

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
  [[ -n "$STORAGE_TYPE" && -n "$ETCD_KEY_PREFIX" ]] || fail "Descriptor missing storageType/etcdKeyPrefix."
  # Guard (mirror the online guard): the resolved key prefix MUST be
  # cluster_id-namespaced under system/etcd — never a bare/shared path. Accept
  # both `system/etcd/<id>` (root, no operator prefix) and `<prefix>/system/etcd/<id>`.
  case "$ETCD_KEY_PREFIX" in
    system/etcd/?* | */system/etcd/?*) : ;;
    *) fail "Refusing to restore from a non-namespaced etcd key prefix '$ETCD_KEY_PREFIX' (expected '[<prefix>/]system/etcd/<cluster_id>')." ;;
  esac

  # Render a 0600 rclone.conf for the upstream protocol — creds live ONLY in
  # this file (never argv/env; HIGH-1), shredded on exit. UP_PATH is the path
  # UNDER the remote where this cluster's etcd snapshots live.
  RCLONE_CONF=$(mktemp "${TMPDIR:-/dev/shm}/restore-etcd-rclone.XXXXXX"); chmod 600 "$RCLONE_CONF"
  SFTP_KEY_FILE=""
  trap 'rm -f "${AGE_ERR:-}" "$RCLONE_CONF" "${SFTP_KEY_FILE:-}" 2>/dev/null' EXIT
  obscure() { rclone obscure "$1" 2>/dev/null; }   # SFTP/SMB require the obscured pass
  UP_PATH=""
  case "$STORAGE_TYPE" in
    s3)
      S3_ENDPOINT=$(field s3Endpoint); S3_REGION=$(field s3Region); S3_BUCKET=$(field s3Bucket)
      AK=$(field s3AccessKey); SK=$(field s3SecretKey); PS=$(field s3UsePathStyle)
      [[ -n "$S3_ENDPOINT" && -n "$S3_BUCKET" && -n "$AK" && -n "$SK" ]] \
        || fail "Descriptor missing required S3 fields (endpoint/bucket/accessKey/secretKey)."
      PSFLAG=true; [[ "$PS" == "False" || "$PS" == "false" ]] && PSFLAG=false
      printf '[upstream]\ntype = s3\nprovider = Other\nendpoint = %s\nregion = %s\naccess_key_id = %s\nsecret_access_key = %s\nforce_path_style = %s\nno_check_bucket = true\n' \
        "$S3_ENDPOINT" "${S3_REGION:-auto}" "$AK" "$SK" "$PSFLAG" > "$RCLONE_CONF"
      UP_PATH="$S3_BUCKET/$ETCD_KEY_PREFIX"
      ;;
    ssh)
      SH=$(field sshHost); SP=$(field sshPort); SU=$(field sshUser); SKEY=$(field sshKey); SPASS=$(field sshPassword)
      [[ -n "$SH" && -n "$SU" ]] || fail "Descriptor missing required SFTP fields (host/user)."
      printf '[upstream]\ntype = sftp\nhost = %s\nuser = %s\nport = %s\nshell_type = unix\n' \
        "$SH" "$SU" "${SP:-22}" > "$RCLONE_CONF"
      if [[ -n "$SKEY" ]]; then
        SFTP_KEY_FILE=$(mktemp "${TMPDIR:-/dev/shm}/restore-etcd-sftpkey.XXXXXX"); chmod 600 "$SFTP_KEY_FILE"
        printf '%s\n' "$SKEY" > "$SFTP_KEY_FILE"
        printf 'key_file = %s\n' "$SFTP_KEY_FILE" >> "$RCLONE_CONF"
      elif [[ -n "$SPASS" ]]; then
        printf 'pass = %s\n' "$(obscure "$SPASS")" >> "$RCLONE_CONF"
      else
        fail "Descriptor SFTP target has neither sshKey nor sshPassword."
      fi
      UP_PATH="$ETCD_KEY_PREFIX"
      ;;
    cifs)
      CH=$(field cifsHost); CP=$(field cifsPort); CS=$(field cifsShare)
      CU=$(field cifsUser); CPW=$(field cifsPassword); CD=$(field cifsDomain)
      [[ -n "$CH" && -n "$CS" && -n "$CU" && -n "$CPW" ]] \
        || fail "Descriptor missing required CIFS fields (host/share/user/password)."
      { printf '[upstream]\ntype = smb\nhost = %s\nuser = %s\npass = %s\nport = %s\n' \
          "$CH" "$CU" "$(obscure "$CPW")" "${CP:-445}"; [[ -n "$CD" ]] && printf 'domain = %s\n' "$CD"; } > "$RCLONE_CONF"
      UP_PATH="$CS/$ETCD_KEY_PREFIX"
      ;;
    *)
      fail "Offline restore: unknown descriptor storageType '$STORAGE_TYPE' (expected s3 | ssh | cifs)."
      ;;
  esac
  # The creds now live only in the rendered rclone.conf; drop the JSON blob. (MEDIUM-3)
  unset DESC_JSON
  REMOTE_BASE="upstream:$UP_PATH"
  log "OFFLINE mode — reading DIRECTLY from the upstream ($STORAGE_TYPE), no cluster: $REMOTE_BASE/"
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

  # Credentials go via env (rclone_up), NOT argv — see HIGH-1 above.
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
  REMOTE_BASE=":s3:system/$ETCD_PREFIX"
fi

# ── List ─────────────────────────────────────────────────────────────
if [[ "$MODE" == "list" ]]; then
  log "Available etcd snapshots in $REMOTE_BASE/:"
  rclone_up lsf "$REMOTE_BASE/" \
    | grep '\.db$' \
    | sort
  exit 0
fi

# ── Resolve target snapshot ──────────────────────────────────────────
if [[ "$MODE" == "latest" ]]; then
  SNAP_NAME=$(rclone_up lsf "$REMOTE_BASE/" \
    | grep '\.db$' \
    | sort -r | head -1)
  if [[ -z "$SNAP_NAME" ]]; then
    fail "No etcd snapshots found in $REMOTE_BASE/. Has the etcd-snap-via-shim CronJob run yet? Check kubectl -n platform get cronjob etcd-snap-via-shim"
  fi
  log "Resolved --latest → $SNAP_NAME"
fi

DEST=/var/lib/rancher/k3s/server/db/snapshots/restore-from-shim-$(date -u +%Y%m%d-%H%M%S).db
log "Will download $REMOTE_BASE/$SNAP_NAME → $DEST"

if [[ $DRY_RUN -eq 1 ]]; then
  log "DRY-RUN — skipping download + restore"
  exit 0
fi

# ── Download ────────────────────────────────────────────────────────
log "Downloading snapshot..."
if ! rclone_up copyto "$REMOTE_BASE/$SNAP_NAME" "$DEST"; then
  fail "rclone download failed"
fi
log "Downloaded $(du -h "$DEST" | cut -f1) to $DEST"

# Optional: download + verify .meta sidecar
META_DEST="$DEST.meta"
if rclone_up copyto "$REMOTE_BASE/$SNAP_NAME.meta" "$META_DEST" 2>/dev/null; then
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
# k3s has NO `etcd-snapshot restore` subcommand (only save/ls) — the
# documented embedded-etcd restore is `k3s server --cluster-reset
# --cluster-reset-restore-path=<abs path>` (same as restore-etcd-local.sh +
# dr-restore.sh). cluster-reset resets to a single-node cluster from the
# snapshot, then a normal start brings it back. (Proven by the DR drill;
# the old `etcd-snapshot restore` line never existed.)
log "Stopping k3s..."
systemctl stop k3s 2>/dev/null || true

log "Restoring etcd snapshot via k3s cluster-reset..."
if ! k3s server --cluster-reset --cluster-reset-restore-path="$DEST"; then
  fail "k3s cluster-reset restore failed. The on-disk snapshot is at $DEST — operator can retry manually."
fi

log "Starting k3s..."
systemctl start k3s

log "etcd restore COMPLETE. The cluster is now in the post-restore state."
log "Verify with: kubectl get nodes; kubectl -n platform get pods"
log ""
log "If the restored cluster is missing recent changes (last few hours),"
log "verify the snapshot timestamp matches your RPO target. List with:"
log "  ./scripts/restore-etcd-from-shim.sh --list"
