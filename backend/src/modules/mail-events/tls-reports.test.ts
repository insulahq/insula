import { describe, it, expect, vi, beforeEach } from 'vitest';

const { tlsExternalReportList, tlsExternalReportDestroy } = vi.hoisted(() => ({
  tlsExternalReportList: vi.fn(),
  tlsExternalReportDestroy: vi.fn(),
}));
vi.mock('../stalwart-jmap/client.js', () => ({ tlsExternalReportList, tlsExternalReportDestroy }));

const { pollTlsReports, summariseReport } = await import('./tls-reports.js');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

interface StoredRow {
  stalwartReportId: string;
  tenantId: string | null;
  policyDomain: string | null;
  orgName: string | null;
  successfulSessions: number;
  failedSessions: number;
  failures: unknown[];
}

let rows: StoredRow[] = [];
let hosted: { tenantId: string }[] = [];
let insertFails = false;

function makeDb() {
  return {
    select: () => {
      const chain: Record<string, unknown> = {
        from: () => chain,
        innerJoin: () => chain,
        leftJoin: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve([]),
        where: () => Promise.resolve(hosted),
      };
      return chain;
    },
    insert: () => ({
      values: (v: StoredRow) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            if (insertFails) return Promise.reject(new Error('insert blew up'));
            if (rows.some((r) => r.stalwartReportId === v.stalwartReportId)) return Promise.resolve([]);
            rows.push(v);
            return Promise.resolve([{ id: 'row' }]);
          },
        }),
      }),
    }),
  } as never;
}

/**
 * A report in the shape Stalwart actually sends: `policies` and
 * `failureDetails` are objects keyed by decimal-string INDEX, while `mxHosts`
 * is keyed BY VALUE. Building fixtures as arrays would make these tests pass
 * against a parser that cannot read the real thing.
 */
function tlsReport(over: Record<string, unknown> = {}) {
  return {
    id: 'sw-tls-1',
    from: 'noreply-smtp-tls-reporting@reporter.test',
    subject: 'Report Domain: tenant.test',
    receivedAt: '2026-09-18T06:00:00Z',
    report: {
      organizationName: 'Reporter Inc',
      contactInfo: 'tls-reports@reporter.test',
      reportId: 'reporter-2026-09-18',
      dateRangeStart: '2026-09-17T00:00:00Z',
      dateRangeEnd: '2026-09-18T00:00:00Z',
      policies: {
        '0': {
          policyType: 'sts',
          policyDomain: 'tenant.test',
          mxHosts: { 'mx.tenant.test': true },
          totalSuccessfulSessions: 480,
          totalFailedSessions: 3,
          failureDetails: {
            '0': {
              resultType: 'certificate-expired',
              failedSessionCount: 2,
              receivingMxHostname: 'mx.tenant.test',
              sendingMtaIp: '198.51.100.7',
              failureReasonCode: null,
              additionalInformation: null,
            },
            '1': {
              resultType: 'starttls-not-supported',
              failedSessionCount: 1,
              receivingMxHostname: 'mx.tenant.test',
              sendingMtaIp: '198.51.100.8',
              failureReasonCode: null,
              additionalInformation: null,
            },
          },
        },
      },
    },
    ...over,
  };
}

beforeEach(() => {
  rows = [];
  hosted = [{ tenantId: 't1' }];
  insertFails = false;
  tlsExternalReportList.mockReset().mockResolvedValue([]);
  tlsExternalReportDestroy.mockReset().mockResolvedValue({});
});

describe('summariseReport', () => {
  it('reads policies and failureDetails as INDEX-KEYED objects', async () => {
    // `.map()` over `{"0": …}` yields nothing, which would report a clean zero
    // — i.e. "TLS is fine" — for a report that recorded failures.
    const s = summariseReport(tlsReport() as never);
    expect(s.successfulSessions).toBe(480);
    expect(s.failedSessions).toBe(3);
    expect(s.failures).toHaveLength(2);
    expect(s.failures.map((f) => f.resultType)).toEqual([
      'certificate-expired', 'starttls-not-supported',
    ]);
  });

  it('reads mxHosts as a VALUE-keyed object', async () => {
    expect(summariseReport(tlsReport() as never).mxHosts).toEqual(['mx.tenant.test']);
  });

  it('sums across multiple policies', async () => {
    const r = tlsReport({
      report: {
        policies: {
          '0': { policyDomain: 'tenant.test', totalSuccessfulSessions: 10, totalFailedSessions: 1 },
          '1': { policyDomain: 'tenant.test', totalSuccessfulSessions: 5, totalFailedSessions: 2 },
        },
      },
    });
    const s = summariseReport(r as never);
    expect(s.successfulSessions).toBe(15);
    expect(s.failedSessions).toBe(3);
  });

  it('survives a report with no policies at all', async () => {
    const s = summariseReport({ id: 'x', report: {} } as never);
    expect(s).toMatchObject({ successfulSessions: 0, failedSessions: 0, policyDomain: null });
    expect(s.failures).toEqual([]);
  });
});

describe('ingesting TLS reports', () => {
  it('stores a report and attributes it by policy domain', async () => {
    tlsExternalReportList.mockResolvedValue([tlsReport()]);
    const r = await pollTlsReports(makeDb(), logger);
    expect(r.stored).toBe(1);
    expect(rows[0]).toMatchObject({
      stalwartReportId: 'sw-tls-1',
      tenantId: 't1',
      policyDomain: 'tenant.test',
      orgName: 'Reporter Inc',
      successfulSessions: 480,
      failedSessions: 3,
    });
  });

  it('keeps a report for a domain no tenant owns — the mail hostname reports too', async () => {
    hosted = [];
    tlsExternalReportList.mockResolvedValue([tlsReport()]);
    const r = await pollTlsReports(makeDb(), logger);
    expect(r.stored).toBe(1);
    expect(rows[0].tenantId).toBeNull();
  });

  it('destroys what it consumed', async () => {
    tlsExternalReportList.mockResolvedValue([tlsReport()]);
    await pollTlsReports(makeDb(), logger);
    expect(tlsExternalReportDestroy).toHaveBeenCalledWith(expect.objectContaining({ ids: ['sw-tls-1'] }));
  });

  it('does NOT destroy a report it failed to store', async () => {
    insertFails = true;
    tlsExternalReportList.mockResolvedValue([tlsReport()]);
    const r = await pollTlsReports(makeDb(), logger);
    expect(r.stored).toBe(0);
    expect(tlsExternalReportDestroy).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('absorbs a redelivered report instead of duplicating it', async () => {
    tlsExternalReportList.mockResolvedValue([tlsReport()]);
    const db = makeDb();
    await pollTlsReports(db, logger);
    await pollTlsReports(db, logger);
    expect(rows).toHaveLength(1);
  });

  it('never throws when Stalwart is unreachable', async () => {
    tlsExternalReportList.mockRejectedValue(new Error('connection refused'));
    const r = await pollTlsReports(makeDb(), logger);
    expect(r).toMatchObject({ fetched: 0, stored: 0 });
    expect(logger.warn).toHaveBeenCalled();
  });
});
