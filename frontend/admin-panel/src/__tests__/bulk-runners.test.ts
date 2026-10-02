import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiFetch, ApiError } from '@/lib/api-client';
import {
  deleteDomainItem,
  describeRouteDnsRefresh,
  describeVerification,
  refreshRouteDnsItem,
  verifyDomainItem,
} from '@/hooks/use-bulk-domains';
import { runCronJobBulkItem } from '@/hooks/use-bulk-cron-jobs';
import { describeTransition, runTenantBulkItem } from '@/hooks/use-bulk-tenants';
import { outcomeFromError, outcomeFromIdResult } from '@/lib/bulk-run';
import type { BulkOpResponse } from '@/hooks/use-lifecycle';

vi.mock('@/lib/api-client', () => ({
  API_BASE: '',
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
      public readonly details?: Record<string, unknown>,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

const mockApiFetch = vi.mocked(apiFetch);
const DOMAIN = { id: 'd1', label: 'shop.example.test', tenantId: 't1' };

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('refresh route DNS classification', () => {
  it('reports hostnames, refreshed and removed on success', () => {
    expect(describeRouteDnsRefresh({ hostnames: 2, created: 2, removed: 1, failures: [] })).toEqual({
      status: 'succeeded',
      detail: '2 hostnames, 2 refreshed, 1 stale record removed',
    });
  });

  it('fails the domain and lists every hostname that did not refresh', () => {
    const outcome = describeRouteDnsRefresh({
      hostnames: 3,
      created: 2,
      removed: 4,
      failures: [{ hostname: 'www.shop.example.test', detail: 'provider timeout' }],
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toBe('3 hostnames, 2 refreshed, 4 stale records removed — 1 of 3 hostnames failed');
    expect(outcome.lines).toEqual(['www.shop.example.test: provider timeout']);
  });

  it('posts to the per-domain endpoint of the owning tenant', async () => {
    mockApiFetch.mockResolvedValueOnce({ data: { hostnames: 1, created: 1, removed: 0, failures: [] } });
    const outcome = await refreshRouteDnsItem(DOMAIN);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/tenants/t1/domains/d1/refresh-route-dns', { method: 'POST' });
    expect(outcome.status).toBe('succeeded');
  });

  it('a 409 DNS_MODE_NOT_PRIMARY is a skip, not a failure', async () => {
    mockApiFetch.mockRejectedValueOnce(new ApiError(409, 'DNS_MODE_NOT_PRIMARY', 'needs primary mode'));
    const outcome = await refreshRouteDnsItem(DOMAIN);
    expect(outcome.status).toBe('skipped');
    expect(outcome.detail).toMatch(/not a primary-mode domain/);
  });

  it('any other 409 or error still fails the item', async () => {
    mockApiFetch.mockRejectedValueOnce(new ApiError(409, 'CONFLICT', 'something else'));
    await expect(refreshRouteDnsItem(DOMAIN)).rejects.toThrow('something else');
    mockApiFetch.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'boom'));
    await expect(refreshRouteDnsItem(DOMAIN)).rejects.toThrow('boom');
  });

  it('a thrown ApiError becomes a failed row carrying its code', () => {
    expect(outcomeFromError(new ApiError(500, 'INTERNAL_ERROR', 'boom'))).toEqual({
      status: 'failed',
      detail: 'boom (INTERNAL_ERROR)',
    });
  });
});

describe('domain verify / delete', () => {
  it('verify uses the forced per-domain check; not verified is a failure with the failing checks', async () => {
    mockApiFetch.mockResolvedValueOnce({
      data: {
        verified: false,
        domainId: 'd1',
        domainName: 'shop.example.test',
        checks: [
          { type: 'ns', status: 'pass', detail: 'ok' },
          { type: 'a', status: 'fail', detail: 'points elsewhere' },
        ],
      },
    });
    const outcome = await verifyDomainItem(DOMAIN);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/tenants/t1/domains/d1/verify?force=true', { method: 'POST' });
    expect(outcome).toEqual({
      status: 'failed',
      detail: 'Not verified — 1 of 2 checks failed',
      lines: ['a: points elsewhere'],
    });
  });

  it('verified is a success', () => {
    expect(describeVerification({
      verified: true,
      domainId: 'd1',
      domainName: 'shop.example.test',
      checks: [{ type: 'ns', status: 'pass', detail: 'ok' }],
    })).toEqual({ status: 'succeeded', detail: 'Verified — 1/1 checks passed' });
  });

  it('delete sends exactly one id through the existing bulk endpoint', async () => {
    mockApiFetch.mockResolvedValueOnce({ data: { succeeded: ['d1'], failed: [] } });
    const outcome = await deleteDomainItem(DOMAIN);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/admin/domains/bulk', {
      method: 'POST',
      body: JSON.stringify({ domain_ids: ['d1'], action: 'delete' }),
    });
    expect(outcome).toEqual({ status: 'succeeded', detail: 'Deleted' });
  });

  it('an id in neither list is never counted as a success', () => {
    expect(outcomeFromIdResult({ succeeded: [], failed: [] }, 'd1', 'Deleted').status).toBe('failed');
    expect(outcomeFromIdResult({ succeeded: [], failed: [{ id: 'd1', error: 'gone' }] }, 'd1', 'Deleted'))
      .toEqual({ status: 'failed', detail: 'gone' });
  });
});

describe('cron job bulk item', () => {
  it('sends one id and the action, and reads that id back', async () => {
    mockApiFetch.mockResolvedValueOnce({ data: { succeeded: [], failed: [{ id: 'c1', error: 'Cron job not found' }] } });
    const outcome = await runCronJobBulkItem('disable', { id: 'c1', label: 'nightly' });
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/admin/cron-jobs/bulk', {
      method: 'POST',
      body: JSON.stringify({ cron_job_ids: ['c1'], action: 'disable' }),
    });
    expect(outcome).toEqual({ status: 'failed', detail: 'Cron job not found' });
  });
});

function bulkOp(state: BulkOpResponse['transitions'][number]['state'], hookStates: Array<'ok' | 'noop' | 'failed' | 'pending'>): BulkOpResponse {
  return {
    bulkOpId: 'op1',
    transitions: [{
      id: 'tx1', tenantId: 't1', transitionKind: 'suspended', fromStatus: 'active', toStatus: 'suspended',
      triggeredByUserId: null, state, startedAt: '', completedAt: null, namespace: null, detail: null,
    }],
    hookRuns: {
      tx1: hookStates.map((s, i) => ({
        id: `r${i}`, transitionId: 'tx1', hookName: `hook-${i}`, hookOrder: i, blocking: 'continue', state: s,
        attempts: 1, maxAttempts: 5,
        lastError: s === 'failed' ? { title: 'K8sError', detail: 'namespace busy' } : null,
        startedAt: null, completedAt: null, nextAttemptAt: null,
      })),
    },
  };
}

describe('tenant bulk item', () => {
  it('suspends one tenant, then reads its lifecycle transition back', async () => {
    mockApiFetch
      .mockResolvedValueOnce({ data: { bulkOpId: 'op1', succeeded: [{ id: 't1', transitionId: 'tx1' }], failed: [] } })
      .mockResolvedValueOnce({ data: bulkOp('completed', ['ok', 'noop', 'ok']) });

    const outcome = await runTenantBulkItem('suspend', { id: 't1', label: 'Acme' });

    expect(mockApiFetch).toHaveBeenNthCalledWith(1, '/api/v1/admin/tenants/bulk', {
      method: 'POST',
      body: JSON.stringify({ tenant_ids: ['t1'], action: 'suspend' }),
    });
    expect(mockApiFetch).toHaveBeenNthCalledWith(2, '/api/v1/admin/lifecycle/bulk-ops/op1');
    expect(outcome).toEqual({ status: 'succeeded', detail: 'Suspended — 3 lifecycle hooks ok' });
  });

  it('delete uses the DELETE bulk endpoint with one id', async () => {
    mockApiFetch
      .mockResolvedValueOnce({ data: { bulkOpId: 'op1', succeeded: [{ id: 't1', transitionId: 'tx1' }], failed: [] } })
      .mockResolvedValueOnce({ data: bulkOp('completed', ['ok']) });
    await runTenantBulkItem('delete', { id: 't1', label: 'Acme' });
    expect(mockApiFetch).toHaveBeenNthCalledWith(1, '/api/v1/admin/tenants/bulk', {
      method: 'DELETE',
      body: JSON.stringify({ tenant_ids: ['t1'] }),
    });
  });

  it('a transition that ended failed_partial is a failure listing the failed hooks', () => {
    const outcome = describeTransition('Suspended', bulkOp('failed_partial', ['ok', 'failed']));
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toBe('1 of 2 lifecycle hooks failed; failed hooks are retried in the background.');
    expect(outcome.lines).toEqual(['hook-1 (attempt 1/5): K8sError — namespace busy']);
  });

  it('an endpoint-reported failure skips the readback', async () => {
    mockApiFetch.mockResolvedValueOnce({
      data: { bulkOpId: 'op1', succeeded: [], failed: [{ id: 't1', transitionId: null, error: 'Cannot suspend SYSTEM tenant' }] },
    });
    const outcome = await runTenantBulkItem('suspend', { id: 't1', label: 'SYSTEM' });
    expect(outcome).toEqual({ status: 'failed', detail: 'Cannot suspend SYSTEM tenant' });
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it('an unreadable readback still reports the action, and says the hooks are unknown', async () => {
    mockApiFetch
      .mockResolvedValueOnce({ data: { bulkOpId: 'op1', succeeded: [{ id: 't1', transitionId: 'tx1' }], failed: [] } })
      .mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'try later'));
    const outcome = await runTenantBulkItem('reactivate', { id: 't1', label: 'Acme' });
    expect(outcome).toEqual({ status: 'succeeded', detail: 'Reactivated. Lifecycle hook results could not be read: try later' });
  });
});
