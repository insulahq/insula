/**
 * System Backup — pg_dump hooks.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  SystemBackupRun,
  PgDumpRequest,
  PgDumpResponse,
} from '@k8s-hosting/api-contracts';

interface ApiEnv<T> { data: T }

const KEYS = {
  runs: ['system-backup', 'pg-dump', 'runs'] as const,
  run: (id: string) => ['system-backup', 'pg-dump', 'runs', id] as const,
};

export function usePgDumpRuns(filter?: { namespace?: string; cluster?: string }) {
  const qs = new URLSearchParams();
  if (filter?.namespace) qs.set('namespace', filter.namespace);
  if (filter?.cluster) qs.set('cluster', filter.cluster);
  const path = qs.toString()
    ? `/api/v1/system-backup/pg-dump/runs?${qs.toString()}`
    : '/api/v1/system-backup/pg-dump/runs';
  return useQuery({
    queryKey: [...KEYS.runs, qs.toString()],
    queryFn: () => apiFetch<ApiEnv<SystemBackupRun[]>>(path).then((r) => r.data),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || data.length === 0) return 5_000;
      const anyRunning = data.some((r) => r.status === 'pending' || r.status === 'running');
      return anyRunning ? 3_000 : 30_000;
    },
  });
}

export function usePgDumpRun(runId: string | null) {
  return useQuery({
    queryKey: runId ? KEYS.run(runId) : ['system-backup', 'pg-dump', 'runs', '_none'],
    queryFn: async () => {
      if (!runId) return null;
      const r = await apiFetch<ApiEnv<SystemBackupRun>>(`/api/v1/system-backup/pg-dump/runs/${runId}`);
      return r.data;
    },
    enabled: !!runId,
    refetchInterval: (query) => {
      const v = query.state.data;
      return v && (v.status === 'succeeded' || v.status === 'failed') ? false : 2_000;
    },
  });
}

export function useTriggerPgDump() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PgDumpRequest) =>
      apiFetch<ApiEnv<PgDumpResponse>>('/api/v1/system-backup/pg-dump', {
        method: 'POST',
        body: JSON.stringify(input),
      }).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEYS.runs });
    },
  });
}
