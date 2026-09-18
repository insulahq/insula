import { describe, it, expect, vi, beforeEach } from 'vitest';

const { arfExternalReportList, arfExternalReportDestroy } = vi.hoisted(() => ({
  arfExternalReportList: vi.fn(),
  arfExternalReportDestroy: vi.fn(),
}));
vi.mock('../stalwart-jmap/client.js', () => ({ arfExternalReportList, arfExternalReportDestroy }));

const { notifyAdminOperationalEvent } = vi.hoisted(() => ({ notifyAdminOperationalEvent: vi.fn() }));
vi.mock('../notifications/events.js', () => ({ notifyAdminOperationalEvent }));

const { pollAbuseReports } = await import('./abuse-reports.js');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

interface StoredRow {
  id: string;
  stalwartReportId: string;
  tenantId: string | null;
  domain: string | null;
  feedbackType: string;
  originalMailFrom: string | null;
  sourceIp: string | null;
  reporter: string | null;
  incidents: number;
  receivedAt: Date;
  notifiedAt: Date | null;
}

/**
 * A db that actually stores, so "the row landed" is distinguishable from "the
 * call was made". The UNIQUE on `stalwart_report_id` is modelled too, because
 * a redelivery after a mid-poll crash is the expected path here — a fake that
 * inserted blindly would hide a double-announce.
 */
let rows: StoredRow[] = [];
/** Email domains the platform hosts, for attribution. */
let hosted: { domainName: string; tenantId: string }[] = [];
/** Make the next insert throw, to exercise the persist-failure path. */
let insertFails = false;

function makeDb() {
  return {
    select: (proj?: Record<string, unknown>) => {
      const keys = new Set(Object.keys(proj ?? {}));
      const chain: Record<string, unknown> = {
        from: () => chain,
        innerJoin: () => chain,
        leftJoin: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(pending()),
        where: () => {
          // The attribution lookup selects { tenantId, domainName }.
          if (keys.has('domainName')) return Promise.resolve(hosted);
          return chain;
        },
      };
      return chain;
    },
    insert: () => ({
      values: (v: StoredRow) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            if (insertFails) return Promise.reject(new Error('insert blew up'));
            if (rows.some((r) => r.stalwartReportId === v.stalwartReportId)) {
              return Promise.resolve([]);            // UNIQUE conflict
            }
            rows.push({ ...v, notifiedAt: null });
            return Promise.resolve([{ id: v.id }]);
          },
        }),
      }),
    }),
    update: () => ({
      set: (patch: { notifiedAt: Date }) => ({
        where: () => {
          for (const r of rows) if (r.notifiedAt === null) r.notifiedAt = patch.notifiedAt;
          return Promise.resolve();
        },
      }),
    }),
  } as never;
}

function pending(): StoredRow[] {
  return rows.filter((r) => r.notifiedAt === null);
}

function arf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sw-1',
    from: 'abuse-desk@reporter.test',
    subject: 'Spam complaint',
    receivedAt: '2026-09-18T10:00:00Z',
    report: {
      feedbackType: 'abuse',
      incidents: 1,
      originalMailFrom: 'sender@tenant.test',
      originalRcptTo: 'victim@reporter.test',
      sourceIp: '203.0.113.9',
      reportingMta: 'mx.reporter.test',
      // Object keyed by value, NOT an array — the shape Stalwart sends.
      reportedDomains: { 'tenant.test': true },
    },
    ...over,
  };
}

beforeEach(() => {
  rows = [];
  hosted = [{ domainName: 'tenant.test', tenantId: 't1' }];
  insertFails = false;
  arfExternalReportList.mockReset().mockResolvedValue([]);
  arfExternalReportDestroy.mockReset().mockResolvedValue({});
  notifyAdminOperationalEvent.mockReset().mockResolvedValue(undefined);
});

describe('ingesting ARF abuse reports', () => {
  it('stores a complaint and attributes it to the reported tenant', async () => {
    arfExternalReportList.mockResolvedValue([arf()]);
    const r = await pollAbuseReports(makeDb(), logger);
    expect(r.stored).toBe(1);
    expect(rows[0]).toMatchObject({
      stalwartReportId: 'sw-1',
      tenantId: 't1',
      domain: 'tenant.test',
      feedbackType: 'abuse',
      sourceIp: '203.0.113.9',
    });
  });

  it('reads reportedDomains as an OBJECT, not an array', async () => {
    // Stalwart sends `{"tenant.test": true}`. `.map()` over that yields
    // nothing, and the complaint would silently lose its attribution.
    arfExternalReportList.mockResolvedValue([arf()]);
    await pollAbuseReports(makeDb(), logger);
    expect(rows[0].domain).toBe('tenant.test');
    expect(rows[0].tenantId).toBe('t1');
  });

  it('keeps a complaint about a domain we do NOT host, unattributed', async () => {
    // Often a spoof of one of ours. Dropping it would make the abuse desk look
    // quiet exactly when somebody is forging our tenants.
    hosted = [];
    arfExternalReportList.mockResolvedValue([arf()]);
    const r = await pollAbuseReports(makeDb(), logger);
    expect(r.stored).toBe(1);
    expect(rows[0].tenantId).toBeNull();
    expect(rows[0].domain).toBe('tenant.test');
  });

  it('falls back to the envelope sender domain when no domain is reported', async () => {
    arfExternalReportList.mockResolvedValue([
      arf({ report: { feedbackType: 'abuse', originalMailFrom: 'sender@tenant.test' } }),
    ]);
    await pollAbuseReports(makeDb(), logger);
    expect(rows[0].tenantId).toBe('t1');
  });

  it('NOTIFIES the admin roster, deduped on the Stalwart report id', async () => {
    arfExternalReportList.mockResolvedValue([arf()]);
    const r = await pollAbuseReports(makeDb(), logger);
    expect(r.notified).toBe(1);
    expect(notifyAdminOperationalEvent).toHaveBeenCalledTimes(1);
    const [, subsystem, payload, dedupeKey] = notifyAdminOperationalEvent.mock.calls[0];
    expect(subsystem).toBe('mail');
    expect(dedupeKey).toBe('abuse-report:sw-1');
    expect(payload.detail).toContain('tenant.test');
    expect(payload.recommendedAction).not.toBe('');
  });

  it('does NOT re-announce a report already notified', async () => {
    arfExternalReportList.mockResolvedValue([arf()]);
    const db = makeDb();
    await pollAbuseReports(db, logger);
    notifyAdminOperationalEvent.mockClear();
    // Same report redelivered — Stalwart's destroy failed last tick.
    await pollAbuseReports(db, logger);
    expect(notifyAdminOperationalEvent).not.toHaveBeenCalled();
  });

  it('leaves notified_at unset when the notification throws, so it retries', async () => {
    notifyAdminOperationalEvent.mockRejectedValue(new Error('smtp down'));
    arfExternalReportList.mockResolvedValue([arf()]);
    const db = makeDb();
    const r = await pollAbuseReports(db, logger);
    expect(r.stored).toBe(1);
    expect(r.notified).toBe(0);
    expect(rows[0].notifiedAt).toBeNull();

    notifyAdminOperationalEvent.mockResolvedValue(undefined);
    arfExternalReportList.mockResolvedValue([]);      // nothing new to fetch
    const again = await pollAbuseReports(db, logger);
    expect(again.notified).toBe(0);                   // no fetch, no announce pass
    expect(rows[0].notifiedAt).toBeNull();
  });

  it('destroys what it consumed so the next poll does not refetch it', async () => {
    arfExternalReportList.mockResolvedValue([arf()]);
    await pollAbuseReports(makeDb(), logger);
    expect(arfExternalReportDestroy).toHaveBeenCalledWith(expect.objectContaining({ ids: ['sw-1'] }));
  });

  it('does NOT destroy a report it failed to store', async () => {
    // Destroying an unstored complaint loses it permanently — Stalwart is the
    // only copy until the row is committed.
    insertFails = true;
    arfExternalReportList.mockResolvedValue([arf()]);
    const r = await pollAbuseReports(makeDb(), logger);
    expect(r.stored).toBe(0);
    expect(arfExternalReportDestroy).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('consumes but does not store an auth-failure report', async () => {
    // A DMARC forensic report is not an abuse complaint. It still has to be
    // destroyed, or every poll refetches it forever.
    arfExternalReportList.mockResolvedValue([
      arf({ id: 'sw-af', report: { feedbackType: 'auth-failure' } }),
    ]);
    const r = await pollAbuseReports(makeDb(), logger);
    expect(r.stored).toBe(0);
    expect(r.skipped).toBe(1);
    expect(arfExternalReportDestroy).toHaveBeenCalledWith(expect.objectContaining({ ids: ['sw-af'] }));
  });

  it('stores a fraud report — abuse is not the only actionable type', async () => {
    arfExternalReportList.mockResolvedValue([arf({ id: 'sw-f', report: { feedbackType: 'fraud' } })]);
    const r = await pollAbuseReports(makeDb(), logger);
    expect(r.stored).toBe(1);
    expect(rows[0].feedbackType).toBe('fraud');
  });

  it('treats an unknown feedback type as an incident rather than dropping it', async () => {
    // ARF is extensible. A type nobody has seen is still somebody complaining.
    arfExternalReportList.mockResolvedValue([arf({ id: 'sw-x', report: {} })]);
    const r = await pollAbuseReports(makeDb(), logger);
    expect(r.stored).toBe(1);
    expect(rows[0].feedbackType).toBe('other');
  });

  it('strips the angle brackets ARF carries, so addresses are not <bracketed>', async () => {
    // RFC 5965 gives these as angle-addr. Stored raw they reached the panels
    // and the admin notification verbatim — found by driving a real report
    // through on DEV, not by any unit test.
    arfExternalReportList.mockResolvedValue([arf({
      from: '<abuse-desk@reporter.test>',
      report: {
        feedbackType: 'abuse',
        originalMailFrom: '<sender@tenant.test>',
        originalRcptTo: '<victim@reporter.test>',
        reportedDomains: { 'tenant.test': true },
      },
    })]);
    await pollAbuseReports(makeDb(), logger);
    expect(rows[0].originalMailFrom).toBe('sender@tenant.test');
    expect(rows[0].reporter).toBe('abuse-desk@reporter.test');
    const [, , payload] = notifyAdminOperationalEvent.mock.calls[0];
    expect(payload.detail).not.toContain('<');
  });

  it('says "An abuse report", not "A abuse report"', async () => {
    arfExternalReportList.mockResolvedValue([arf()]);
    await pollAbuseReports(makeDb(), logger);
    const [, , payload] = notifyAdminOperationalEvent.mock.calls[0];
    expect(payload.detail).toMatch(/^An abuse report/);
  });

  it('keeps the article correct for a consonant type', async () => {
    arfExternalReportList.mockResolvedValue([arf({ id: 'sw-f', report: { feedbackType: 'fraud' } })]);
    await pollAbuseReports(makeDb(), logger);
    const [, , payload] = notifyAdminOperationalEvent.mock.calls[0];
    expect(payload.detail).toMatch(/^A fraud report/);
  });

  it('never throws when Stalwart is unreachable', async () => {
    arfExternalReportList.mockRejectedValue(new Error('connection refused'));
    const r = await pollAbuseReports(makeDb(), logger);
    expect(r).toMatchObject({ fetched: 0, stored: 0 });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('does nothing at all when there are no reports', async () => {
    const r = await pollAbuseReports(makeDb(), logger);
    expect(r.fetched).toBe(0);
    expect(arfExternalReportDestroy).not.toHaveBeenCalled();
    expect(notifyAdminOperationalEvent).not.toHaveBeenCalled();
  });
});
