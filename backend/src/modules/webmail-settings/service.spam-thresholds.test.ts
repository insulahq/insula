/**
 * Saving the spam thresholds (Mail Settings → Server).
 *
 * One pair for the whole mail server — Stalwart has a single threshold, not one
 * per domain. Either value can be sent alone, so the refuse threshold is
 * checked against the Junk threshold that will be in effect. A save pushes to
 * Stalwart at once, like the ban lifetime.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ensureSpamPolicy } = vi.hoisted(() => ({ ensureSpamPolicy: vi.fn() }));
vi.mock('../mail-admin/spam-policy.js', async (orig) => ({
  ...(await orig<typeof import('../mail-admin/spam-policy.js')>()),
  ensureSpamPolicy,
}));

const { updateWebmailSettings } = await import('./service.js');

/** Serves `stored` platform_settings rows and records what was written. */
function fakeDb(stored: Array<{ key: string; value: string }> = []) {
  const writes: { key: string; value: string }[] = [];
  const chain: Record<string, unknown> = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => Promise.resolve(stored),
    limit: () => Promise.resolve([]),
  };
  return {
    writes,
    db: {
      select: () => chain,
      insert: () => ({
        values: (v: { key: string; value: string }) => ({
          onConflictDoUpdate: () => { writes.push(v); return Promise.resolve(); },
        }),
      }),
    } as never,
  };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

beforeEach(() => {
  ensureSpamPolicy.mockReset().mockResolvedValue({ state: 'committed', thresholds: null, parts: {} });
});

describe('updateWebmailSettings — spam thresholds', () => {
  it('stores both thresholds, rounded to one decimal, and applies them at once', async () => {
    const { db, writes } = fakeDb();
    await updateWebmailSettings(db, { spamJunkScore: 6.25, spamRejectScore: 15 }, logger);
    expect(writes).toEqual([
      { key: 'mail_spam_junk_score', value: '6.3' },
      { key: 'mail_spam_reject_score', value: '15' },
    ]);
    expect(ensureSpamPolicy).toHaveBeenCalledTimes(1);
    expect(ensureSpamPolicy).toHaveBeenCalledWith(db, logger);
  });

  it('stores "off" for a null refuse threshold — a decision, not an absent setting', async () => {
    const { db, writes } = fakeDb([{ key: 'mail_spam_reject_score', value: '12' }]);
    await updateWebmailSettings(db, { spamRejectScore: null }, logger);
    expect(writes).toEqual([{ key: 'mail_spam_reject_score', value: 'off' }]);
  });

  it('refuses a refuse threshold at or below the Junk threshold, and writes nothing', async () => {
    const { db, writes } = fakeDb();
    await expect(updateWebmailSettings(db, { spamJunkScore: 8, spamRejectScore: 8 }, logger))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_FIELD_VALUE' });
    expect(writes).toEqual([]);
    expect(ensureSpamPolicy).not.toHaveBeenCalled();
  });

  it('a refused pair leaves the other settings of the same request unwritten', async () => {
    const { db, writes } = fakeDb();
    await expect(updateWebmailSettings(db, { webmailShowFiles: true, spamJunkScore: 9, spamRejectScore: 6 }, logger))
      .rejects.toMatchObject({ status: 400 });
    expect(writes).toEqual([]);
  });

  it('checks a Junk threshold sent alone against the stored refuse threshold', async () => {
    const { db, writes } = fakeDb([{ key: 'mail_spam_reject_score', value: '10' }]);
    await expect(updateWebmailSettings(db, { spamJunkScore: 10 }, logger))
      .rejects.toMatchObject({ status: 400, details: expect.objectContaining({ field: 'spamJunkScore' }) });
    expect(writes).toEqual([]);
  });

  it('leaves the spam policy alone when neither threshold is sent', async () => {
    const { db } = fakeDb();
    await updateWebmailSettings(db, { webmailShowFiles: true }, logger);
    expect(ensureSpamPolicy).not.toHaveBeenCalled();
  });

  it('reads an unset setting as Stalwart\'s defaults', async () => {
    const { db } = fakeDb();
    const settings = await updateWebmailSettings(db, {}, logger);
    expect(settings).toMatchObject({ spamJunkScore: 5, spamRejectScore: null });
  });
});
