import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../stalwart-jmap/client.js', () => ({
  arfExternalReportList: vi.fn(),
  arfExternalReportDestroy: vi.fn(),
}));

import { mapArfReport, pollFblComplaints, cancelScheduledPoll } from './fbl.js';
import * as jmap from '../stalwart-jmap/client.js';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const SAMPLE = {
  id: 'rep-1',
  from: 'complaints@mailprovider.example',
  subject: 'spam complaint',
  to: { 'fbl@apex.example.com': true },
  receivedAt: '2026-06-12T16:20:14Z',
  report: {
    feedbackType: 'abuse',
    incidents: 1,
    originalMailFrom: '<spike@alpha.example.com>',
    originalRcptTo: '<victim@mailprovider.example>',
    reportedDomains: { 'alpha.example.com': true },
    sourceIp: '192.0.2.55',
    reportingMta: null,
  },
};

describe('mapArfReport', () => {
  const resolve = (d: string) => (d === 'alpha.example.com' ? 'tenant-1' : undefined);

  it('attributes by reported domain and strips angle brackets', () => {
    const row = mapArfReport(SAMPLE, resolve);
    expect(row.tenantId).toBe('tenant-1');
    expect(row.domain).toBe('alpha.example.com');
    expect(row.originalMailFrom).toBe('spike@alpha.example.com');
    expect(row.originalRcptTo).toBe('victim@mailprovider.example');
    expect(row.feedbackType).toBe('abuse');
    expect(row.sourceIp).toBe('192.0.2.55');
    expect(row.stalwartReportId).toBe('rep-1');
    expect(row.incidents).toBe(1);
    expect(row.receivedAt.toISOString()).toBe('2026-06-12T16:20:14.000Z');
  });

  it('falls back to the original MAIL FROM domain when reportedDomains is foreign', () => {
    const row = mapArfReport({
      ...SAMPLE,
      report: { ...SAMPLE.report, reportedDomains: { 'unrelated.example.net': true } },
    }, resolve);
    expect(row.tenantId).toBe('tenant-1');
    expect(row.domain).toBe('alpha.example.com');
  });

  it('keeps unattributed complaints with the first candidate domain', () => {
    const row = mapArfReport(SAMPLE, () => undefined);
    expect(row.tenantId).toBeNull();
    expect(row.domain).toBe('alpha.example.com');
  });

  it('survives a minimal/malformed report', () => {
    const row = mapArfReport({ id: 'rep-2' }, () => undefined);
    expect(row.feedbackType).toBe('other');
    expect(row.tenantId).toBeNull();
    expect(row.domain).toBeNull();
    expect(row.incidents).toBe(1);
  });
});

describe('pollFblComplaints', () => {
  const list = vi.mocked(jmap.arfExternalReportList);
  const destroy = vi.mocked(jmap.arfExternalReportDestroy);

  function makeDb(insertedIds: string[] = ['new']) {
    const returning = vi.fn().mockResolvedValue(insertedIds.map((id) => ({ id })));
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const insert = vi.fn().mockReturnValue({ values });
    const where = vi.fn().mockResolvedValue([
      { domainName: 'alpha.example.com', tenantId: 'tenant-1' },
    ]);
    const innerJoin = vi.fn().mockReturnValue({ where });
    const from = vi.fn().mockReturnValue({ innerJoin });
    const select = vi.fn().mockReturnValue({ from });
    return { db: { insert, select } as never, insert, values };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    cancelScheduledPoll();
    destroy.mockResolvedValue({
      accountId: 'x', oldState: null, newState: 'n',
      created: null, updated: null, destroyed: ['rep-1'],
      notCreated: null, notUpdated: null, notDestroyed: null,
    });
  });

  it('persists complaints and destroys consumed reports', async () => {
    list.mockResolvedValue([SAMPLE]);
    const { db, values } = makeDb();

    const res = await pollFblComplaints(db, silentLogger);
    expect(res).toMatchObject({ skipped: false, fetched: 1, stored: 1, destroyed: 1 });
    expect(values.mock.calls[0][0]).toMatchObject({
      stalwartReportId: 'rep-1',
      tenantId: 'tenant-1',
      domain: 'alpha.example.com',
    });
    expect(destroy).toHaveBeenCalledWith(expect.objectContaining({ ids: ['rep-1'] }));
  });

  it('still destroys duplicates (idempotent re-poll after failed destroy)', async () => {
    list.mockResolvedValue([SAMPLE]);
    const { db } = makeDb([]); // conflict -> nothing returned

    const res = await pollFblComplaints(db, silentLogger);
    expect(res.stored).toBe(0);
    expect(destroy).toHaveBeenCalled();
  });

  it('no-ops cleanly when the store is empty', async () => {
    list.mockResolvedValue([]);
    const { db, insert } = makeDb();
    const res = await pollFblComplaints(db, silentLogger);
    expect(res).toMatchObject({ fetched: 0, stored: 0, destroyed: 0 });
    expect(insert).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it('skips when Stalwart is unreachable', async () => {
    list.mockRejectedValue(new Error('ECONNREFUSED'));
    const { db } = makeDb();
    const res = await pollFblComplaints(db, silentLogger);
    expect(res.skipped).toBe(true);
  });
});
