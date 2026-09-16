import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createMailbox, deleteMailbox, updateMailbox } = vi.hoisted(() => ({
  createMailbox: vi.fn(),
  deleteMailbox: vi.fn(),
  updateMailbox: vi.fn(),
}));
vi.mock('../mailboxes/service.js', () => ({ createMailbox, deleteMailbox, updateMailbox }));

const { reportSettingsGet, reportSettingsUpdate, actionReloadSettings } = vi.hoisted(() => ({
  reportSettingsGet: vi.fn(),
  reportSettingsUpdate: vi.fn(),
  actionReloadSettings: vi.fn(),
}));
vi.mock('../stalwart-jmap/client.js', () => ({
  reportSettingsGet, reportSettingsUpdate, actionReloadSettings,
}));

import { ensureReportIntake, POSTMASTER_LOCAL_PART, DMARC_LOCAL_PART } from './report-intake-reconciler.js';
import type { Database } from '../../db/index.js';

/**
 * `postmaster@` must be a real account, not just a registered pattern.
 *
 * The reconciler has listed `postmaster@*` in REQUIRED_INTAKE_PATTERNS since it
 * was written, and its own docblock records that this is not sufficient —
 * Stalwart refuses an unregistered report address at RCPT. Nothing created the
 * account. Measured on DEV 2026-09-16:
 *
 *     550 5.5.0 Mailbox not found    <- RCPT TO postmaster@<apex>
 *     385 messages queued to it, retrying every 24h
 *
 * It is the envelope sender on platform mail, so every DSN routed back to it
 * was undeliverable — and each expiry generated another DSN to the same dead
 * address.
 */

interface DomainRow { tenantId: string; emailDomainId: string; domainName: string }

/**
 * A db stub for the THREE queries the reconciler runs. It branches on the
 * projection it was handed, not on call shape:
 *
 *   { tenantId, emailDomainId, domainName }            — enabled email domains
 *   { id, tenantId, fullAddress, usedMb }              — the reap scan
 *   { id, stalwartPrincipalId, quotaMb, platformManaged } + .limit(1)
 *                                                      — per-mailbox existence
 *
 * The previous version keyed off call shape alone, so once the reap scan was
 * added it received the DOMAIN list as if those rows were mailboxes — the reap
 * loop then ran once per domain against a mock with no `deleteMailbox`, threw,
 * and was swallowed by the reconciler's own catch. Every test still passed.
 */
function makeDb(opts: {
  domains?: readonly DomainRow[];
  /** Rows for the per-(domain, local_part) existence lookup. */
  existing?: readonly unknown[];
  /** Rows the reap scan should find (platform-managed and at/over the cap). */
  full?: readonly unknown[];
}): Database {
  const { domains = [], existing = [], full = [] } = opts;
  const resultFor = (proj: Record<string, unknown> | undefined): readonly unknown[] => {
    const keys = new Set(Object.keys(proj ?? {}));
    if (keys.has('usedMb')) return full;
    if (keys.has('platformManaged')) return existing;
    return domains;
  };
  const chainFor = (proj: Record<string, unknown> | undefined) => {
    const rows = resultFor(proj);
    const whereResult = {
      limit: () => Promise.resolve(rows),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(res, rej),
    };
    const chain: Record<string, unknown> = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => whereResult,
    };
    return chain;
  };
  return {
    select: (proj?: Record<string, unknown>) => chainFor(proj),
  } as unknown as Database;
}

const db = (d: readonly DomainRow[]): Database => makeDb({ domains: d });

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

beforeEach(() => {
  createMailbox.mockReset().mockResolvedValue({ id: 'mb' });
  deleteMailbox.mockReset().mockResolvedValue(undefined);
  updateMailbox.mockReset().mockResolvedValue(undefined);
  reportSettingsGet.mockReset().mockResolvedValue({ inboundReportAddresses: {} });
  reportSettingsUpdate.mockReset().mockResolvedValue({});
  actionReloadSettings.mockReset().mockResolvedValue(undefined);
});

const created = () =>
  createMailbox.mock.calls.map((c) => (c[3] as { local_part: string }).local_part);

describe('report intake provisions postmaster@, not just the pattern', () => {
  const ONE = [{ tenantId: 't1', emailDomainId: 'ed1', domainName: 'example.test' }];

  it('creates a postmaster@ mailbox for an enabled email domain', async () => {
    await ensureReportIntake(db(ONE), logger);
    expect(created()).toContain(POSTMASTER_LOCAL_PART);
  });

  it('still creates dmarc@ — postmaster must not displace it', async () => {
    await ensureReportIntake(db(ONE), logger);
    expect(created()).toContain(DMARC_LOCAL_PART);
    expect(created()).toHaveLength(2);
  });

  it('creates both for EVERY enabled domain, not just the first', async () => {
    await ensureReportIntake(db([
      { tenantId: 't1', emailDomainId: 'ed1', domainName: 'one.example.test' },
      { tenantId: 't2', emailDomainId: 'ed2', domainName: 'two.example.test' },
    ]), logger);
    expect(created()).toHaveLength(4);
    const domainsTouched = createMailbox.mock.calls.map((c) => c[2]);
    expect(new Set(domainsTouched)).toEqual(new Set(['ed1', 'ed2']));
  });

  it('sizes both intakes as small transit buffers, not mailboxes', async () => {
    // This assertion used to read `postmaster > dmarc`, on the theory that a
    // DSN box needs headroom. Operator decision 2026-09-16 replaced that:
    // NOTHING reads either mailbox after ingest — the DMARC poller destroys
    // each report it consumes — so headroom is just unbounded growth, and
    // production had accumulated 385 undeliverable DSNs. Both are 50 MB and
    // reaped below. Inverted rather than deleted: a size creeping back up
    // here would mean the transit-buffer decision had been quietly undone.
    await ensureReportIntake(db(ONE), logger);
    const byLocalPart = Object.fromEntries(
      createMailbox.mock.calls.map((c) => {
        const input = c[3] as { local_part: string; quota_mb: number };
        return [input.local_part, input.quota_mb];
      }),
    );
    expect(byLocalPart[POSTMASTER_LOCAL_PART]).toBe(50);
    expect(byLocalPart[DMARC_LOCAL_PART]).toBe(50);
  });

  it('creates intake mailboxes on the PLATFORM path, not the tenant path', async () => {
    // The whole storm: this reconciler called the tenant-facing createMailbox,
    // so every tenant at its plan cap was rejected 409 and emailed "remove a
    // mailbox or upgrade your plan" for a mailbox the PLATFORM was creating —
    // 9 per tick, ~108 emails/hour, which then saturated the sending limit of
    // the domain the notification sender belongs to.
    await ensureReportIntake(db(ONE), logger);
    expect(createMailbox).toHaveBeenCalledTimes(2);
    for (const call of createMailbox.mock.calls) {
      expect(call[4]).toEqual({ platformManaged: true });
    }
  });

  it('reaps a full intake mailbox and puts it back in the same pass', async () => {
    // Delete-and-recreate is the reap: no window where mail to the address has
    // nowhere to land, because the create loop runs after it in this same call.
    const dbWithFull = makeDb({
      domains: ONE,
      full: [{ id: 'mb-full', tenantId: 't1', fullAddress: 'postmaster@example.test', usedMb: 41 }],
    });
    await ensureReportIntake(dbWithFull, logger);
    expect(deleteMailbox).toHaveBeenCalledWith(dbWithFull, 't1', 'mb-full');
    // Recreated, and still on the platform path.
    expect(created()).toEqual([DMARC_LOCAL_PART, POSTMASTER_LOCAL_PART]);
  });

  it('corrects the size cap on an existing platform-managed intake mailbox', async () => {
    const dbExisting = makeDb({
      domains: ONE,
      existing: [{ id: 'mb-old', stalwartPrincipalId: 'p1', quotaMb: 512, platformManaged: true }],
    });
    const result = await ensureReportIntake(dbExisting, logger);
    expect(updateMailbox).toHaveBeenCalledWith(dbExisting, 't1', 'mb-old', { quota_mb: 50 });
    expect(result.resized).toBeGreaterThan(0);
    // Already present, so nothing is created.
    expect(createMailbox).not.toHaveBeenCalled();
  });

  it("leaves a tenant's own postmaster@ alone — never resized, never reaped", async () => {
    // There is no reserved-local-part guard, so a tenant CAN own postmaster@.
    // Shrinking it to 50 MB or emptying it would destroy their mail.
    const dbTenantOwned = makeDb({
      domains: ONE,
      existing: [{ id: 'mb-theirs', stalwartPrincipalId: 'p2', quotaMb: 5120, platformManaged: false }],
    });
    const result = await ensureReportIntake(dbTenantOwned, logger);
    expect(updateMailbox).not.toHaveBeenCalled();
    expect(deleteMailbox).not.toHaveBeenCalled();
    expect(result.resized).toBe(0);
  });

  it('reports only dmarc@ as a rua= target', async () => {
    // `rua=` records must never be pointed at postmaster@ — it receives DSNs,
    // not aggregate reports, and mixing them would put report parsing behind a
    // mailbox that fills with bounces.
    const result = await ensureReportIntake(db(ONE), logger);
    expect(result.dmarcAddresses).toEqual(['dmarc@example.test']);
  });

  it('keeps postmaster@* registered as an intake pattern', async () => {
    await ensureReportIntake(db(ONE), logger);
    const patch = reportSettingsUpdate.mock.calls[0]?.[0] as
      { patch: { inboundReportAddresses: Record<string, boolean> } } | undefined;
    expect(patch?.patch.inboundReportAddresses).toHaveProperty('postmaster@*', true);
  });

  it('does not recreate a mailbox that already has a row', async () => {
    await ensureReportIntake(makeDb(ONE, [{ id: 'existing', stalwartPrincipalId: 'p1' }]), logger);
    expect(createMailbox).not.toHaveBeenCalled();
  });
});
