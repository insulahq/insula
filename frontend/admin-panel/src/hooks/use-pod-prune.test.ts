/**
 * Prune-control wiring.
 *
 * None of this is visible by reading the component: the mutations must hit
 * routes that exist (a guessed prefix 404s, `data` comes back undefined, and the
 * panel renders as though nothing happened), and the manual sweep must
 * invalidate the pod list — which still contains the records it just deleted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetch = vi.fn().mockResolvedValue({ data: { autoPruneDays: 30 } });
const invalidateQueries = vi.fn();

vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryFn: () => unknown }) => { opts.queryFn(); return { data: undefined }; },
  useMutation: (opts: { mutationFn: (v?: unknown) => Promise<unknown>; onSuccess?: () => void }) => ({
    mutate: async (v?: unknown) => { const r = await opts.mutationFn(v); opts.onSuccess?.(); return r; },
  }),
  useQueryClient: () => ({ invalidateQueries }),
}));

beforeEach(() => { apiFetch.mockClear(); invalidateQueries.mockClear(); });

describe('pod-prune hooks', () => {
  it('reads the policy from the route that exists', async () => {
    const { usePodPrunePolicy } = await import('./use-pod-prune.js');
    usePodPrunePolicy();
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/admin/pods/prune-policy');
  });

  it('saves the policy as a PUT with the day count', async () => {
    const { useSetPodPrunePolicy } = await import('./use-pod-prune.js');
    await useSetPodPrunePolicy().mutate(14);
    const [url, init] = apiFetch.mock.calls[0]!;
    expect(url).toBe('/api/v1/admin/pods/prune-policy');
    expect((init as { method?: string }).method).toBe('PUT');
    expect(JSON.parse((init as { body: string }).body)).toEqual({ autoPruneDays: 14 });
  });

  it('can save 0 — disabling auto-prune is a real choice, not an empty field', async () => {
    const { useSetPodPrunePolicy } = await import('./use-pod-prune.js');
    await useSetPodPrunePolicy().mutate(0);
    expect(JSON.parse((apiFetch.mock.calls[0]![1] as { body: string }).body)).toEqual({ autoPruneDays: 0 });
  });

  it('prunes with no olderThanDays, so the server sweeps every dead record', async () => {
    // "Prune Dead Pods" means now. Sending a window here would silently spare
    // the records the operator is looking at.
    const { usePrunePods } = await import('./use-pod-prune.js');
    await usePrunePods().mutate();
    const [url, init] = apiFetch.mock.calls[0]!;
    expect(url).toBe('/api/v1/admin/pods/prune');
    expect((init as { method?: string }).method).toBe('POST');
    expect(JSON.parse((init as { body: string }).body)).toEqual({});
  });

  it('invalidates the pod list after a sweep', async () => {
    const { usePrunePods } = await import('./use-pod-prune.js');
    await usePrunePods().mutate();
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['admin', 'pods'] });
  });

  it('invalidates the policy after saving it', async () => {
    const { useSetPodPrunePolicy } = await import('./use-pod-prune.js');
    await useSetPodPrunePolicy().mutate(7);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['admin', 'pods', 'prune-policy'] });
  });
});
