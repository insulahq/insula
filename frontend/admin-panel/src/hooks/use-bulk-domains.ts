import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BulkIdResult, RefreshRouteDnsResult } from '@insula/api-contracts';
import { apiFetch, ApiError } from '@/lib/api-client';
import { outcomeFromIdResult, plural, type BulkItemOutcome, type BulkRunItem } from '@/lib/bulk-run';
import type { VerificationResult } from '@/hooks/use-domains';

/**
 * Per-domain steps for the Tenants → Domains bulk bar. Each performs ONE
 * domain; `useBulkRun` sequences them and invalidates once at the end.
 */

export interface DomainBulkItem extends BulkRunItem {
  readonly tenantId: string;
}

export type DomainBulkAction = 'verify' | 'delete' | 'refresh-route-dns';

/** Same request as the domain's own Verify button (force: skip the 24h cache). */
export async function verifyDomainItem(item: DomainBulkItem): Promise<BulkItemOutcome> {
  const res = await apiFetch<{ data: VerificationResult }>(
    `/api/v1/tenants/${item.tenantId}/domains/${item.id}/verify?force=true`,
    { method: 'POST' },
  );
  return describeVerification(res.data);
}

export function describeVerification(result: VerificationResult): BulkItemOutcome {
  const total = result.checks.length;
  const failing = result.checks.filter((c) => c.status === 'fail');
  if (result.verified) {
    return { status: 'succeeded', detail: `Verified — ${total - failing.length}/${total} checks passed` };
  }
  return {
    status: 'failed',
    detail: `Not verified — ${failing.length} of ${plural(total, 'check')} failed`,
    lines: failing.map((c) => `${c.type}: ${c.detail}`),
  };
}

/** One id per call through the existing bulk endpoint, so the delete path is unchanged. */
export async function deleteDomainItem(item: DomainBulkItem): Promise<BulkItemOutcome> {
  const res = await apiFetch<{ data: BulkIdResult }>('/api/v1/admin/domains/bulk', {
    method: 'POST',
    body: JSON.stringify({ domain_ids: [item.id], action: 'delete' }),
  });
  return outcomeFromIdResult(res.data, item.id, 'Deleted');
}

/** A 409 DNS_MODE_NOT_PRIMARY is a skip, not a failure: there is no zone to refresh. */
export async function refreshRouteDnsItem(item: DomainBulkItem): Promise<BulkItemOutcome> {
  try {
    const res = await apiFetch<{ data: RefreshRouteDnsResult }>(
      `/api/v1/tenants/${item.tenantId}/domains/${item.id}/refresh-route-dns`,
      { method: 'POST' },
    );
    return describeRouteDnsRefresh(res.data);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.code === 'DNS_MODE_NOT_PRIMARY') {
      return { status: 'skipped', detail: 'Skipped — not a primary-mode domain, so the platform does not control its zone.' };
    }
    throw err;
  }
}

/**
 * `created` counts hostnames whose records were provisioned again (not
 * individual records); `removed` counts the platform-owned records dropped
 * first. Any per-hostname failure fails the domain — some of its names may
 * still point at the old ingress addresses.
 */
export function describeRouteDnsRefresh(result: RefreshRouteDnsResult): BulkItemOutcome {
  const summary = `${plural(result.hostnames, 'hostname')}, ${result.created} refreshed, ${plural(result.removed, 'stale record')} removed`;
  if (result.failures.length === 0) return { status: 'succeeded', detail: summary };
  return {
    status: 'failed',
    detail: `${summary} — ${result.failures.length} of ${plural(result.hostnames, 'hostname')} failed`,
    lines: result.failures.map((f) => `${f.hostname}: ${f.detail}`),
  };
}

export const DOMAIN_BULK_RUNNERS: Readonly<Record<DomainBulkAction, (item: DomainBulkItem) => Promise<BulkItemOutcome>>> = {
  verify: verifyDomainItem,
  delete: deleteDomainItem,
  'refresh-route-dns': refreshRouteDnsItem,
};

/** One invalidation per run: the list, and the DNS records these actions rewrite. */
export function useInvalidateDomainQueries(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['domains'] });
    void queryClient.invalidateQueries({ queryKey: ['dns-records'] });
  }, [queryClient]);
}
