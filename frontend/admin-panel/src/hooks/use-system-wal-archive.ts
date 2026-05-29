/**
 * System Backup Phase 4 — WAL archive hooks.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  WalArchiveCluster,
  WalArchiveEnableRequest,
  WalArchiveDisableRequest,
  WalArchiveActionResponse,
  WalStreamingEnableRequest,
  WalStreamingDisableRequest,
  ScheduledBackupsEnableRequest,
  ScheduledBackupsDisableRequest,
} from '@insula/api-contracts';

interface ApiEnv<T> { data: T }

const KEY = ['system-backup', 'wal-archive', 'clusters'] as const;

export function useWalArchiveClusters() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => apiFetch<ApiEnv<WalArchiveCluster[]>>(
      '/api/v1/system-backup/wal-archive/clusters',
    ).then((r) => r.data),
    // Status fields (lastArchivedWalTime) update live as CNPG archives
    // WAL — refresh every 15s when any cluster is enabled.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || data.length === 0) return 60_000;
      return data.some((c) => c.enabled) ? 15_000 : 60_000;
    },
  });
}

export function useEnableWalArchive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WalArchiveEnableRequest) =>
      apiFetch<ApiEnv<WalArchiveActionResponse>>(
        '/api/v1/system-backup/wal-archive/enable',
        { method: 'POST', body: JSON.stringify(input) },
      ).then((r) => r.data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
}

export function useDisableWalArchive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WalArchiveDisableRequest) =>
      apiFetch<ApiEnv<WalArchiveActionResponse>>(
        '/api/v1/system-backup/wal-archive/disable',
        { method: 'POST', body: JSON.stringify(input) },
      ).then((r) => r.data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
}

// ─── Phase 7a (2026-05-24): split WAL streaming vs Scheduled Backups ──
// Each pair is idempotent — calling enable while already enabled
// UPDATES the settings, so the operator's "Save" button can re-call
// without disable+re-enable.

export function useEnableWalStreaming() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WalStreamingEnableRequest) =>
      apiFetch<ApiEnv<WalArchiveActionResponse>>(
        '/api/v1/system-backup/wal-archive/streaming/enable',
        { method: 'POST', body: JSON.stringify(input) },
      ).then((r) => r.data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
}

export function useDisableWalStreaming() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WalStreamingDisableRequest) =>
      apiFetch<ApiEnv<WalArchiveActionResponse>>(
        '/api/v1/system-backup/wal-archive/streaming/disable',
        { method: 'POST', body: JSON.stringify(input) },
      ).then((r) => r.data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
}

export function useEnableScheduledBackups() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ScheduledBackupsEnableRequest) =>
      apiFetch<ApiEnv<{ enabled: true; cron: string }>>(
        '/api/v1/system-backup/wal-archive/schedule/enable',
        { method: 'POST', body: JSON.stringify(input) },
      ).then((r) => r.data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
}

export function useDisableScheduledBackups() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ScheduledBackupsDisableRequest) =>
      apiFetch<ApiEnv<{ enabled: false }>>(
        '/api/v1/system-backup/wal-archive/schedule/disable',
        { method: 'POST', body: JSON.stringify(input) },
      ).then((r) => r.data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
}
