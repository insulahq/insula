import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { CpuMigrationRun, CpuRevertResult } from '@insula/api-contracts';

interface Envelope<T> { readonly data: T }

const base = (tenantId: string) => `/api/v1/admin/cpu-migration/tenants/${tenantId}`;

/**
 * Apply, revert and stop — all PER TENANT (ADR-062 R2).
 *
 * There is deliberately no "migrate all" mutation to pair with these. The
 * migration recreates pods; doing that fleet-wide from one click is the flag
 * day the ADR exists to avoid, and the absence of the endpoint is what stops
 * one being added to the UI by reflex.
 */
export function useApplyCpuMigration() {
  const qc = useQueryClient();
  return useMutation({
    // acknowledgeBlockers is a real decision, so it is an argument rather
    // than a hardcoded false. The server refuses a flagged tenant without it
    // (409 CPU_MIGRATION_NEEDS_REVIEW), so sending a constant here would have
    // made the flagged case permanently un-migratable through the UI.
    mutationFn: ({ tenantId, acknowledgeBlockers = false }: {
      tenantId: string; acknowledgeBlockers?: boolean;
    }) =>
      apiFetch<Envelope<CpuMigrationRun>>(`${base(tenantId)}/apply`, {
        method: 'POST',
        body: JSON.stringify({ acknowledgeBlockers }),
      }),
    // The run changes reservations, so the dry run it was launched from is
    // stale the moment it finishes — including for the OTHER tenants, whose
    // headroom just improved.
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['cpu-migration-preview'] }); },
  });
}

export function useRevertCpuMigration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tenantId: string) =>
      apiFetch<Envelope<CpuRevertResult>>(`${base(tenantId)}/revert`, { method: 'POST' }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['cpu-migration-preview'] }); },
  });
}

/**
 * Asks the run to stop after the step it is on. Not a cancel: a half-applied
 * step would be the one state the migration is careful never to leave behind.
 */
export function useStopCpuMigration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tenantId: string) =>
      apiFetch<Envelope<{ stopRequested: boolean }>>(`${base(tenantId)}/stop`, { method: 'POST' }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['cpu-migration-preview'] }); },
  });
}
