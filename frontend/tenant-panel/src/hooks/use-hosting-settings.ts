import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UpdateHostingSettingsRequest } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';
import type { HostingSettingsResponse } from '@/types/api';

function basePath(tenantId: string, domainId: string) {
  return `/api/v1/tenants/${tenantId}/domains/${domainId}/hosting-settings`;
}

export function useHostingSettings(tenantId: string | undefined, domainId: string | undefined) {
  return useQuery({
    queryKey: ['hosting-settings', tenantId, domainId],
    queryFn: () => apiFetch<{ data: HostingSettingsResponse }>(basePath(tenantId!, domainId!)),
    enabled: Boolean(tenantId && domainId),
  });
}

/** Wire shape from @insula/api-contracts. */
type UpdateHostingSettingsInput = UpdateHostingSettingsRequest;

export function useUpdateHostingSettings(tenantId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateHostingSettingsInput) =>
      apiFetch<{ data: HostingSettingsResponse }>(basePath(tenantId!, domainId!), {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['hosting-settings', tenantId, domainId] });
    },
  });
}
