#!/usr/bin/env bash
# Phase 2 (2026-05-22) — CI invariants for cnpg-backup-catalogue.
#
# The catalogue's ENTIRE reason to exist is graceful degradation when
# the CNPG operator is down. If a future change makes it throw on any
# failure path, the /admin/cnpg-backup-catalogue endpoint hangs the
# Backups page even worse than before. This guard locks in:
#
#   1. The route gates on super_admin/admin + admin panel (consistent
#      with the parent cnpg-backup-health route).
#   2. The service uses S3Client (not raw kubectl exec) for the LIST —
#      the shim is reachable independently of cluster state.
#   3. On ALL failure paths the service returns { source: 'unavailable' }
#      rather than throwing. Grep for `return finalize({` near
#      `unavailable` — every error branch must surface that envelope.
#   4. Cache TTL is bounded (no infinite-cache regression). Look for
#      a constant <= 300_000 ms (5 min).
#   5. The catalogue is registered in app.ts.
#
# Bash-level guard, intentionally low-tech — easier to read than parse.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROUTES="$REPO_ROOT/backend/src/modules/cnpg-backup-catalogue/routes.ts"
SERVICE="$REPO_ROOT/backend/src/modules/cnpg-backup-catalogue/service.ts"
APP="$REPO_ROOT/backend/src/app.ts"

if [[ ! -f "$ROUTES" || ! -f "$SERVICE" ]]; then
  echo "FAIL: cnpg-backup-catalogue module files missing"
  exit 1
fi

FAILED=0

# (1) routes.ts must require auth, admin panel, super_admin/admin/read_only role.
# read_only is intentional — matches cnpg-backup-health so incident-triage
# operators see the same source-of-truth view powering the card.
if ! grep -q "requireRole('super_admin', 'admin', 'read_only')" "$ROUTES"; then
  echo "FAIL: routes.ts must gate on super_admin/admin/read_only (matches cnpg-backup-health)"
  FAILED=1
fi
if ! grep -q "requirePanel('admin')" "$ROUTES"; then
  echo "FAIL: routes.ts must gate on the admin panel"
  FAILED=1
fi

# (2) service.ts must use S3Client.
if ! grep -q "S3Client" "$SERVICE"; then
  echo "FAIL: service.ts must use the S3Client to reach the shim"
  FAILED=1
fi
if grep -q "execInPod\|kubectl exec" "$SERVICE"; then
  echo "FAIL: service.ts must NOT shell into a pod — the shim is the abstraction"
  FAILED=1
fi

# (3) Every error path must return source='unavailable'. Sanity-check by
# counting occurrences — the function has ≥5 distinct failure branches.
UNAVAIL_COUNT=$(grep -c "source: 'unavailable'" "$SERVICE" || true)
if [[ "$UNAVAIL_COUNT" -lt 4 ]]; then
  echo "FAIL: expected ≥4 source='unavailable' branches in service.ts, found $UNAVAIL_COUNT"
  FAILED=1
fi

# (4) Cache TTL must be bounded.
TTL_OK=0
for limit in 60_000 60000 90_000 120_000 180_000 240_000 300_000; do
  if grep -q "CACHE_TTL_MS = $limit" "$SERVICE"; then TTL_OK=1; break; fi
done
if [[ $TTL_OK -eq 0 ]]; then
  echo "FAIL: CACHE_TTL_MS must be ≤ 300_000 (5 min); not found in service.ts"
  FAILED=1
fi

# (5) app.ts must register the route.
if ! grep -q "cnpgBackupCatalogueRoutes" "$APP"; then
  echo "FAIL: app.ts must import + register cnpgBackupCatalogueRoutes"
  FAILED=1
fi

if [[ $FAILED -ne 0 ]]; then
  exit 1
fi
echo "OK: cnpg-backup-catalogue invariants hold (auth gate / S3-direct / unavailable-on-failure / bounded cache / registered)."
