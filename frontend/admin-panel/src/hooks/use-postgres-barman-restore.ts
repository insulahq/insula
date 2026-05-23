/**
 * use-postgres-barman-restore — TanStack Query bindings for Phase 3.
 *
 * Side-by-side restore from a barman-cloud archive. Distinct from
 * use-postgres-restore (Phase 1) which is a snapshot-based in-place
 * PITR. This one is the "oops I deleted a row weeks ago" flow.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  BarmanRestoreAccepted,
  BarmanRestoreRequest,
  BarmanRestoreStatus,
  BarmanRestoreDeleteResponse,
  BarmanPromoteAccepted,
  BarmanPromoteRequest,
} from '@k8s-hosting/api-contracts';

interface Envelope<T> { readonly data: T; }

/**
 * Trigger a side-by-side barman-cloud restore. The response includes
 * the new cluster's name + a pollUrl. Returns 202 — the actual restore
 * happens in the CNPG operator's reconcile loop; poll the status hook.
 */
export function useStartBarmanRestore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BarmanRestoreRequest) =>
      apiFetch<Envelope<BarmanRestoreAccepted>>('/api/v1/admin/postgres-barman-restore', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['postgres-barman-restore'] });
    },
  });
}

export interface UseBarmanRestoreStatusArgs {
  readonly namespace: string | null;
  readonly newClusterName: string | null;
  /** Refetch interval while bootstrap is in progress. Default 5s. */
  readonly refetchInterval?: number;
  readonly enabled?: boolean;
}

export function useBarmanRestoreStatus(args: UseBarmanRestoreStatusArgs) {
  const enabled = (args.enabled ?? true) && !!args.namespace && !!args.newClusterName;
  return useQuery({
    queryKey: ['postgres-barman-restore', 'status', args.namespace, args.newClusterName] as const,
    queryFn: () =>
      apiFetch<Envelope<BarmanRestoreStatus>>(
        `/api/v1/admin/postgres-barman-restore/${encodeURIComponent(args.namespace!)}/${encodeURIComponent(args.newClusterName!)}/status`,
      ),
    refetchInterval: args.refetchInterval ?? 5_000,
    staleTime: 2_000,
    retry: false,
    enabled,
  });
}

export function useDeleteBarmanRestore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ namespace, newClusterName }: { namespace: string; newClusterName: string }) =>
      apiFetch<Envelope<BarmanRestoreDeleteResponse>>(
        `/api/v1/admin/postgres-barman-restore/${encodeURIComponent(namespace)}/${encodeURIComponent(newClusterName)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['postgres-barman-restore'] });
    },
  });
}

/**
 * Phase 3.1 — Promote: cutover the side-by-side restored cluster into
 * the source cluster's name. Body carries the typed-back confirmation
 * — server enforces `confirmSourceClusterName === sourceClusterName`.
 *
 * Response carries the PITR Job name so the wizard can hand off to
 * the existing PitrProgressModal via task-center chip.
 */
export function usePromoteBarmanRestore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ namespace, newClusterName, body }: {
      namespace: string;
      newClusterName: string;
      body: BarmanPromoteRequest;
    }) =>
      apiFetch<Envelope<BarmanPromoteAccepted>>(
        `/api/v1/admin/postgres-barman-restore/${encodeURIComponent(namespace)}/${encodeURIComponent(newClusterName)}/promote`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['postgres-barman-restore'] });
      qc.invalidateQueries({ queryKey: ['postgres-restore', 'status'] });
    },
  });
}
