import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface PerClientResult {
  readonly id: string;
  readonly transitionId: string | null;
  readonly error?: string;
}

interface BulkResult {
  readonly data: {
    /** Always present after Phase A2; declared optional for backwards
     *  compatibility with older deployments that haven't rolled out
     *  the bulk-cascade rewrite yet. UI falls back to the static
     *  result modal when missing. */
    readonly bulkOpId?: string;
    readonly succeeded: readonly PerClientResult[];
    readonly failed: readonly PerClientResult[];
  };
}

export function useBulkSuspendClients() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (clientIds: readonly string[]) =>
      apiFetch<BulkResult>('/api/v1/admin/clients/bulk', {
        method: 'POST',
        body: JSON.stringify({ client_ids: clientIds, action: 'suspend' }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });
}

export function useBulkReactivateClients() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (clientIds: readonly string[]) =>
      apiFetch<BulkResult>('/api/v1/admin/clients/bulk', {
        method: 'POST',
        body: JSON.stringify({ client_ids: clientIds, action: 'reactivate' }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });
}

export function useBulkDeleteClients() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (clientIds: readonly string[]) =>
      apiFetch<BulkResult>('/api/v1/admin/clients/bulk', {
        method: 'DELETE',
        body: JSON.stringify({ client_ids: clientIds }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });
}
