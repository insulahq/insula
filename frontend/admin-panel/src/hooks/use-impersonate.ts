import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useSystemInfo } from '@/hooks/use-system-info';
import { config } from '@/lib/runtime-config';

interface ImpersonateResponse {
  readonly token: string;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly fullName: string;
    readonly role: string;
    readonly panel: string;
    readonly tenantId: string;
  };
  readonly impersonatedBy: string;
  readonly expiresIn: number;
}

export function useImpersonate() {
  return useMutation({
    mutationFn: (tenantId: string) =>
      apiFetch<{ data: ImpersonateResponse }>(`/api/v1/admin/impersonate/${tenantId}`, {
        method: 'POST',
      }),
  });
}

/**
 * "Login as Tenant" — mint an impersonation token and open the tenant panel
 * with it in a new tab.
 *
 * Lives here rather than in a page because two places offer the action (the
 * tenant detail header and the tenants list) and the URL resolution is easy to
 * get subtly wrong: the admin-configured `tenantPanelUrl` from System Settings
 * is what the operator actually wants customers to see and what the ingress
 * reconciler points at, so it must win over the build-time `TENANT_PANEL_URL`
 * fallback, and a trailing slash must be stripped or the tab opens on "https://x//login".
 *
 * `open()` resolves to false when no panel URL is configured, so the caller can
 * surface that instead of opening a broken tab.
 */
export function useLoginAsTenant() {
  const systemInfo = useSystemInfo();
  const impersonate = useImpersonate();

  const resolvePanelUrl = (): string => {
    const fromSettings = systemInfo.data?.tenantPanelUrl ?? '';
    return (fromSettings.trim() || config.TENANT_PANEL_URL).replace(/\/+$/, '');
  };

  const open = async (tenantId: string): Promise<boolean> => {
    const tenantPanelUrl = resolvePanelUrl();
    if (!tenantPanelUrl) return false;
    const res = await impersonate.mutateAsync(tenantId);
    const { token, user } = res.data;
    const userJson = encodeURIComponent(JSON.stringify(user));
    window.open(`${tenantPanelUrl}/login?token=${token}&user=${userJson}`, '_blank');
    return true;
  };

  return {
    open,
    isPending: impersonate.isPending,
    error: impersonate.error,
    /** True when no tenant-panel URL is configured — the action cannot work. */
    isUnconfigured: resolvePanelUrl() === '',
  };
}
