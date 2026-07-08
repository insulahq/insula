/**
 * React Query hooks for R20 cross-cluster tenant migration.
 *
 * The operator first registers cluster A's tenant backup target as a
 * backup config on THIS (destination) cluster (existing Backups → Targets
 * UI). This flow then:
 *
 *  1. `useMigrationListTenants` — `POST /api/v1/admin/migration/list-tenants`
 *     mounts that target READ-ONLY, scans it, and returns the discovered
 *     tenants (+ whether each already exists on this cluster).
 *  2. `useMigrationImport` — `POST /api/v1/admin/migration/import` imports
 *     the selected (or all discovered) tenants. Always previewed with
 *     `dryRun: true` first, then executed with `dryRun: false`.
 *
 * Types come from `@insula/api-contracts` (`migration.ts`) so the UI and
 * backend can never drift. `apiFetch` mirrors `use-dr-recover.ts`.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  MigrationListRequest,
  MigrationListResponse,
  MigrationImportRequest,
  MigrationImportResponse,
} from '@insula/api-contracts';

interface MigrationListEnvelope {
  readonly data: MigrationListResponse;
}
interface MigrationImportEnvelope {
  readonly data: MigrationImportResponse;
}

/**
 * Scan a mounted (read-only) SOURCE backup target for importable tenants.
 * Makes NO changes to the source — it is mounted read-only.
 */
export function useMigrationListTenants() {
  return useMutation({
    mutationFn: (input: MigrationListRequest) =>
      apiFetch<MigrationListEnvelope>('/api/v1/admin/migration/list-tenants', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  });
}

/**
 * Import discovered tenants from the source target. Callers pass
 * `dryRun: true` first to preview the resolved set + presence, then
 * `dryRun: false` to execute the real import (re-create + restore per
 * tenant). On a real import, refresh tenant/restore-cart consumers.
 */
export function useMigrationImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MigrationImportRequest) =>
      apiFetch<MigrationImportEnvelope>('/api/v1/admin/migration/import', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: (resp) => {
      // Dry-run resolves nothing on the cluster — only invalidate after a
      // real import created / restored tenants.
      if (!resp.data.dryRun) {
        void qc.invalidateQueries({ queryKey: ['tenants'] });
        void qc.invalidateQueries({ queryKey: ['restore-carts'] });
      }
    },
  });
}
