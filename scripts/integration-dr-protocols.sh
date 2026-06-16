#!/usr/bin/env bash
# integration-dr-protocols.sh — prove the OFFLINE etcd break-glass restore
# (restore-etcd-from-shim.sh --offline) actually connects + reads from a REAL
# upstream over EVERY shim-supported protocol: S3, SFTP, CIFS/SMB.
#
# For each protocol whose creds are provided, it builds a DR descriptor pointing
# at the real store, uploads a marker etcd-snapshot to the cluster_id-namespaced
# path, runs `--offline --descriptor --list` (NO kubectl — KUBECTL=/bin/false)
# and asserts the marker is listed, then cleans up. The cluster-DOWN READ path
# against real endpoints. NON-destructive (never restores etcd).
#
# Runs ON a node that has rclone + python3 (any bootstrapped node). All rclone /
# obscure / decrypt happens node-side; the workstation only builds descriptors.
# Credentials come from the environment (never committed) — redact in any output.
#
# USAGE (set SSH_HOST + creds for the protocols you want covered):
#   SSH_HOST=root@<node> SSH_KEY=~/hosting-platform.key \
#   S3_ENDPOINT=… S3_BUCKET=… S3_REGION=… S3_ACCESS_KEY=… S3_SECRET_KEY=… \
#   SFTP_HOST=… SFTP_PORT=23 SFTP_USER=… SFTP_KEY=~/key   (or SFTP_PASS=…) \
#   CIFS_HOST=… CIFS_SHARE=… CIFS_USER=… CIFS_PASS=… [CIFS_PORT=445] \
#   ./scripts/integration-dr-protocols.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_HOST="${SSH_HOST:?set SSH_HOST=root@<node-with-rclone>}"
SHIM_BIN="${SHIM_BIN:-/tmp/restore-etcd-from-shim.sh}"
CID="proto-$(date +%s)"
PREFIX="dr-proto-test/system/etcd/$CID"

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YEL='\033[33m'; RESET='\033[0m'
log()  { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail() { printf '  %b✗%b %s\n' "$RED" "$RESET" "$*"; failed=$((failed+1)); }
skip() { printf '  %b•%b SKIP %s\n' "$YEL" "$RESET" "$*"; }
passed=0; failed=0
ssh_n() { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=25 -q "$SSH_HOST" "$@"; }

scp -i "$SSH_KEY" -o StrictHostKeyChecking=no -q "$SCRIPT_DIR/restore-etcd-from-shim.sh" "$SSH_HOST:$SHIM_BIN" \
  || { echo "scp of restore-etcd-from-shim.sh failed" >&2; exit 2; }

# Node-side worker: reads the descriptor on stdin, builds an upload rclone.conf
# from it (obscuring sftp/smb pass with rclone, node-side), uploads a marker to
# the descriptor's path, runs the SCRIPT's offline --list, prints assertions,
# cleans up. Kept here (not on the workstation) so no creds touch the harness host.
NODE_WORKER='
set -u; umask 077
D=/dev/shm/dr-proto-desc.json; cat > "$D"
CONF=/dev/shm/dr-proto-up.conf; KEYF=/dev/shm/dr-proto-up.key
get(){ python3 -c "import json,os,sys;print(json.load(open(\"$D\")).get(os.environ[\"K\"],\"\") or \"\")" ; }
ST=$(K=storageType get); KP=$(K=etcdKeyPrefix get)
case "$ST" in
  s3)
    EP=$(K=s3Endpoint get); RG=$(K=s3Region get); BK=$(K=s3Bucket get); AK=$(K=s3AccessKey get); SK=$(K=s3SecretKey get)
    printf "[up]\ntype = s3\nprovider = Other\nendpoint = %s\nregion = %s\naccess_key_id = %s\nsecret_access_key = %s\nforce_path_style = true\nno_check_bucket = true\n" "$EP" "${RG:-auto}" "$AK" "$SK" > "$CONF"
    UP="up:$BK/$KP" ;;
  ssh)
    H=$(K=sshHost get); PO=$(K=sshPort get); U=$(K=sshUser get); KEY=$(K=sshKey get); PW=$(K=sshPassword get)
    printf "[up]\ntype = sftp\nhost = %s\nuser = %s\nport = %s\nshell_type = unix\n" "$H" "$U" "${PO:-22}" > "$CONF"
    if [ -n "$KEY" ]; then printf "%s\n" "$KEY" > "$KEYF"; chmod 600 "$KEYF"; printf "key_file = %s\n" "$KEYF" >> "$CONF";
    else printf "pass = %s\n" "$(rclone obscure "$PW" 2>/dev/null)" >> "$CONF"; fi
    UP="up:$KP" ;;
  cifs)
    H=$(K=cifsHost get); PO=$(K=cifsPort get); SH=$(K=cifsShare get); U=$(K=cifsUser get); PW=$(K=cifsPassword get)
    printf "[up]\ntype = smb\nhost = %s\nuser = %s\npass = %s\nport = %s\n" "$H" "$U" "$(rclone obscure "$PW" 2>/dev/null)" "${PO:-445}" > "$CONF"
    UP="up:$SH/$KP" ;;
  *) echo "WORKER_BAD_TYPE=$ST"; exit 9 ;;
esac
chmod 600 "$CONF"
M="marker-$(date +%s).db"; head -c 64 /dev/urandom > /dev/shm/dr-proto-m.db
timeout 40 rclone --config "$CONF" copyto /dev/shm/dr-proto-m.db "$UP/$M" 2>/dev/null || { echo HARNESS_UPLOAD_FAILED; }
# The thing under test, ONCE: offline list with NO kubectl.
OUT=$(KUBECTL=/bin/false timeout 40 bash "'"$SHIM_BIN"'" --offline --descriptor "$D" --list 2>&1)
echo "$OUT"
echo "LISTED_MARKER=$(echo "$OUT" | grep -c "$M")"
timeout 30 rclone --config "$CONF" delete "$UP/$M" 2>/dev/null || true
shred -u "$D" "$CONF" "$KEYF" /dev/shm/dr-proto-m.db 2>/dev/null || rm -f "$D" "$CONF" "$KEYF" /dev/shm/dr-proto-m.db
'

run_protocol() { # $1=label  $2=descriptor-json
  log "── $1 (offline, real store) ──"
  local out; out=$(printf '%s' "$2" | ssh_n "$NODE_WORKER" 2>&1)
  if echo "$out" | grep -q 'HARNESS_UPLOAD_FAILED'; then
    fail "$1: could not upload the marker to the real store (creds/connectivity?)"; return
  fi
  echo "$out" | grep -q 'OFFLINE mode' \
    && ok "$1: offline restore resolved the descriptor + connected (no kubectl)" \
    || fail "$1: offline did not resolve: $(echo "$out" | tr '\n' ' ' | head -c 160)"
  echo "$out" | grep -q 'LISTED_MARKER=1' \
    && ok "$1: offline --list returned the marker from the REAL $1 store" \
    || fail "$1: offline --list did not return the marker ($(echo "$out" | grep LISTED_MARKER))"
}

mkdesc() { python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)))"; }

# ── S3 ──
if [[ -n "${S3_ENDPOINT:-}" && -n "${S3_BUCKET:-}" && -n "${S3_ACCESS_KEY:-}" && -n "${S3_SECRET_KEY:-}" ]]; then
  D=$(S3_ENDPOINT="$S3_ENDPOINT" S3_REGION="${S3_REGION:-auto}" S3_BUCKET="$S3_BUCKET" S3_ACCESS_KEY="$S3_ACCESS_KEY" S3_SECRET_KEY="$S3_SECRET_KEY" CID="$CID" PREFIX="$PREFIX" python3 -c '
import json,os
print(json.dumps({"version":1,"clusterId":os.environ["CID"],"storageType":"s3","s3Endpoint":os.environ["S3_ENDPOINT"],"s3Region":os.environ["S3_REGION"],"s3Bucket":os.environ["S3_BUCKET"],"s3AccessKey":os.environ["S3_ACCESS_KEY"],"s3SecretKey":os.environ["S3_SECRET_KEY"],"s3UsePathStyle":True,"etcdKeyPrefix":os.environ["PREFIX"],"generatedAt":"t"}))')
  run_protocol "S3" "$D"
else skip "S3 — set S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY"; fi

# ── SFTP ──
if [[ -n "${SFTP_HOST:-}" && -n "${SFTP_USER:-}" ]]; then
  if [[ -n "${SFTP_KEY:-}" && -f "$SFTP_KEY" ]]; then
    D=$(SFTP_HOST="$SFTP_HOST" SFTP_PORT="${SFTP_PORT:-22}" SFTP_USER="$SFTP_USER" CID="$CID" PREFIX="$PREFIX" SFTP_KEY_CONTENT="$(cat "$SFTP_KEY")" python3 -c '
import json,os
print(json.dumps({"version":1,"clusterId":os.environ["CID"],"storageType":"ssh","sshHost":os.environ["SFTP_HOST"],"sshPort":int(os.environ["SFTP_PORT"]),"sshUser":os.environ["SFTP_USER"],"sshKey":os.environ["SFTP_KEY_CONTENT"],"etcdKeyPrefix":os.environ["PREFIX"],"generatedAt":"t"}))')
    run_protocol "SFTP" "$D"
  elif [[ -n "${SFTP_PASS:-}" ]]; then
    D=$(SFTP_HOST="$SFTP_HOST" SFTP_PORT="${SFTP_PORT:-22}" SFTP_USER="$SFTP_USER" SFTP_PASS="$SFTP_PASS" CID="$CID" PREFIX="$PREFIX" python3 -c '
import json,os
print(json.dumps({"version":1,"clusterId":os.environ["CID"],"storageType":"ssh","sshHost":os.environ["SFTP_HOST"],"sshPort":int(os.environ["SFTP_PORT"]),"sshUser":os.environ["SFTP_USER"],"sshPassword":os.environ["SFTP_PASS"],"etcdKeyPrefix":os.environ["PREFIX"],"generatedAt":"t"}))')
    run_protocol "SFTP" "$D"
  else skip "SFTP — provide SFTP_KEY <file> or SFTP_PASS"; fi
else skip "SFTP — set SFTP_HOST/SFTP_USER (+ SFTP_KEY or SFTP_PASS)"; fi

# ── CIFS / SMB ──
if [[ -n "${CIFS_HOST:-}" && -n "${CIFS_SHARE:-}" && -n "${CIFS_USER:-}" && -n "${CIFS_PASS:-}" ]]; then
  D=$(CIFS_HOST="$CIFS_HOST" CIFS_SHARE="$CIFS_SHARE" CIFS_USER="$CIFS_USER" CIFS_PASS="$CIFS_PASS" CIFS_PORT="${CIFS_PORT:-445}" CID="$CID" PREFIX="$PREFIX" python3 -c '
import json,os
print(json.dumps({"version":1,"clusterId":os.environ["CID"],"storageType":"cifs","cifsHost":os.environ["CIFS_HOST"],"cifsShare":os.environ["CIFS_SHARE"],"cifsUser":os.environ["CIFS_USER"],"cifsPassword":os.environ["CIFS_PASS"],"cifsPort":int(os.environ["CIFS_PORT"]),"etcdKeyPrefix":os.environ["PREFIX"],"generatedAt":"t"}))')
  run_protocol "CIFS" "$D"
else skip "CIFS — set CIFS_HOST/CIFS_SHARE/CIFS_USER/CIFS_PASS"; fi

echo
printf '%b== DR protocols (offline) E2E: %d passed, %d failed ==%b\n' "$CYAN" "$passed" "$failed" "$RESET"
[[ "$failed" -eq 0 ]] || exit 1
