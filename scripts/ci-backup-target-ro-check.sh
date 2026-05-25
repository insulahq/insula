#!/usr/bin/env bash
# DR safety: every backup write/delete callsite against a target row
# MUST call requireWritableTarget() OR carry an explicit
# `// RO-EXEMPT: <reason>` annotation on the line that does the write.
#
# This guard locks in the enforcement coverage shipped in A1 Phase B
# so a future contributor adding a new write path doesn't silently
# bypass the read_only flag (which would let a freshly DR-restored
# cluster overwrite/prune the very repo it just restored from).
#
# The list of known enforcement sites is hard-coded below — each entry
# is a `file:symbol` pair the guard verifies contains the helper call.
# CI fails loudly when:
#   - A registered site no longer references requireWritableTarget.
#   - A backup-touching module is added (matched by path) that does
#     NOT appear in REGISTERED_SITES and does NOT carry the exemption
#     annotation.
#
# Companion: backend/src/modules/backup-config/writable-guard.ts is the
# helper definition; backend/src/modules/backup-config/writable-guard.test.ts
# is its unit test.
#
# Exit 1 on any offending site.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

# ─── Registered enforcement sites (A1 Phase B + C shipped) ───────────
# Format: <file path>::<grep pattern that should appear>
# Pattern can be either `requireWritableTarget` (the helper) or
# `TargetFrozenError` (a direct throw using the error class — used in
# service.ts deleteBackupConfig / updateBackupConfig where we already
# have the row in hand from getRawBackupConfig so the helper's extra
# SELECT would be redundant).
REGISTERED_SITES=(
  "backend/src/modules/backup-config/speedtest.ts::requireWritableTarget"
  "backend/src/modules/backup-config/service.ts::TargetFrozenError"
  "backend/src/modules/tenant-bundles/orchestrator.ts::requireWritableTarget"
  "backend/src/modules/tenant-bundles/retention.ts::requireWritableTarget"
  "backend/src/modules/tenant-bundles/routes.ts::requireWritableTarget"
  "backend/src/modules/storage-lifecycle/service.ts::requireWritableTarget"
  "backend/src/modules/mail-admin/snapshot.ts::requireWritableTarget"
  "backend/src/modules/system-backup/pg-dump-orchestrator.ts::requireWritableTarget"
  "backend/src/modules/system-backup/pg-dump-routes.ts::requireWritableTarget"
)

FAIL=0

# 1. Every registered site must still contain its requireWritableTarget call.
for entry in "${REGISTERED_SITES[@]}"; do
  file="${entry%%::*}"
  pattern="${entry##*::}"
  if [[ ! -f "$file" ]]; then
    echo "ERROR: registered enforcement site missing: $file" >&2
    FAIL=1
    continue
  fi
  if ! grep -q "$pattern" "$file"; then
    echo "ERROR: $file no longer references '$pattern'" >&2
    echo "       This file is a known backup write/delete entry point." >&2
    echo "       Restore the requireWritableTarget(...) call, OR" >&2
    echo "       remove the file from REGISTERED_SITES in this guard" >&2
    echo "       and add a '// RO-EXEMPT: <reason>' annotation explaining" >&2
    echo "       why the write path no longer needs the guard." >&2
    FAIL=1
  fi
done

# 2. Drift detector: any module under the known backup-writing
#    subtrees that performs a `store.delete` / `store.put` / `rclone`
#    write but is NOT in REGISTERED_SITES and does NOT carry the
#    `RO-EXEMPT` annotation is flagged.
#
#    Scoped narrowly to the subtrees that actually own backup-target
#    writes to avoid false positives in unrelated code (e.g. tenant
#    file uploads, which target tenant PVCs, not backup targets).
WATCH_SUBTREES=(
  "backend/src/modules/backup-config"
  "backend/src/modules/tenant-bundles"
  "backend/src/modules/storage-lifecycle"
  "backend/src/modules/mail-admin"
  "backend/src/modules/backup-rclone-shim"
  "backend/src/modules/system-backup"
)

# Heuristic markers — when any of these appear in a .ts file, that file
# is plausibly a write/delete callsite. (We never block on test files
# or *.test.ts.) Extended after security review:
#   - `db\.delete\(backupConfigurations` — hard delete of a target row;
#     a frozen target row deletion would orphan the upstream repo.
#   - `set\(.*Encrypted` — mutating any encrypted credential field
#     (sshKeyEncrypted / s3SecretKeyEncrypted / cifsPasswordEncrypted)
#     could silently redirect a frozen target's writes post-unfreeze.
WRITE_MARKERS='store\.delete\(|store\.put\(|barmanObjectStore|resticForget|rcloneRcat|--remove-source-files|db\.delete\(backupConfigurations|set\(.*Encrypted'

for subtree in "${WATCH_SUBTREES[@]}"; do
  while IFS= read -r file; do
    # Skip test files.
    [[ "$file" == *.test.ts ]] && continue
    # Skip files already in the registered list.
    skip=false
    for entry in "${REGISTERED_SITES[@]}"; do
      reg_file="${entry%%::*}"
      if [[ "$file" == "$reg_file" ]]; then
        skip=true; break
      fi
    done
    [[ "$skip" == "true" ]] && continue
    # Skip files that carry the exemption annotation.
    if grep -q 'RO-EXEMPT' "$file"; then continue; fi
    # Otherwise — flag.
    if grep -qE "$WRITE_MARKERS" "$file"; then
      echo "WARN: possible new backup write/delete site (not in REGISTERED_SITES)" >&2
      echo "      file: $file" >&2
      echo "      Either add a requireWritableTarget(...) call AND register" >&2
      echo "      this file in REGISTERED_SITES above, OR annotate the write" >&2
      echo "      with '// RO-EXEMPT: <reason>'." >&2
      FAIL=1
    fi
  done < <(find "$subtree" -type f -name '*.ts' 2>/dev/null)
done

if [[ $FAIL -ne 0 ]]; then
  echo "" >&2
  echo "scripts/ci-backup-target-ro-check.sh: enforcement gaps detected" >&2
  exit 1
fi

echo "ci-backup-target-ro-check: ${#REGISTERED_SITES[@]} registered sites OK"
