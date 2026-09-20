/**
 * A failure must stop being displayed the moment its redeploy starts.
 *
 * The server side of this was fixed first: the redeploy path clears
 * `lastError` and moves the row off `failed` before it touches the cluster.
 * The operator still saw both — because the panel renders what React Query
 * holds, and `invalidateQueries` only SCHEDULES a refetch. Between pressing
 * Restart and that round trip landing, the old error and a red FAILED chip
 * stayed on screen, over an application that was at that moment being
 * replaced.
 *
 * These tests drive the mutations with a request that never resolves, so what
 * they assert is exactly the window the operator was complaining about: what
 * the cache says while the call is still in flight.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

const TENANT = 't1';
const FAILED_ROW = {
  id: 'd1', tenantId: TENANT, name: 'blog', status: 'failed',
  lastError: '{"code":"QUOTA","title":"Quota exceeded"}', statusMessage: null,
};
const HEALTHY_ROW = {
  id: 'd2', tenantId: TENANT, name: 'shop', status: 'running',
  lastError: null, statusMessage: null,
};

const hooks = await import('@/hooks/use-deployments');

function harness() {
  // gcTime must NOT be 0 here: nothing in these tests OBSERVES the
  // deployments query (only the mutation hook is rendered), so React Query
  // would garbage-collect the seeded row the instant it was written and every
  // assertion would read undefined.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  qc.setQueryData(['deployments', TENANT], { data: [FAILED_ROW, HEALTHY_ROW] });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const rows = () => (qc.getQueryData(['deployments', TENANT]) as { data: typeof FAILED_ROW[] }).data;
  return { qc, wrapper, rows };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Never resolves: the assertions are about the in-flight window.
  apiFetch.mockImplementation(() => new Promise(() => {}));
});

describe('forgetting a failure when its redeploy starts', () => {
  it('restart drops the error AND the FAILED verdict before the call returns', async () => {
    const { wrapper, rows } = harness();
    const { result } = renderHook(() => hooks.useRestartDeployment(TENANT), { wrapper });
    act(() => { result.current.mutate('d1'); });
    await waitFor(() => expect(rows()[0].status).not.toBe('failed'));
    expect(rows()[0].lastError).toBeNull();
    // 'pending', not 'running' — the pods are coming back, and saying they
    // are up would be the same overstatement in the other direction.
    expect(rows()[0].status).toBe('pending');
  });

  it('an env-var save does the same', async () => {
    const { wrapper, rows } = harness();
    const { result } = renderHook(() => hooks.useUpdateDeployment(TENANT), { wrapper });
    act(() => { result.current.mutate({ deploymentId: 'd1', configuration: { A: '1' } } as never); });
    await waitFor(() => expect(rows()[0].lastError).toBeNull());
    expect(rows()[0].status).toBe('pending');
  });

  it('a resource change does the same', async () => {
    const { wrapper, rows } = harness();
    const { result } = renderHook(() => hooks.useUpdateDeploymentResources(TENANT), { wrapper });
    act(() => { result.current.mutate({ deploymentId: 'd1', memory_request: '512Mi' }); });
    await waitFor(() => expect(rows()[0].lastError).toBeNull());
    expect(rows()[0].status).toBe('pending');
  });

  it('leaves every OTHER deployment alone', async () => {
    // A cache-wide overwrite would be a much worse bug than the one being
    // fixed — it would hide a real failure on a different application.
    const { wrapper, rows } = harness();
    const { result } = renderHook(() => hooks.useRestartDeployment(TENANT), { wrapper });
    act(() => { result.current.mutate('d1'); });
    await waitFor(() => expect(rows()[0].status).toBe('pending'));
    expect(rows()[1]).toEqual(HEALTHY_ROW);
  });

  it('does not touch a healthy row when IT is the one being restarted', async () => {
    // Nothing to forget: a running deployment with no error must not be
    // bumped to 'pending' just because it was restarted through this path.
    const { wrapper, rows } = harness();
    const { result } = renderHook(() => hooks.useRestartDeployment(TENANT), { wrapper });
    act(() => { result.current.mutate('d2'); });
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(rows()[1]).toEqual(HEALTHY_ROW);
  });
});
