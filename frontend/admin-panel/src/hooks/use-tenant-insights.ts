/**
 * Read-only figures the admin tenant page shows beside the tenant itself:
 * bandwidth, mail usage and history, deliverability reports, and the send
 * limits as the mail server holds them.
 *
 * All of these are the endpoints the tenant panel already reads (the admin
 * roles pass `requireTenantAccess` for any tenant), plus the admin-only live
 * send-limit check. Nothing here writes.
 */
import { useQuery } from '@tanstack/react-query';
import type {
  AbuseReportsOverview,
  DmarcOverview,
  MailDailyResponse,
  MailDomainStatsResponse,
  MailUsageResponse,
  SendLimitLiveState,
  TenantBandwidthUsage,
  TlsReportsOverview,
} from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

interface Envelope<T> { readonly data: T }

function tenantQuery<T>(key: string, tenantId: string | undefined, path: string, staleTime = 60_000) {
  return {
    queryKey: [key, tenantId],
    queryFn: () => apiFetch<Envelope<T>>(`/api/v1/${path}`),
    enabled: Boolean(tenantId),
    staleTime,
  } as const;
}

export function useTenantBandwidth(tenantId: string | undefined) {
  return useQuery(tenantQuery<TenantBandwidthUsage>('tenant-bandwidth', tenantId, `tenants/${tenantId}/bandwidth`));
}

export function useTenantMailUsage(tenantId: string | undefined) {
  return useQuery(tenantQuery<MailUsageResponse>('tenant-mail-usage', tenantId, `tenants/${tenantId}/mail/usage`, 30_000));
}

export function useTenantMailDaily(tenantId: string | undefined) {
  return useQuery(tenantQuery<MailDailyResponse>('tenant-mail-daily', tenantId, `tenants/${tenantId}/mail/daily`));
}

export function useTenantMailDomainStats(tenantId: string | undefined) {
  return useQuery(tenantQuery<MailDomainStatsResponse>('tenant-mail-domain-stats', tenantId, `tenants/${tenantId}/mail/domain-stats`));
}

export function useTenantDmarc(tenantId: string | undefined) {
  return useQuery(tenantQuery<DmarcOverview>('tenant-dmarc', tenantId, `tenants/${tenantId}/mail/dmarc`, 5 * 60_000));
}

export function useTenantTlsReports(tenantId: string | undefined) {
  return useQuery(tenantQuery<TlsReportsOverview>('tenant-tls-reports', tenantId, `tenants/${tenantId}/mail/tls-reports`, 5 * 60_000));
}

export function useTenantAbuseReports(tenantId: string | undefined) {
  return useQuery(tenantQuery<AbuseReportsOverview>('tenant-abuse-reports', tenantId, `tenants/${tenantId}/mail/abuse-reports`, 5 * 60_000));
}

/**
 * The tenant's send limits read back from the mail server. Refetched after a
 * limit is saved (the save invalidates `tenant-send-limits-live`), so the page
 * reports what the server holds, not what was sent to it.
 */
export function useTenantSendLimitsLive(tenantId: string | undefined) {
  // Admin-only on the server: a support or billing admin gets a 403, and the
  // page then simply says nothing about the mail server — so do not retry it.
  return useQuery({ ...tenantQuery<SendLimitLiveState>('tenant-send-limits-live', tenantId, `admin/tenants/${tenantId}/mail/send-limits/live`, 15_000), retry: false });
}
