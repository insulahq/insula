import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { CpuMigrationPreview } from '@insula/api-contracts';

interface Envelope<T> { readonly data: T }

/**
 * The CPU migration dry run (ADR-062 R1). Read-only — there is no mutation
 * hook here because the endpoint has no write verb.
 *
 * Deliberately NOT gated on whether the cluster is currently under pressure.
 * The dashboard finding fires only when a node is reserved-full AND idle,
 * which is the right rule for an ALARM — but if that were also the only way
 * to reach this report, a cluster at 40% reserved would never discover the
 * tier model, never see what it is wasting, and never migrate. Urgency and
 * discovery are different jobs.
 */
export function useCpuMigrationPreview() {
  return useQuery({
    queryKey: ['cpu-migration-preview'],
    queryFn: () => apiFetch<Envelope<CpuMigrationPreview>>('/api/v1/admin/cpu-migration/preview'),
    // The underlying reads list every pod in the cluster twice. This is an
    // operator opening a planning page, not a live dashboard — refetching it
    // on every window focus would be a real load for no new information.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
