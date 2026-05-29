/**
 * `use-postgres-restore` — TanStack Query bindings for the CNPG PITR endpoints.
 *
 * Three operations:
 *   - `useRestoreStatus()`     → GET /admin/postgres-restore/status, polls
 *                                during an in-flight restore so the chip
 *                                + the snapshot Restore button reflect
 *                                cluster-wide lock state.
 *   - `usePitrPrechecks(...)`  → GET /admin/postgres-restore/prechecks for
 *                                wizard Step 3. Returns live snapshot age,
 *                                WAL coverage, lock state, blocking error.
 *   - `useStartPitr()`         → POST /admin/postgres-restore, async — the
 *                                backend spawns a k8s Job and returns 202
 *                                with the job name; UI tracks via task-center.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  PitrAccepted,
  PitrPrechecksResponse,
  PitrRequest,
  PitrStatus,
} from '@insula/api-contracts';

interface Envelope<T> {
  readonly data: T;
}

const STATUS_KEY = ['postgres-restore', 'status'] as const;

/**
 * Poll PITR status. Default refetch is 10s — once a restore starts we
 * want the chip + the disabled-button state to refresh quickly.
 *
 * Disabled by default to avoid burning HTTP cycles when no caller cares.
 * Pass `enabled: true` (or a derived predicate like `volume.cnpgCluster
 * != null` in the snapshot modal) to opt in.
 */
export function useRestoreStatus(opts: { readonly enabled?: boolean } = {}) {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => apiFetch<Envelope<PitrStatus>>('/api/v1/admin/postgres-restore/status'),
    refetchInterval: 10_000,
    staleTime: 5_000,
    retry: false,
    enabled: opts.enabled ?? false,
  });
}

export interface UsePitrPrechecksArgs {
  readonly clusterNamespace: string | null;
  readonly clusterName: string | null;
  readonly snapshotName: string | null;
  readonly recoveryTargetTime?: string | null;
  /** Gate the query — pass false from the wizard until Step 3 is open. */
  readonly enabled?: boolean;
}

/**
 * Run prechecks for a candidate snapshot. Cheap (read-only,
 * non-locking) so we re-run on every wizard mount; cache for 15s to
 * absorb fast user clicks.
 */
export function usePitrPrechecks(args: UsePitrPrechecksArgs) {
  const enabled =
    (args.enabled ?? true)
    && !!args.clusterNamespace
    && !!args.clusterName
    && !!args.snapshotName;
  return useQuery({
    queryKey: [
      'postgres-restore',
      'prechecks',
      args.clusterNamespace,
      args.clusterName,
      args.snapshotName,
      args.recoveryTargetTime ?? null,
    ] as const,
    queryFn: () => {
      const qs = new URLSearchParams({
        clusterNamespace: args.clusterNamespace!,
        clusterName: args.clusterName!,
        snapshotName: args.snapshotName!,
      });
      if (args.recoveryTargetTime) qs.set('recoveryTargetTime', args.recoveryTargetTime);
      return apiFetch<Envelope<PitrPrechecksResponse>>(
        `/api/v1/admin/postgres-restore/prechecks?${qs.toString()}`,
      );
    },
    // 15s cache absorbs rapid clicks through the wizard. There IS a small
    // race window: a second operator can start a PITR in the 15s after
    // the first operator's wizard rendered Step 3, and the first operator
    // will see Start enabled. That's acceptable — the authoritative gate
    // is `acquirePitrLockOrThrow` in the route handler, which throws 409.
    // The wizard catches the error and renders it; no inconsistent state.
    staleTime: 15_000,
    retry: false,
    enabled,
  });
}

/**
 * Trigger a PITR. Returns the 202 envelope with the Job name so the
 * caller can hand the task id off to the wizard's `onCompleted`.
 */
export function useStartPitr() {
  return useMutation({
    mutationFn: (body: PitrRequest) =>
      apiFetch<Envelope<PitrAccepted>>('/api/v1/admin/postgres-restore', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}
