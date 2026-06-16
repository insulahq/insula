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

# ── stub bin dir: a no-op rclone that reports cred exposure on stderr ──
STUB="$WORK/bin"; mkdir -p "$STUB"
cat > "$STUB/rclone" <<'SH'
#!/bin/sh
echo "STUB-RCLONE argv-has-secret=$(echo "$*" | grep -c 'SEKRET') env-secret=${RCLONE_S3_SECRET_ACCESS_KEY:+yes}" >&2
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

# ── restore-etcd-from-shim.sh --offline ───────────────────────────────
mk_desc() { # $1=etcdKeyPrefix
  cat > "$WORK/desc.json" <<JSON
{"version":1,"clusterId":"cid","storageType":"s3","s3Endpoint":"https://s3.example.test","s3Region":"r","s3Bucket":"bkt","s3AccessKey":"AKID","s3SecretKey":"SEKRET","s3UsePathStyle":true,"etcdKeyPrefix":"$1","generatedAt":"t"}
JSON
}

# dry-run --name makes NO rclone/kubectl call: pure descriptor → path proof.
mk_desc "platform-backups/system/etcd/cid"
out=$(PATH="$STUB:$PATH" KUBECTL=/bin/false bash "$SHIM" --offline --descriptor "$WORK/desc.json" --dry-run --name snap.db 2>&1); rc=$?
[[ "$rc" -eq 0 ]] && echo "$out" | grep -q ':s3:bkt/platform-backups/system/etcd/cid/snap.db' \
  && ok "offline resolves the exact upstream path with NO kubectl (KUBECTL=/bin/false)" \
  || bad "offline path resolution failed (rc=$rc): $out"

# --list calls rclone_s3: secret MUST be in env, NEVER argv (HIGH-1).
mk_desc "system/etcd/cid"  # bucket-root form (no operator prefix)
out=$(PATH="$STUB:$PATH" KUBECTL=/bin/false bash "$SHIM" --offline --descriptor "$WORK/desc.json" --list 2>&1)
echo "$out" | grep -q 'argv-has-secret=0' && echo "$out" | grep -q 'env-secret=yes' \
  && ok "offline passes the S3 secret via ENV, not argv (no /proc/<pid>/cmdline leak)" \
  || bad "offline secret exposure check failed: $out"
echo "$out" | grep -qi 'FAIL' && bad "offline --list (bucket-root prefix) was wrongly refused" \
  || ok "offline accepts the bucket-root 'system/etcd/<id>' prefix"

# A bare/un-namespaced prefix MUST be refused (cross-cluster footgun).
mk_desc "etcd"
out=$(PATH="$STUB:$PATH" KUBECTL=/bin/false bash "$SHIM" --offline --descriptor "$WORK/desc.json" --list 2>&1); rc=$?
[[ "$rc" -ne 0 ]] && echo "$out" | grep -qi 'non-namespaced' \
  && ok "offline REFUSES a non-namespaced etcd prefix" || bad "offline failed to refuse a bare prefix (rc=$rc)"

# A non-S3 descriptor is rejected with a clear message (S3-only offline today).
cat > "$WORK/desc.json" <<'JSON'
{"version":1,"clusterId":"cid","storageType":"ssh","sshHost":"h","sshUser":"u","etcdKeyPrefix":"b/system/etcd/cid","generatedAt":"t"}
JSON
out=$(PATH="$STUB:$PATH" KUBECTL=/bin/false bash "$SHIM" --offline --descriptor "$WORK/desc.json" --list 2>&1); rc=$?
[[ "$rc" -ne 0 ]] && echo "$out" | grep -qi 'S3 upstreams only' \
  && ok "offline rejects non-S3 upstreams with guidance" || bad "offline non-S3 handling wrong (rc=$rc)"

echo
printf '== dr-break-glass tests: %d passed, %d failed ==\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]] || exit 1
