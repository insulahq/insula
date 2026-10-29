import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deploymentListPollMs } from '../lib/deployment-polling';

// A custom container that fails after it was created (quota refusal, crash
// loop) is only discovered by the server's reconcile. The Custom Containers
// tab never re-read its list, so it said "Deploying" until a reload.
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

const { useCustomDeployments } = await import('../hooks/use-custom-deployments');
const { useApplicationUsage } = await import('../hooks/use-application-usage');

const row = (status: string) => ({ data: [{ id: 'c1', name: 'collabora', status }] });

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('deploymentListPollMs', () => {
  it('is fast while a row is changing state, slow otherwise', () => {
    expect(deploymentListPollMs([{ status: 'running' }, { status: 'deploying' }])).toBe(3_000);
    expect(deploymentListPollMs([{ status: 'running' }, { status: 'failed' }])).toBe(15_000);
    expect(deploymentListPollMs(undefined)).toBe(15_000);
  });
});

describe('useCustomDeployments with pollByStatus', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); apiFetchMock.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('★ a deploying container that fails shows as failed without a reload', async () => {
    apiFetchMock.mockResolvedValueOnce(row('deploying')).mockResolvedValue(row('failed'));
    const { result } = renderHook(() => useCustomDeployments('t1', { pollByStatus: true }), { wrapper });
    await waitFor(() => expect(result.current.data?.data[0]?.status).toBe('deploying'));
    await vi.advanceTimersByTimeAsync(3_000);
    await waitFor(() => expect(result.current.data?.data[0]?.status).toBe('failed'));
  });

  it('once settled it still polls, at 15 s', async () => {
    apiFetchMock.mockResolvedValue(row('running'));
    renderHook(() => useCustomDeployments('t1', { pollByStatus: true }), { wrapper });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_500);
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('useApplicationUsage', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); apiFetchMock.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('re-reads the count every 15 s — an app added elsewhere shows without a reload', async () => {
    apiFetchMock
      .mockResolvedValueOnce({ data: { limit: 5, current: 2, privateWorkers: 0, remaining: 3, source: 'plan' } })
      .mockResolvedValue({ data: { limit: 5, current: 3, privateWorkers: 0, remaining: 2, source: 'plan' } });
    const { result } = renderHook(() => useApplicationUsage('t1'), { wrapper });
    await waitFor(() => expect(result.current.data?.current).toBe(2));
    await vi.advanceTimersByTimeAsync(15_500);
    await waitFor(() => expect(result.current.data?.current).toBe(3));
  });
});
