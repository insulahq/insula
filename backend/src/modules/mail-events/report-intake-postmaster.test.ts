import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createMailbox, deleteMailbox, updateMailbox } = vi.hoisted(() => ({
  createMailbox: vi.fn(),
  deleteMailbox: vi.fn(),
  updateMailbox: vi.fn(),
}));
vi.mock('../mailboxes/service.js', () => ({ createMailbox, deleteMailbox, updateMailbox }));

const { listMailboxAliases, createMailboxAlias } = vi.hoisted(() => ({
  listMailboxAliases: vi.fn(),
  createMailboxAlias: vi.fn(),
}));
vi.mock('../mailbox-aliases/service.js', () => ({ listMailboxAliases, createMailboxAlias }));

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
  createMailbox.mockReset().mockResolvedValue({ id: 'mb-created' });
  deleteMailbox.mockReset().mockResolvedValue(undefined);
  updateMailbox.mockReset().mockResolvedValue(undefined);
  listMailboxAliases.mockReset().mockResolvedValue([]);
  createMailboxAlias.mockReset().mockResolvedValue(undefined);
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

  it('creates ONE mailbox per domain — dmarc@ is an alias, not a second account', async () => {
    // Operator question 2026-09-16: why two mailboxes? Nothing justified it.
    // Both patterns are registered identically in Stalwart, neither mailbox
    // stores anything (0 MB used across 19 of them on a live cluster, because
    // report-analysis intercepts before storage), and postmaster@ is mandatory
    // per RFC 5321 while dmarc@ is a name we chose.
    await ensureReportIntake(db(ONE), logger);
    expect(created()).toEqual([POSTMASTER_LOCAL_PART]);
    expect(createMailboxAlias).toHaveBeenCalledWith(
      expect.anything(), 't1', 'mb-created', { local_part: DMARC_LOCAL_PART },
    );
  });

  it('still reports dmarc@ as the rua= target, so published records keep working', async () => {
    // The alias was chosen over repointing rua= at postmaster@ precisely so
    // that 10 live `_dmarc` records need no migration and no propagation
    // window. If this stops reporting the address, that promise is broken.
    const result = await ensureReportIntake(db(ONE), logger);
    expect(result.dmarcAddresses).toEqual([`${DMARC_LOCAL_PART}@example.test`]);
  });

  it('covers EVERY enabled domain, not just the first', async () => {
    await ensureReportIntake(db([
      { tenantId: 't1', emailDomainId: 'ed1', domainName: 'one.example.test' },
      { tenantId: 't2', emailDomainId: 'ed2', domainName: 'two.example.test' },
    ]), logger);
    expect(created()).toHaveLength(2);
    expect(createMailboxAlias).toHaveBeenCalledTimes(2);
  });

  it('sizes the intake as a small transit buffer, not a mailbox', async () => {
    // This asserted `postmaster > dmarc`, on the theory that a DSN box needs
    // headroom. Operator decision 2026-09-16 replaced that: nothing reads it
    // after ingest, so headroom is just unbounded growth. Inverted rather than
    // deleted — a size creeping back up here means the decision was undone.
    await ensureReportIntake(db(ONE), logger);
    const input = createMailbox.mock.calls[0]?.[3] as { quota_mb: number };
    expect(input.quota_mb).toBe(50);
  });

  it('creates the intake on the PLATFORM path, not the tenant path', async () => {
    // The whole storm: this reconciler called the tenant-facing createMailbox,
    // so every tenant at its plan cap was rejected 409 and emailed "remove a
    // mailbox or upgrade your plan" for a mailbox the PLATFORM was creating.
    await ensureReportIntake(db(ONE), logger);
    for (const call of createMailbox.mock.calls) {
      expect(call[4]).toEqual({ platformManaged: true });
    }
  });

  it('reaps a full intake mailbox and puts it back in the same pass', async () => {
    const dbWithFull = makeDb({
      domains: ONE,
      full: [{ id: 'mb-full', tenantId: 't1', fullAddress: 'postmaster@example.test', usedMb: 41 }],
    });
    await ensureReportIntake(dbWithFull, logger);
    expect(deleteMailbox).toHaveBeenCalledWith(dbWithFull, 't1', 'mb-full');
    expect(created()).toEqual([POSTMASTER_LOCAL_PART]);
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

describe('converging an existing second intake mailbox into an alias', () => {
  const ONE2 = [{ tenantId: 't1', emailDomainId: 'ed1', domainName: 'example.test' }];

  /** A db fake that answers the dmarc@ lookup as well as the postmaster one. */
  function dbWithLegacyDmarc(legacy: Record<string, unknown> | null) {
    let existenceCalls = 0;
    const resultFor = (proj: Record<string, unknown> | undefined): readonly unknown[] => {
      const keys = new Set(Object.keys(proj ?? {}));
      if (keys.has('usedMb') && keys.has('platformManaged')) {
        // the dmarc@ legacy lookup inside ensureDmarcAlias
        return legacy ? [legacy] : [];
      }
      if (keys.has('usedMb')) return []; // the reap scan
      if (keys.has('platformManaged')) {
        // the per-(domain, local_part) existence lookup: postmaster exists
        existenceCalls += 1;
        return [{ id: 'mb-postmaster', stalwartPrincipalId: 'p1', quotaMb: 50, platformManaged: true }];
      }
      return ONE2;
    };
    const chainFor = (proj?: Record<string, unknown>) => {
      const rows = resultFor(proj);
      const whereResult = {
        limit: () => Promise.resolve(rows),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej),
      };
      const chain: Record<string, unknown> = { from: () => chain, innerJoin: () => chain, where: () => whereResult };
      return chain;
    };
    return { select: (proj?: Record<string, unknown>) => chainFor(proj), _existenceCalls: () => existenceCalls } as never;
  }

  it('deletes an EMPTY platform-managed dmarc@ mailbox and aliases it instead', async () => {
    const db2 = dbWithLegacyDmarc({ id: 'mb-dmarc', usedMb: 0, platformManaged: true });
    await ensureReportIntake(db2, logger);
    expect(deleteMailbox).toHaveBeenCalledWith(db2, 't1', 'mb-dmarc');
    expect(createMailboxAlias).toHaveBeenCalledWith(
      expect.anything(), 't1', 'mb-postmaster', { local_part: DMARC_LOCAL_PART },
    );
  });

  it("never touches a TENANT'S own dmarc@ mailbox", async () => {
    // There is no reserved-local-part guard, so a tenant can own dmarc@.
    // Deleting it would destroy their mail.
    const db2 = dbWithLegacyDmarc({ id: 'mb-theirs', usedMb: 0, platformManaged: false });
    const r = await ensureReportIntake(db2, logger);
    expect(deleteMailbox).not.toHaveBeenCalled();
    expect(createMailboxAlias).not.toHaveBeenCalled();
    // Still a valid rua= target, because it is one.
    expect(r.dmarcAddresses).toEqual([`${DMARC_LOCAL_PART}@example.test`]);
  });

  it('refuses to converge a dmarc@ mailbox that actually holds mail', async () => {
    // Should be impossible (report-analysis intercepts before storage), so if
    // it happens something upstream changed and deleting would lose mail.
    const db2 = dbWithLegacyDmarc({ id: 'mb-full', usedMb: 12, platformManaged: true });
    const r = await ensureReportIntake(db2, logger);
    expect(deleteMailbox).not.toHaveBeenCalled();
    expect(r.dmarcAddresses).toEqual([`${DMARC_LOCAL_PART}@example.test`]);
  });
});
