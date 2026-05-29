import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  MailMigrationStartRequest,
  MailMigrationStatusResponse,
} from '@insula/api-contracts';

const TERMINAL_STATES = new Set(['done', 'failed', 'rolled-back']);

interface MigrationStatusEnvelope {
  readonly data: MailMigrationStatusResponse;
}
interface RunIdEnvelope {
  readonly data: { readonly runId: string };
}

export function useMailMigrationStatus(runId: string | null) {
  return useQuery({
    queryKey: ['mail', 'migration', runId],
    queryFn: () =>
      apiFetch<MigrationStatusEnvelope>(`/api/v1/admin/mail/migrate/${runId}`),
    enabled: runId != null,
    refetchInterval: (query) => {
      const state = query.state.data?.data.state;
      if (state && TERMINAL_STATES.has(state)) return false;
      return 3_000;
    },
    retry: false,
  });
}

export function useStartMailMigration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MailMigrationStartRequest) =>
      apiFetch<RunIdEnvelope>('/api/v1/admin/mail/migrate', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mail', 'placement'] });
      void qc.invalidateQueries({ queryKey: ['mail', 'pvc', 'storage'] });
    },
  });
}

interface CancelEnvelope {
  readonly data: {
    readonly runId: string;
    readonly alreadyCancelled: boolean;
    readonly terminalState: string | null;
  };
}

/**
 * Operator-triggered cancel. Marks the cancel_requested flag server-side;
 * the state machine bails at the next checkpoint. For in-flight K8s waits
 * (e.g. waitForReplicaCount, 10 min/deployment) the cancel takes effect
 * when the wait completes/times out. UI should keep polling the status
 * endpoint after triggering cancel — the run flips to state='failed' with
 * error_message='cancelled by operator at step X' on success.
 */
export function useCancelMailMigration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      apiFetch<CancelEnvelope>(`/api/v1/admin/mail/migrate/${runId}/cancel`, {
        method: 'POST',
      }),
    onSuccess: (_, runId) => {
      void qc.invalidateQueries({ queryKey: ['mail', 'migration', runId] });
    },
  });
}
