/**
 * The unlock control's wiring.
 *
 * Two things must hold and neither is visible by reading the component: the
 * mutation has to POST to the route that exists (a guessed prefix 404s, `data`
 * comes back undefined, and the banner renders as if nothing happened), and it
 * has to invalidate the backups query — the listing carries `lockCount`, so it
 * is stale the instant the unlock returns and the banner would otherwise sit
 * there claiming the repo is still locked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetch = vi.fn().mockResolvedValue({
  data: { locksBefore: 2, locksAfter: 0, removed: 2, output: 'ok', message: 'Cleared 2 stale lock(s).' },
});
const invalidateQueries = vi.fn();

vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined }),
  useMutation: (opts: { mutationFn: () => Promise<unknown>; onSuccess?: () => void }) => ({
    mutate: async () => {
      const r = await opts.mutationFn();
      opts.onSuccess?.();
      return r;
    },
  }),
  useQueryClient: () => ({ invalidateQueries }),
}));

beforeEach(() => {
  apiFetch.mockClear();
  invalidateQueries.mockClear();
});

describe('useUnlockMailRestic', () => {
  it('POSTs to the unlock route that actually exists', async () => {
    const { useUnlockMailRestic } = await import('./use-mail-backups.js');
    await useUnlockMailRestic().mutate();

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = apiFetch.mock.calls[0]!;
    expect(url).toBe('/api/v1/admin/mail/backups/unlock');
    expect((init as { method?: string } | undefined)?.method).toBe('POST');
  });

  it('does not send a body — the route takes no parameters', async () => {
    // apiFetch only sets Content-Type when a body exists; sending one here
    // would add a header the route never validates.
    const { useUnlockMailRestic } = await import('./use-mail-backups.js');
    await useUnlockMailRestic().mutate();
    const [, init] = apiFetch.mock.calls[0]!;
    expect((init as { body?: unknown } | undefined)?.body).toBeUndefined();
  });

  it('invalidates the backups query so the stale lockCount is refetched', async () => {
    const { useUnlockMailRestic } = await import('./use-mail-backups.js');
    await useUnlockMailRestic().mutate();

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['mail', 'backups'] });
  });
});
