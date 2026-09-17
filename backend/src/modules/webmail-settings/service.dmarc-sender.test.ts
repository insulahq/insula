/**
 * Saving the DMARC report sender.
 *
 * Two behaviours, both about the gap between "stored" and "in effect":
 *
 *  - only an address from the live eligible list is accepted. A format check
 *    would accept `postmaster@some-domain-we-do-not-host.test`, which is the
 *    original defect (reports from an address nobody can reply to) wearing a
 *    dropdown.
 *  - the save pushes to Stalwart immediately. Left to the 5-minute self-heal
 *    tick, the panel would show the new address while reporting stayed in its
 *    previous state, with nothing on screen saying which one is live.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ensureDmarcReportSender } = vi.hoisted(() => ({ ensureDmarcReportSender: vi.fn() }));
const { eligibleReportSenders } = vi.hoisted(() => ({ eligibleReportSenders: vi.fn() }));

vi.mock('../mail-events/dmarc-report-sender.js', () => ({
  ensureDmarcReportSender,
  eligibleReportSenders,
  DMARC_REPORT_SENDER_KEY: 'dmarc_report_sender',
  DMARC_REPORT_SENDER_DISABLED: 'disabled',
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
  ensureDmarcReportSender.mockReset().mockResolvedValue({ state: 'disabled', sender: null });
  eligibleReportSenders.mockReset().mockResolvedValue([
    { address: 'postmaster@example.test', domainName: 'example.test', tenantName: 'Example Ltd', isSystemTenant: false },
  ]);
});

describe('updateWebmailSettings — dmarcReportSender', () => {
  it('stores an eligible address', async () => {
    const { db, writes } = fakeDb();
    await updateWebmailSettings(db, { dmarcReportSender: 'postmaster@example.test' }, logger);
    expect(writes).toEqual([{ key: 'dmarc_report_sender', value: 'postmaster@example.test' }]);
  });

  it('refuses an address that is not on the live list', async () => {
    const { db, writes } = fakeDb();
    await expect(
      updateWebmailSettings(db, { dmarcReportSender: 'postmaster@not-hosted.test' }, logger),
    ).rejects.toThrow(/postmaster@ address on an email-enabled domain/);
    expect(writes).toEqual([]);
    // And nothing was pushed to Stalwart on the way out.
    expect(ensureDmarcReportSender).not.toHaveBeenCalled();
  });

  it('stores the disabled sentinel for null, rather than deleting the row', async () => {
    const { db, writes } = fakeDb();
    await updateWebmailSettings(db, { dmarcReportSender: null }, logger);
    expect(writes).toEqual([{ key: 'dmarc_report_sender', value: 'disabled' }]);
  });

  it('pushes to Stalwart as part of the save, not on the next tick', async () => {
    const { db } = fakeDb();
    await updateWebmailSettings(db, { dmarcReportSender: 'postmaster@example.test' }, logger);
    expect(ensureDmarcReportSender).toHaveBeenCalledTimes(1);
    // The logger is handed over as an OBJECT. Passing `logger.info` instead
    // would detach the method from its instance and throw inside pino.
    expect(ensureDmarcReportSender.mock.calls[0][1]).toBe(logger);
  });

  it('pushes on disable as well — the direction that stops mail going out', async () => {
    const { db } = fakeDb();
    await updateWebmailSettings(db, { dmarcReportSender: null }, logger);
    expect(ensureDmarcReportSender).toHaveBeenCalledTimes(1);
  });

  it('leaves Stalwart alone when the field is absent from the payload', async () => {
    // An unrelated settings save must not reconcile mail as a side effect.
    const { db } = fakeDb();
    await updateWebmailSettings(db, { mailEnforcementMode: 'notify' }, logger);
    expect(ensureDmarcReportSender).not.toHaveBeenCalled();
  });
});
