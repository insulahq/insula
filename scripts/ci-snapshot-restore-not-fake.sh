#!/usr/bin/env bash
# Phase 1 (2026-05-22) — CI invariant for the CNPG snapshot Restore wiring.
#
# The CNPG branch in SystemSnapshotsModal.tsx used to navigate to the
# DR shell-instructions page. The operator called this "fake" — the
# button claimed to restore but didn't. Phase 1 wired it to the real
# POST /admin/postgres-restore endpoint via the RestorationWizard.
#
# This guard blocks regression: if anyone reintroduces a navigate() to
# /backups/disaster-recovery inside the CNPG snapshot Restore button,
# CI fails with a clear message.
#
# Invariants enforced (all must hold):
#   1. SystemSnapshotsModal.tsx imports RestorationWizard.
#   2. SystemSnapshotsModal.tsx imports useStartPitr from the
#      postgres-restore hook.
#   3. The file does NOT contain a navigate() to disaster-recovery in
#      the CNPG snapshot Restore branch (search the whole file — narrow
#      branches drift over time; we just want the navigate string gone).
#   4. The setPitrSnap state setter exists (sentinel for the new wiring).

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$REPO_ROOT/frontend/admin-panel/src/components/SystemSnapshotsModal.tsx"

if [[ ! -f "$TARGET" ]]; then
  echo "FAIL: $TARGET not found"
  exit 1
fi

FAILED=0

if ! grep -q "from '@/components/backups/RestorationWizard'" "$TARGET"; then
  echo "FAIL: SystemSnapshotsModal.tsx missing import of RestorationWizard"
  FAILED=1
fi

if ! grep -q "useStartPitr" "$TARGET"; then
  echo "FAIL: SystemSnapshotsModal.tsx missing useStartPitr hook"
  FAILED=1
fi

if grep -q "navigate('/backups/disaster-recovery" "$TARGET"; then
  echo "FAIL: SystemSnapshotsModal.tsx still navigates to disaster-recovery —"
  echo "      the CNPG snapshot Restore button must call POST /admin/postgres-restore"
  echo "      via the wizard, not redirect to shell instructions."
  FAILED=1
fi

if ! grep -q "setPitrSnap" "$TARGET"; then
  echo "FAIL: SystemSnapshotsModal.tsx missing setPitrSnap state — wizard wiring removed?"
  FAILED=1
fi

if [[ $FAILED -ne 0 ]]; then
  exit 1
fi
echo "OK: CNPG snapshot Restore is wired to the real PITR endpoint via RestorationWizard."
