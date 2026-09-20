/**
 * A saved plan edit must be on screen immediately.
 *
 * The server side of this is a response cache that no mutation dropped, so the
 * list came back with the pre-edit numbers for five minutes. That is fixed,
 * but it cannot be the whole fix: `GET /api/v1/plans` is unauthenticated and
 * therefore still cached, and that cache is a per-PROCESS map. With more than
 * one api replica the refetch can land on a replica that did not serve the
 * write and still holds the old list — and the panel would then cache THAT
 * answer, which looks exactly like the save having failed.
 *
 * So the mutation response, which is the authoritative post-write row, is
 * written straight into the cached list. These tests drive the mutation with a
 * list query that is never refetched, which is precisely that scenario.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

const STARTER = { id: 'p1', code: 'starter', name: 'Starter', memoryLimit: '0.25', cpuLimit: '0.25' };
const PREMIUM = { id: 'p2', code: 'premium', name: 'Premium', memoryLimit: '1.00', cpuLimit: '1.00' };

const hooks = await import('@/hooks/use-plan-management');

function harness() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  qc.setQueryData(['plans'], { data: [STARTER, PREMIUM] });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { wrapper, plans: () => (qc.getQueryData(['plans']) as { data: typeof STARTER[] }).data };
}

beforeEach(() => vi.clearAllMocks());

describe('plan edits show up without waiting for a refetch', () => {
  it('writes the updated plan into the cached list', async () => {
    apiFetch.mockResolvedValue({ data: { ...STARTER, memoryLimit: '1.00' } });
    const h = harness();
    const { result } = renderHook(() => hooks.useUpdatePlan(), { wrapper: h.wrapper });
    act(() => { result.current.mutate({ id: 'p1', memory_limit: '1.00' }); });
    await waitFor(() => expect(h.plans()[0].memoryLimit).toBe('1.00'));
  });

  it('leaves every other plan untouched', async () => {
    apiFetch.mockResolvedValue({ data: { ...STARTER, memoryLimit: '1.00' } });
    const h = harness();
    const { result } = renderHook(() => hooks.useUpdatePlan(), { wrapper: h.wrapper });
    act(() => { result.current.mutate({ id: 'p1', memory_limit: '1.00' }); });
    await waitFor(() => expect(h.plans()[0].memoryLimit).toBe('1.00'));
    expect(h.plans()[1]).toEqual(PREMIUM);
  });

  it('appends a newly created plan rather than dropping it', async () => {
    const created = { id: 'p3', code: 'ultimate', name: 'Ultimate', memoryLimit: '2.00', cpuLimit: '2.00' };
    apiFetch.mockResolvedValue({ data: created });
    const h = harness();
    const { result } = renderHook(() => hooks.useCreatePlan(), { wrapper: h.wrapper });
    act(() => { result.current.mutate({ code: 'ultimate' } as never); });
    await waitFor(() => expect(h.plans()).toHaveLength(3));
    expect(h.plans()[2]).toEqual(created);
  });

  it('does nothing when the response carries no plan', async () => {
    // A malformed or empty response must not blank the list.
    apiFetch.mockResolvedValue({ data: undefined });
    const h = harness();
    const { result } = renderHook(() => hooks.useUpdatePlan(), { wrapper: h.wrapper });
    act(() => { result.current.mutate({ id: 'p1', memory_limit: '1.00' }); });
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(h.plans()).toHaveLength(2);
    expect(h.plans()[0]).toEqual(STARTER);
  });
});
