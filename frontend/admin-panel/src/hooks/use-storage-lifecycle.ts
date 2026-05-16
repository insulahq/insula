import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface StorageSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: 'manual' | 'pre-resize' | 'pre-suspend' | 'pre-archive' | 'scheduled';
  readonly status: 'creating' | 'ready' | 'expired' | 'failed';
  readonly archivePath: string;
  readonly sizeBytes: string;
  readonly sha256: string | null;
  readonly expiresAt: string | null;
  readonly label: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
}

export interface StorageOperation {
  readonly id: string;
  readonly tenantId: string;
  readonly opType: 'snapshot' | 'resize' | 'suspend' | 'resume' | 'archive' | 'restore' | 'fsck';
  readonly state: 'idle' | 'snapshotting' | 'quiescing' | 'replacing' | 'restoring' | 'unquiescing' | 'failed';
  readonly progressPct: number;
  readonly progressMessage: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface AuditRow {
  readonly tenantId: string;
  readonly namespace: string;
  readonly provisionedGi: number;
  readonly usedBytes: number;
  readonly wastePct: number;
}

export function useSnapshots(tenantId: string | undefined) {
  return useQuery<{ data: StorageSnapshot[] }>({
    queryKey: ['snapshots', tenantId],
    queryFn: () => apiFetch(`/api/v1/admin/tenants/${tenantId}/storage/snapshots`),
    enabled: !!tenantId,
  });
}

export function useStorageOperations(tenantId: string | undefined) {
  return useQuery<{ data: StorageOperation[] }>({
    queryKey: ['storage-operations', tenantId],
    queryFn: () => apiFetch(`/api/v1/admin/tenants/${tenantId}/storage/operations`),
    enabled: !!tenantId,
    refetchInterval: (query) => {
      // Poll every 2s while an op is in flight, else stop.
      const data = (query.state.data as { data?: StorageOperation[] } | undefined)?.data;
      return data?.some((o) => o.state !== 'idle' && o.state !== 'failed' && !o.completedAt) ? 2000 : false;
    },
  });
}

export function useStorageAudit() {
  return useQuery<{ data: AuditRow[] }>({
    queryKey: ['storage-audit'],
    queryFn: () => apiFetch('/api/v1/admin/storage/audit'),
    staleTime: 60_000,
  });
}

export function useCreateSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { tenantId: string; label?: string; retentionDays?: number }) => {
      return apiFetch(`/api/v1/admin/tenants/${input.tenantId}/storage/snapshot`, {
        method: 'POST',
        body: JSON.stringify({ label: input.label, retentionDays: input.retentionDays }),
      });
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['snapshots', vars.tenantId] });
      qc.invalidateQueries({ queryKey: ['storage-operations', vars.tenantId] });
    },
  });
}

export function useDeleteSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (snapshotId: string) => {
      return apiFetch(`/api/v1/admin/storage/snapshots/${snapshotId}`, { method: 'DELETE' });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['snapshots'] }),
  });
}

export interface ResizeDryRun {
  readonly currentGi: number;
  readonly currentMib: number;
  readonly requestedGi: number;
  readonly requestedMib: number;
  readonly usedBytes: number;
  readonly willFit: boolean;
  readonly rejectReason: string | null;
  readonly estimatedSeconds: number;
}

export function useResizeDryRun() {
  return useMutation<{ data: ResizeDryRun }, Error, { tenantId: string; newMib: number }>({
    mutationFn: async ({ tenantId, newMib }) => apiFetch(`/api/v1/admin/tenants/${tenantId}/storage/resize/dry-run`, {
      method: 'POST',
      body: JSON.stringify({ newMib }),
    }),
  });
}

export function useResizeTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ tenantId, newMib }: { tenantId: string; newMib: number }) =>
      apiFetch<{ data: { operationId: string } }>(`/api/v1/admin/tenants/${tenantId}/storage/resize`, {
        method: 'POST',
        body: JSON.stringify({ newMib }),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['storage-operations', vars.tenantId] });
      qc.invalidateQueries({ queryKey: ['snapshots', vars.tenantId] });
    },
  });
}

export function useSuspendTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tenantId: string) =>
      apiFetch(`/api/v1/admin/tenants/${tenantId}/storage/suspend`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useResumeTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tenantId: string) =>
      apiFetch(`/api/v1/admin/tenants/${tenantId}/storage/resume`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useArchiveTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ tenantId, retentionDays }: { tenantId: string; retentionDays?: number }) =>
      apiFetch(`/api/v1/admin/tenants/${tenantId}/storage/archive`, {
        method: 'POST',
        body: JSON.stringify({ retentionDays }),
      }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useRestoreTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ tenantId, newGi }: { tenantId: string; newGi?: number }) =>
      apiFetch(`/api/v1/admin/tenants/${tenantId}/storage/restore`, {
        method: 'POST',
        body: JSON.stringify({ newGi }),
      }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

// ─── Filesystem check / repair ───────────────────────────────────────
//
// Both endpoints kick off an async storage-lifecycle op. The mutation
// returns the operationId; UI polls /admin/storage/operations/:id (via
// useStorageOperations) until completedAt is set, then reads
// progressMessage (clean) or lastError (errors found) for the report.

export function useFsckCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tenantId: string) =>
      apiFetch<{ data: { operationId: string } }>(
        `/api/v1/admin/tenants/${tenantId}/storage/fsck`,
        { method: 'POST' },
      ),
    onSuccess: (_, tenantId) => {
      qc.invalidateQueries({ queryKey: ['storage-operations', tenantId] });
    },
  });
}

export function useFsckRepair() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tenantId: string) =>
      apiFetch<{ data: { operationId: string } }>(
        `/api/v1/admin/tenants/${tenantId}/storage/fsck-repair`,
        { method: 'POST' },
      ),
    onSuccess: (_, tenantId) => {
      qc.invalidateQueries({ queryKey: ['storage-operations', tenantId] });
    },
  });
}

/**
 * Force-clear a tenant's stuck 'failed' storage-lifecycle state. Only
 * callable when the tenant is actually in 'failed' (the backend
 * enforces this — UI should only show this control when the state
 * has the red X badge).
 */
export function useClearFailedState() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tenantId: string) =>
      apiFetch(`/api/v1/admin/tenants/${tenantId}/storage/clear-failed`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

/**
 * Force-cancel an in-progress storage operation. Works on any non-idle
 * state (quiescing/snapshotting/resizing/restoring/fsck). Best-effort
 * deletes the underlying K8s Job(s) and resets the tenant's lifecycle
 * state. Useful when the operation is wedged on quota / image-pull /
 * orphaned-Job conditions.
 */
export interface CancelStorageResult {
  readonly previousState: string;
  readonly deletedJobs: number;
  readonly cancelledOpId: string | null;
}

export function useCancelStorageOperation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tenantId: string): Promise<CancelStorageResult> => {
      const res = await apiFetch<{ data: CancelStorageResult }>(
        `/api/v1/admin/tenants/${tenantId}/storage/cancel`,
        { method: 'POST' },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries(),
  });
}

// ─── PVC node placement (Storage Lifecycle node-host column) ───
//
// Backend joins the tenant's PVC → Longhorn volume → running replicas
// to surface which node currently holds the data. Refreshes on the
// same cadence as the rest of the lifecycle UI.

export interface TenantPvcPlacement {
  readonly namespace: string;
  readonly pvcName: string;
  readonly volumeName: string;
  readonly sizeBytes: number;
  /** Filesystem-level user-file usage from kubelet stats. */
  readonly usedBytes: number;
  /** Longhorn block-level allocation including filesystem metadata
   *  + Longhorn overhead (~230 MiB on ext4, ~40 MiB on XFS). */
  readonly allocatedBytes: number;
  readonly state: string | null;
  readonly robustness: string | null;
  readonly replicaNodes: readonly string[];
  /** Abnormal Longhorn Volume conditions (status===True, filtered to
   *  exclude the always-True "Scheduled" healthy case). */
  readonly engineConditions: ReadonlyArray<{
    readonly type: string;
    readonly reason: string | null;
    readonly message: string | null;
  }>;
  readonly replicasHealthy: number;
  readonly replicasExpected: number;
  readonly lastBackupAt: string | null;
  readonly fsType: string | null;
  readonly frontendState: string | null;
}

export function useTenantStoragePlacement(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['tenant-storage-placement', tenantId],
    queryFn: async () => {
      if (!tenantId) throw new Error('useTenantStoragePlacement called without a tenantId');
      return apiFetch<{ data: { pvcs: TenantPvcPlacement[] } }>(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/storage-placement`,
      );
    },
    enabled: Boolean(tenantId),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}
