#!/usr/bin/env bash
# test-dr-break-glass.sh — fast, hermetic unit tests for the DR break-glass
# restore scripts. No cluster, no real rclone/age: stubs + fixtures only.
# Covers:
#   * restore-etcd-local.sh    — list / dry-run / name / empty-dir
#   * restore-etcd-from-shim.sh --offline — descriptor parse + path resolution
#     with KUBECTL=/bin/false (proves ZERO cluster dependency), secret via ENV
#     not argv (HIGH-1), and the cluster_id-namespacing guard.
#
# Run: ./scripts/test-dr-break-glass.sh   (exit 0 = all pass)
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL="$DIR/restore-etcd-local.sh"
SHIM="$DIR/restore-etcd-from-shim.sh"
pass=0; fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }

WORK=$(mktemp -d /tmp/dr-bg-test.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

# ── stub bin dir: a no-op rclone that (a) fakes `obscure`, (b) captures the
# rendered --config so the test can inspect creds-in-conf, (c) logs its argv. ──
STUB="$WORK/bin"; mkdir -p "$STUB"
cat > "$STUB/rclone" <<'SH'
#!/bin/sh
# `rclone obscure <pass>` → deterministic fake (offline renders sftp/smb pass).
[ "$1" = "obscure" ] && { echo "OBSCURED:$2"; exit 0; }
# Capture the rendered rclone.conf (passed via --config) before it's shredded.
prev=
for a in "$@"; do
  [ "$prev" = "--config" ] && cp "$a" "${RCLONE_CONF_CAPTURE:-/dev/null}" 2>/dev/null
  prev="$a"
done
echo "STUB-RCLONE args=[$*]" >&2
exit 0
SH
chmod +x "$STUB/rclone"

# ── restore-etcd-local.sh ─────────────────────────────────────────────
SNAPS="$WORK/snaps"; mkdir -p "$SNAPS/.metadata"
printf 'older' > "$SNAPS/etcd-snapshot-n-100"; touch -d '2026-06-15 01:00' "$SNAPS/etcd-snapshot-n-100"
printf 'newest' > "$SNAPS/etcd-snapshot-n-200"; touch -d '2026-06-15 02:00' "$SNAPS/etcd-snapshot-n-200"
printf 'x' > "$SNAPS/.metadata/m"

out=$(SNAP_DIR="$SNAPS" bash "$LOCAL" --list 2>&1)
echo "$out" | grep -q 'etcd-snapshot-n-200' && echo "$out" | grep -q 'etcd-snapshot-n-100' \
  && ok "local --list shows both snapshots" || bad "local --list missing snapshots"
echo "$out" | grep -q '.metadata' && bad "local --list leaked the .metadata dir" || ok "local --list excludes .metadata"

out=$(SNAP_DIR="$SNAPS" bash "$LOCAL" --dry-run --latest 2>&1)
echo "$out" | grep -q 'etcd-snapshot-n-200' \
  && ok "local --latest resolves the NEWEST snapshot" || bad "local --latest picked the wrong snapshot"

out=$(SNAP_DIR="$WORK/empty" bash "$LOCAL" --latest 2>&1); rc=$?
[[ "$rc" -ne 0 ]] && echo "$out" | grep -qi 'no local snapshots' \
  && ok "local --latest on empty dir fails with a clear message" || bad "local empty-dir handling wrong (rc=$rc)"

# ── restore-etcd-from-shim.sh --offline (multi-protocol: s3 / sftp / cifs) ──
export RCLONE_CONF_CAPTURE="$WORK/captured.conf"
mk_s3()   { printf '{"version":1,"clusterId":"cid","storageType":"s3","s3Endpoint":"https://s3.example.test","s3Region":"r","s3Bucket":"bkt","s3AccessKey":"AKID","s3SecretKey":"SEKRET","s3UsePathStyle":true,"etcdKeyPrefix":"%s","generatedAt":"t"}' "$1" > "$WORK/desc.json"; }
mk_sftp() { printf '{"version":1,"clusterId":"cid","storageType":"ssh","sshHost":"sftp.example.test","sshPort":23,"sshUser":"u1","sshPassword":"SFTPSEK","etcdKeyPrefix":"%s","generatedAt":"t"}' "$1" > "$WORK/desc.json"; }
mk_cifs() { printf '{"version":1,"clusterId":"cid","storageType":"cifs","cifsHost":"box.example.test","cifsShare":"share1","cifsUser":"u1","cifsPassword":"CIFSSEK","cifsPort":445,"etcdKeyPrefix":"%s","generatedAt":"t"}' "$1" > "$WORK/desc.json"; }
run_off() { PATH="$STUB:$PATH" KUBECTL=/bin/false bash "$SHIM" --offline --descriptor "$WORK/desc.json" "$@" 2>&1; }

# S3 — dry-run --name makes NO rclone/kubectl call: pure descriptor→path proof.
mk_s3 "platform-backups/system/etcd/cid"
out=$(run_off --dry-run --name snap.db); rc=$?
[[ "$rc" -eq 0 ]] && echo "$out" | grep -q 'upstream:bkt/platform-backups/system/etcd/cid/snap.db' \
  && ok "offline S3 resolves the exact upstream path, NO kubectl (KUBECTL=/bin/false)" \
  || bad "offline S3 path resolution failed (rc=$rc): $out"
# S3 --list — creds in the rendered rclone.conf, NEVER in rclone argv (HIGH-1).
rm -f "$RCLONE_CONF_CAPTURE"; mk_s3 "system/etcd/cid"
out=$(run_off --list)
{ echo "$out" | grep -q 'args=\[' && ! echo "$out" | grep -q 'SEKRET'; } \
  && ok "offline S3 keeps the secret OUT of rclone argv" || bad "offline S3 leaked the secret to argv: $out"
{ [[ -f "$RCLONE_CONF_CAPTURE" ]] && grep -q 'type = s3' "$RCLONE_CONF_CAPTURE" && grep -q 'SEKRET' "$RCLONE_CONF_CAPTURE"; } \
  && ok "offline S3 renders rclone.conf type=s3 with the secret in the file" || bad "offline S3 rclone.conf wrong"

# SFTP — type=sftp, path = upstream:<prefix>, pass obscured in conf.
rm -f "$RCLONE_CONF_CAPTURE"; mk_sftp "backups/system/etcd/cid"
out=$(run_off --list)
echo "$out" | grep -qi 'FAIL' && bad "offline SFTP wrongly refused: $out" || ok "offline SFTP accepted"
echo "$out" | grep -q 'upstream:backups/system/etcd/cid' && ok "offline SFTP path = upstream:<prefix>" || bad "offline SFTP path wrong: $out"
{ [[ -f "$RCLONE_CONF_CAPTURE" ]] && grep -q 'type = sftp' "$RCLONE_CONF_CAPTURE" && grep -q 'pass = OBSCURED:' "$RCLONE_CONF_CAPTURE"; } \
  && ok "offline SFTP renders type=sftp with an obscured pass" || bad "offline SFTP rclone.conf wrong"

# CIFS — type=smb, path = upstream:<share>/<prefix>, pass obscured.
rm -f "$RCLONE_CONF_CAPTURE"; mk_cifs "etcdbk/system/etcd/cid"
out=$(run_off --list)
echo "$out" | grep -qi 'FAIL' && bad "offline CIFS wrongly refused: $out" || ok "offline CIFS accepted"
echo "$out" | grep -q 'upstream:share1/etcdbk/system/etcd/cid' && ok "offline CIFS path = upstream:<share>/<prefix>" || bad "offline CIFS path wrong: $out"
{ [[ -f "$RCLONE_CONF_CAPTURE" ]] && grep -q 'type = smb' "$RCLONE_CONF_CAPTURE" && grep -q 'pass = OBSCURED:' "$RCLONE_CONF_CAPTURE"; } \
  && ok "offline CIFS renders type=smb with an obscured pass" || bad "offline CIFS rclone.conf wrong"

# A bare/un-namespaced prefix MUST be refused (cross-cluster footgun).
mk_s3 "etcd"
out=$(run_off --list); rc=$?
[[ "$rc" -ne 0 ]] && echo "$out" | grep -qi 'non-namespaced' \
  && ok "offline REFUSES a non-namespaced etcd prefix" || bad "offline failed to refuse a bare prefix (rc=$rc)"

# An unknown storageType is rejected with guidance.
printf '{"version":1,"clusterId":"cid","storageType":"ftp","etcdKeyPrefix":"b/system/etcd/cid","generatedAt":"t"}' > "$WORK/desc.json"
out=$(run_off --list); rc=$?
[[ "$rc" -ne 0 ]] && echo "$out" | grep -qi 'unknown descriptor storageType' \
  && ok "offline rejects an unknown storageType" || bad "offline unknown-type handling wrong (rc=$rc)"

echo
printf '== dr-break-glass tests: %d passed, %d failed ==\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]] || exit 1
