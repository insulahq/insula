import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  TenantAutomationKept,
  TenantAutomationSettingsSaved,
  TenantAutomationSettingsUpdate,
  TenantAutomationStatus,
} from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

interface Envelope<T> { readonly data: T }

const KEY = ['tenant-automation'] as const;
const PATH = '/api/v1/admin/lifecycle/automation';

/** Settings, last run and the tenants in line. Polled while a sweep is under way. */
export function useTenantAutomation() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => apiFetch<Envelope<TenantAutomationStatus>>(PATH),
    refetchInterval: (query) => (query.state.data?.data.running ? 5000 : false),
  });
}

/**
 * Save the settings that were changed — only those: a field left alone is not
 * sent, so it cannot overwrite what another admin has saved in the meantime.
 * The stored settings come back at once; everything else on the card (who is
 * in line) is read again.
 */
export function useSaveTenantAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (update: TenantAutomationSettingsUpdate) =>
      apiFetch<Envelope<TenantAutomationSettingsSaved>>(PATH, { method: 'PATCH', body: JSON.stringify(update) }),
    onSuccess: (res) => {
      qc.setQueryData<Envelope<TenantAutomationStatus>>(KEY, (old) => (old ? { data: { ...old.data, settings: res.data.settings } } : old));
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

/** Start a sweep now. It runs on after the answer; the status shows it as running. */
export function useRunTenantAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<Envelope<{ started: boolean }>>(`${PATH}/run`, { method: 'POST' }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ['lifecycle-transitions'] });
    },
  });
}

/**
 * Keep one tenant out of both steps, or put it back. The card and the
 * tenant's own page both show the answer.
 */
export function useSetTenantAutomationExempt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly tenantId: string; readonly exempt: boolean }) =>
      apiFetch<Envelope<TenantAutomationKept & { readonly exempt: boolean }>>(`${PATH}/tenants/${input.tenantId}`, {
        method: 'PUT',
        body: JSON.stringify({ exempt: input.exempt }),
      }),
    onSettled: (_res, _err, input) => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ['tenants', input.tenantId] });
    },
  });
}
