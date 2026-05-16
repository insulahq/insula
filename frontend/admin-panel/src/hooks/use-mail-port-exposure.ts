import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useRefreshTaskCenter } from '@/hooks/use-task-center';
import type {
  MailPortExposureResponse,
  MailPortExposureUpdate,
  MailPortExposureUpdateResponse,
} from '@k8s-hosting/api-contracts';

interface PortExposureEnvelope {
  readonly data: MailPortExposureResponse;
}

interface PortExposureUpdateEnvelope {
  readonly data: MailPortExposureUpdateResponse;
}

const PORT_EXPOSURE_KEY = ['mail', 'port-exposure'] as const;

export function useMailPortExposure() {
  return useQuery({
    queryKey: PORT_EXPOSURE_KEY,
    queryFn: () => apiFetch<PortExposureEnvelope>('/api/v1/admin/mail/port-exposure'),
    staleTime: 15_000,
    retry: false,
  });
}

/**
 * Trigger a port-exposure flip.
 *
 * 2026-05-16: the backend now runs the 30-60s flip in the background
 * and returns `taskId` immediately. The mutation resolves to
 * `{ updated: true, taskId }`. Callers open `MailTaskProgressModal`
 * with that `taskId` for live progress.
 */
export function useUpdateMailPortExposure() {
  const qc = useQueryClient();
  const refreshTasks = useRefreshTaskCenter();
  return useMutation({
    mutationFn: (input: MailPortExposureUpdate) =>
      apiFetch<PortExposureUpdateEnvelope>('/api/v1/admin/mail/port-exposure', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    // Mode flip changes which path serves mail traffic (Stalwart
    // hostPort vs. haproxy DS). Both the port-exposure card AND the
    // MailHealthBanner read derived state from the health endpoint
    // (probe reachability, DS readiness). Invalidate both so the
    // operator sees consistent state immediately when the background
    // task completes — TanStack Query refetches automatically when
    // the task chip shows the row as terminal.
    onSuccess: () => {
      // Refresh the task chip immediately so the new task surfaces
      // without waiting for the next 3s poll tick.
      refreshTasks();
      return Promise.all([
        qc.invalidateQueries({ queryKey: PORT_EXPOSURE_KEY }),
        qc.invalidateQueries({ queryKey: ['mail', 'health'] }),
      ]);
    },
  });
}
