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

import { ensureReportIntake, POSTMASTER_LOCAL_PART, DMARC_LOCAL_PART, ABUSE_LOCAL_PART } from './report-intake-reconciler.js';
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
 *   { id } alone                                       — "is this address
 *                                                        already answered?"
 *                                                        (mailbox / list / alias)
 *
 * The previous version keyed off call shape alone, so once the reap scan was
 * added it received the DOMAIN list as if those rows were mailboxes — the reap
 * loop then ran once per domain against a mock with no `deleteMailbox`, threw,
 * and was swallowed by the reconciler's own catch. Every test still passed.
 *
 * The bare `{ id }` case earns its own branch for the same reason: it fell
 * through to the domain list, so every address looked occupied and the alias
 * step silently did nothing.
 */
function makeDb(opts: {
  domains?: readonly DomainRow[];
  /** Rows for the per-(domain, local_part) existence lookup. */
  existing?: readonly unknown[];
  /** Rows the reap scan should find (platform-managed and at/over the cap). */
  full?: readonly unknown[];
  /**
   * Non-empty when the address being ensured is already answered by something
   * the platform does not own — a tenant's own `abuse@` mailbox, a mailing
   * list, an alias elsewhere. Drives the occupancy probe.
   */
  answered?: readonly unknown[];
}): Database {
  const { domains = [], existing = [], full = [], answered = [] } = opts;
  const resultFor = (proj: Record<string, unknown> | undefined): readonly unknown[] => {
    const keys = new Set(Object.keys(proj ?? {}));
    if (keys.has('usedMb')) return full;
    if (keys.has('platformManaged')) return existing;
    // A projection of exactly `{ id }` is the occupancy probe. Checked before
    // the domain fallback, or every address reads as taken.
    if (keys.size === 1 && keys.has('id')) return answered;
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
    // 2 domains x 2 aliases. Was 2 when dmarc@ was the only alias; abuse@
    // joined it 2026-09-17 (RFC 2142 makes both mandatory). Inverted rather
    // than deleted: dropping back to 2 would mean a domain lost an alias.
    expect(createMailboxAlias).toHaveBeenCalledTimes(4);
  });

  it('gives every domain an abuse@ alias on the same intake mailbox', async () => {
    // RFC 2142 makes abuse@ mandatory alongside postmaster@, and nothing
    // created it: a remote operator, a blocklist, or a provider's abuse desk
    // trying to report a problem with a tenant's mail got 550. Operator
    // decision 2026-09-17: an alias on the postmaster intake, not a mailbox —
    // same reader, and a second mailbox is a second thing to reap.
    await ensureReportIntake(db(ONE), logger);
    const aliased = createMailboxAlias.mock.calls.map((c) => (c[3] as { local_part: string }).local_part);
    expect(aliased).toContain(ABUSE_LOCAL_PART);
    expect(aliased).toContain(DMARC_LOCAL_PART);
    // On the SAME mailbox — one intake, several names.
    const targets = new Set(createMailboxAlias.mock.calls.map((c) => c[2]));
    expect(targets.size).toBe(1);
  });

  it('does not report abuse@ as a rua= target', async () => {
    // Only dmarc@ belongs in a published `rua=`. Leaking abuse@ into that list
    // would point receivers' aggregate reports at the abuse desk.
    const r = await ensureReportIntake(db(ONE), logger);
    expect(r.dmarcAddresses).toEqual([`${DMARC_LOCAL_PART}@example.test`]);
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
      // "is this address already answered?" — nothing owns it in these cases.
      if (keys.size === 1 && keys.has('id')) return [];
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

  /** Postmaster intake exists; every OTHER address is already answered. */
  function dbAnswered() {
    const resultFor = (proj: Record<string, unknown> | undefined): readonly unknown[] => {
      const keys = new Set(Object.keys(proj ?? {}));
      if (keys.has('usedMb') && keys.has('platformManaged')) return [];
      if (keys.has('usedMb')) return [];
      if (keys.size === 1 && keys.has('id')) return [{ id: 'somebody-elses' }];
      if (keys.has('platformManaged')) {
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
    return { select: (proj?: Record<string, unknown>) => chainFor(proj) } as never;
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
    // Narrowed from "no alias at all" to "no dmarc@ alias": the assertion was
    // a proxy for the real contract, and since abuse@ joined the intake list a
    // blanket check would forbid the unrelated address from being created.
    const aliased = createMailboxAlias.mock.calls.map((c) => (c[3] as { local_part: string }).local_part);
    expect(aliased).not.toContain(DMARC_LOCAL_PART);
    // One tenant-owned address must not block the other from being ensured.
    expect(aliased).toContain(ABUSE_LOCAL_PART);
    // Still a valid rua= target, because it is one.
    expect(r.dmarcAddresses).toEqual([`${DMARC_LOCAL_PART}@example.test`]);
  });

  it('leaves an address alone when something already answers it', async () => {
    // A tenant's own abuse@ mailbox, a mailing list, an alias elsewhere — all
    // mean SMTP already says 250 for that address, which is the entire goal.
    // Claiming it would either fail with a 409 on every tick or, worse,
    // shadow a real abuse desk somebody reads.
    const occupied = dbAnswered();
    await ensureReportIntake(occupied, logger);
    expect(createMailboxAlias).not.toHaveBeenCalled();
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

describe('the 30-day reap', () => {
  const ONE3 = [{ tenantId: 't1', emailDomainId: 'ed1', domainName: 'example.test' }];

  it('empties a mailbox that is DUE by age even though it is empty', async () => {
    // The size trigger fires at 40 MB and in practice never does:
    // report-analysis intercepts before storage, so these mailboxes measure
    // 0 MB. Operator decision 2026-09-16 — empty them every 30 days anyway,
    // so a DSN Stalwart chose not to consume cannot sit forever.
    const due = new Date(Date.now() - 31 * 86_400_000);
    const db3 = makeDb({
      domains: ONE3,
      full: [{ id: 'mb-old', tenantId: 't1', fullAddress: 'postmaster@example.test', usedMb: 0, lastReapedAt: due }],
    });
    await ensureReportIntake(db3, logger);
    expect(deleteMailbox).toHaveBeenCalledWith(db3, 't1', 'mb-old');
  });

  it('recreates it on the platform path, which stamps it and stops a reap loop', async () => {
    // THE loop guard. Without a fresh `last_reaped_at` the recreate leaves it
    // NULL, the next tick sees it as due, and the reconciler
    // delete-and-recreates every five minutes forever — the same runaway shape
    // as the notification storm, on mailboxes instead of email. The stamp is
    // applied by createMailbox when platformManaged is set, so that flag
    // reaching it is the property to hold.
    const due = new Date(Date.now() - 31 * 86_400_000);
    const db3 = makeDb({
      domains: ONE3,
      full: [{ id: 'mb-old', tenantId: 't1', fullAddress: 'postmaster@example.test', usedMb: 0, lastReapedAt: due }],
    });
    await ensureReportIntake(db3, logger);
    expect(createMailbox).toHaveBeenCalled();
    for (const call of createMailbox.mock.calls) {
      expect(call[4]).toEqual({ platformManaged: true });
    }
  });

  it('does nothing when the scan finds none due — the steady state', async () => {
    const db3 = makeDb({ domains: ONE3, full: [] });
    await ensureReportIntake(db3, logger);
    expect(deleteMailbox).not.toHaveBeenCalled();
  });
});
