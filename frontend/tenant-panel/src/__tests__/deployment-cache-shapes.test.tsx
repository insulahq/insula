import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Saving an application's resources failed with "e.data.map is not a
 * function" whenever the Applications page's usage pill was on screen. The
 * mutation's optimistic cache fix visits every query under
 * ['deployments', tenantId], and the pill caches an OBJECT there, not a list.
 */
vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(async () => ({ data: { id: 'dep-1' } })),
  API_BASE: '',
  ApiError: class ApiError extends Error {},
}));

const { useUpdateDeploymentResources } = await import('../hooks/use-deployments');
const { applicationUsageKey } = await import('../hooks/use-application-usage');

let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(['deployments', 't-1'], {
    data: [{ id: 'dep-1', status: 'failed', lastError: 'OOMKilled', statusMessage: 'crash' }, { id: 'dep-2', status: 'running' }],
    pagination: {},
  });
  qc.setQueryData(applicationUsageKey('t-1'), { data: { current: 2, limit: 5 } });
});

describe('saving resources with every cache shape under the deployments key', () => {
  it('does not throw on the usage pill, and clears the old failure from the list', async () => {
    const { result } = renderHook(() => useUpdateDeploymentResources('t-1'), { wrapper });
    result.current.mutate({ deploymentId: 'dep-1', memory_request: '512Mi' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.error).toBeNull();

    const list = qc.getQueryData<{ data: Array<{ id: string; status: string; lastError: string | null }> }>(['deployments', 't-1']);
    expect(list?.data[0]).toMatchObject({ id: 'dep-1', status: 'pending', lastError: null });
    expect(qc.getQueryData(applicationUsageKey('t-1'))).toEqual({ data: { current: 2, limit: 5 } });
  });

  it('patches a single cached deployment as itself', async () => {
    qc.setQueryData(['deployments', 't-1', 'dep-1'], { data: { id: 'dep-1', status: 'failed', lastError: 'x', statusMessage: null } });
    const { result } = renderHook(() => useUpdateDeploymentResources('t-1'), { wrapper });
    result.current.mutate({ deploymentId: 'dep-1', memory_request: '512Mi' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(qc.getQueryData(['deployments', 't-1', 'dep-1'])).toEqual({ data: { id: 'dep-1', status: 'pending', lastError: null, statusMessage: null } });
  });
});
