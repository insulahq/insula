/**
 * A failure must stop being displayed the moment its redeploy starts —
 * in whichever of the admin panel's three views the operator is looking at.
 *
 * The server forgets the failure before it touches the cluster, but the panel
 * renders what React Query holds and `invalidateQueries` only schedules a
 * refetch. The admin panel caches the same deployment under three keys with
 * two shapes — per-tenant list, paged admin list, single-row detail — so a
 * narrow match would clear the stale verdict everywhere EXCEPT the view the
 * operator happened to be on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

const TENANT = 't1';
const FAILED = { id: 'd1', tenantId: TENANT, name: 'blog', status: 'failed', lastError: 'boom', statusMessage: null };
const OTHER = { id: 'd2', tenantId: TENANT, name: 'shop', status: 'failed', lastError: 'other boom', statusMessage: null };

const hooks = await import('@/hooks/use-deployments');

function harness() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  // The three shapes this deployment is cached in, all at once.
  qc.setQueryData(['deployments', TENANT, undefined], { data: [FAILED, OTHER] });
  qc.setQueryData(['deployments', 'admin', { page: 1 }], { data: [FAILED, OTHER], pagination: {} });
  qc.setQueryData(['deployments', TENANT, 'd1'], { data: FAILED });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return {
    wrapper,
    perTenant: () => (qc.getQueryData(['deployments', TENANT, undefined]) as { data: typeof FAILED[] }).data,
    adminList: () => (qc.getQueryData(['deployments', 'admin', { page: 1 }]) as { data: typeof FAILED[] }).data,
    detail: () => (qc.getQueryData(['deployments', TENANT, 'd1']) as { data: typeof FAILED }).data,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockImplementation(() => new Promise(() => {}));
});

describe('admin panel: forgetting a failure on restart', () => {
  it('clears the stale verdict in ALL THREE cached shapes', async () => {
    const h = harness();
    const { result } = renderHook(() => hooks.useRestartDeployment(TENANT), { wrapper: h.wrapper });
    act(() => { result.current.mutate('d1'); });

    await waitFor(() => expect(h.perTenant()[0].status).toBe('pending'));
    expect(h.perTenant()[0].lastError).toBeNull();
    // An array under `data`…
    expect(h.adminList()[0]).toMatchObject({ status: 'pending', lastError: null });
    // …and a single row under `data`.
    expect(h.detail()).toMatchObject({ status: 'pending', lastError: null });
  });

  it('leaves a DIFFERENT failing deployment alone in every shape', async () => {
    // Clearing the whole cache would hide a real failure on another app —
    // a worse bug than the one being fixed.
    const h = harness();
    const { result } = renderHook(() => hooks.useRestartDeployment(TENANT), { wrapper: h.wrapper });
    act(() => { result.current.mutate('d1'); });
    await waitFor(() => expect(h.perTenant()[0].status).toBe('pending'));
    expect(h.perTenant()[1]).toEqual(OTHER);
    expect(h.adminList()[1]).toEqual(OTHER);
  });
});
