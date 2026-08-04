/**
 * Unit tests for the spam-training-sample purge.
 *
 * The behaviours that matter operationally: it DRAINS (a backlog larger than
 * one page must not be half-purged), it BOUNDS itself (a huge or stuck backlog
 * must not hang a tenant deletion), and it never reports success while rows
 * remain — the whole point is that leftover samples pin mail blobs for
 * `holdSamplesFor` (180 d upstream default).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const destroyPage = vi.fn();
vi.mock('../stalwart-jmap/client.js', () => ({
  spamTrainingSampleDestroyPage: (...args: unknown[]) => destroyPage(...args),
}));

const { purgeSpamTrainingSamplesForPrincipal, SPAM_SAMPLE_PAGE_SIZE } = await import(
  './spam-sample-cleanup.js'
);

/** Server stub holding `count` samples, handing them out `limit` at a time. */
function serverWith(count: number): void {
  let left = count;
  destroyPage.mockImplementation(async ({ limit }: { limit: number }) => {
    const n = Math.min(limit, left);
    const total = left;
    left -= n;
    return { destroyed: Array.from({ length: n }, (_, i) => `s${total - i}`), total };
  });
}

beforeEach(() => {
  destroyPage.mockReset();
});

describe('purgeSpamTrainingSamplesForPrincipal', () => {
  it('drains a multi-page backlog completely', async () => {
    serverWith(450);
    const res = await purgeSpamTrainingSamplesForPrincipal({ principalId: 'acct-1' });
    expect(res.destroyed).toBe(450);
    expect(res.remaining).toBe(0);
    expect(res.deadlineHit).toBe(false);
    // 200 + 200 + 50, then one empty page to confirm exhaustion.
    expect(destroyPage).toHaveBeenCalledTimes(4);
  });

  it('is a no-op when the principal has no samples', async () => {
    serverWith(0);
    const res = await purgeSpamTrainingSamplesForPrincipal({ principalId: 'acct-1' });
    expect(res).toEqual({ destroyed: 0, remaining: 0, deadlineHit: false });
    expect(destroyPage).toHaveBeenCalledTimes(1);
  });

  it('caps in-flight ids at one page regardless of backlog size', async () => {
    serverWith(10_000);
    await purgeSpamTrainingSamplesForPrincipal({ principalId: 'acct-1' });
    for (const call of destroyPage.mock.calls) {
      expect((call[0] as { limit: number }).limit).toBe(SPAM_SAMPLE_PAGE_SIZE);
    }
  });

  it('stops at the deadline and REPORTS the remainder instead of claiming success', async () => {
    serverWith(10_000);
    let clock = 0;
    const res = await purgeSpamTrainingSamplesForPrincipal({
      principalId: 'acct-1',
      deadlineMs: 1_000,
      now: () => (clock += 400), // 0, 400, 800, 1200 → third check trips
    });
    expect(res.deadlineHit).toBe(true);
    expect(res.remaining).toBeGreaterThan(0);
    expect(res.destroyed).toBeLessThan(10_000);
  });

  it('does not spin when the server refuses to destroy a row', async () => {
    // total stays > 0 forever but nothing is destroyed — a stuck row must end
    // the loop immediately rather than burn the whole deadline.
    destroyPage.mockResolvedValue({ destroyed: [], total: 7 });
    const res = await purgeSpamTrainingSamplesForPrincipal({ principalId: 'acct-1' });
    expect(destroyPage).toHaveBeenCalledTimes(1);
    expect(res.destroyed).toBe(0);
    expect(res.remaining).toBe(7);
    expect(res.deadlineHit).toBe(false);
  });

  it('targets the principal whose samples must be released', async () => {
    serverWith(1);
    await purgeSpamTrainingSamplesForPrincipal({ principalId: 'acct-xyz', baseUrl: 'http://mail:8080' });
    expect(destroyPage).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: 'acct-xyz', baseUrl: 'http://mail:8080' }),
    );
  });

  it('propagates transport errors so the caller can log and continue', async () => {
    destroyPage.mockRejectedValue(new Error('connection refused'));
    await expect(
      purgeSpamTrainingSamplesForPrincipal({ principalId: 'acct-1' }),
    ).rejects.toThrow('connection refused');
  });
});
