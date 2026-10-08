/**
 * Saving the automatic-ban lifetime (Mail Settings).
 *
 * Stored as whole hours, or the literal "never" — distinct from a setting nobody
 * has touched, which reads as the 24 h default. A save pushes to Stalwart at
 * once, like the DMARC sender: left to the 5-minute tick, the panel would show
 * the new lifetime while new bans still used the old one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ensureMailBanExpiry } = vi.hoisted(() => ({ ensureMailBanExpiry: vi.fn() }));
vi.mock('../mail-admin/mail-ban-expiry.js', async (orig) => ({
  ...(await orig<typeof import('../mail-admin/mail-ban-expiry.js')>()),
  ensureMailBanExpiry,
}));

const { updateWebmailSettings } = await import('./service.js');

/** Records what was written, so the assertions can be about the stored value. */
function fakeDb() {
  const writes: { key: string; value: string }[] = [];
  const chain: Record<string, unknown> = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => Promise.resolve([]),
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
  ensureMailBanExpiry.mockReset().mockResolvedValue({ state: 'committed', periodMs: 0 });
});

describe('updateWebmailSettings — mailBanExpiryHours', () => {
  it('stores whole hours and applies them to the mail server immediately', async () => {
    const { db, writes } = fakeDb();
    await updateWebmailSettings(db, { mailBanExpiryHours: 48 }, logger);
    expect(writes).toEqual([{ key: 'mail_ban_expiry_hours', value: '48' }]);
    expect(ensureMailBanExpiry).toHaveBeenCalledTimes(1);
  });

  it('stores "never" for null — a decision, not an absent setting', async () => {
    const { db, writes } = fakeDb();
    await updateWebmailSettings(db, { mailBanExpiryHours: null }, logger);
    expect(writes).toEqual([{ key: 'mail_ban_expiry_hours', value: 'never' }]);
    expect(ensureMailBanExpiry).toHaveBeenCalledTimes(1);
  });

  it('leaves the setting and the mail server alone when the field is absent', async () => {
    const { db, writes } = fakeDb();
    await updateWebmailSettings(db, { mailEnforcementMode: 'notify' }, logger);
    expect(writes.some((w) => w.key === 'mail_ban_expiry_hours')).toBe(false);
    expect(ensureMailBanExpiry).not.toHaveBeenCalled();
  });
});
