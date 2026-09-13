import { describe, expect, it } from 'vitest';
import { indexedValues, mapDmarcReport } from './dmarc.js';
import type { StalwartDmarcReportRow } from '../stalwart-jmap/client.js';

/**
 * Captured verbatim from a LIVE Stalwart on 2026-09-13 by delivering a real
 * RFC 7489 aggregate report and reading the stored object back.
 *
 * Kept as a literal rather than hand-written from the RFC because two details
 * here are not what the RFC suggests, and both fail silently:
 *   - `records` / `dkimResults` / `spfResults` are INDEX-KEYED OBJECTS
 *   - SPF softfail is `softFail`, camelCase
 */
const LIVE_REPORT: StalwartDmarcReportRow = {
  id: 'jeqxkziyaaqa',
  from: 'noreply-dmarc@probe.example.net',
  subject: 'Report Domain: example.test Submitter: probe.example.net Report-ID: probe-1',
  to: { 'fbl@example.test': true },
  receivedAt: '2026-09-13T19:16:17Z',
  expiresAt: '2026-10-13T19:16:17Z',
  report: {
    orgName: 'probe.example.net',
    email: 'noreply-dmarc@probe.example.net',
    extraContactInfo: null,
    reportId: 'probe-1',
    dateRangeBegin: '2026-09-12T19:16:16Z',
    dateRangeEnd: '2026-09-13T19:16:16Z',
    policyDomain: 'example.test',
    policyAdkim: 'relaxed',
    policyAspf: 'relaxed',
    policyDisposition: 'none',
    policySubdomainDisposition: 'none',
    policyTestingMode: false,
    errors: {},
    records: {
      '0': {
        sourceIp: '203.0.113.10',
        count: 7,
        evaluatedDisposition: 'none',
        evaluatedDkim: 'pass',
        evaluatedSpf: 'pass',
        policyOverrideReasons: {},
        envelopeTo: null,
        envelopeFrom: '',
        headerFrom: 'example.test',
        dkimResults: { '0': { domain: 'example.test', selector: 'default', result: 'pass', humanResult: null } },
        spfResults: { '0': { domain: 'example.test', scope: 'unspecified', result: 'pass', humanResult: null } },
      },
      '1': {
        sourceIp: '198.51.100.22',
        count: 3,
        evaluatedDisposition: 'none',
        evaluatedDkim: 'fail',
        evaluatedSpf: 'fail',
        policyOverrideReasons: {},
        envelopeTo: null,
        envelopeFrom: '',
        headerFrom: 'example.test',
        dkimResults: { '0': { domain: 'example.test', selector: 'default', result: 'fail', humanResult: null } },
        spfResults: { '0': { domain: 'example.test', scope: 'unspecified', result: 'softFail', humanResult: null } },
      },
    },
  },
};

const NOW = new Date('2026-09-13T20:00:00Z');
const resolveHit = () => ({ tenantId: 't-1', emailDomainId: 'ed-1' });
const resolveMiss = () => undefined;

describe('indexedValues', () => {
  it('walks an index-keyed object', () => {
    // The whole reason this helper exists: `records` looks like an array in
    // every RFC example and is an object on the wire.
    expect(indexedValues({ '0': 'a', '1': 'b' })).toEqual(['a', 'b']);
  });

  it('also accepts a real array, so a future Stalwart change cannot zero the counts', () => {
    expect(indexedValues(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('treats null/undefined as empty', () => {
    expect(indexedValues(null)).toEqual([]);
    expect(indexedValues(undefined)).toEqual([]);
  });
});

describe('mapDmarcReport — against the live payload', () => {
  it('reads both records out of the index-keyed object', () => {
    // If this returns 0 sources, the parser is treating `records` as an array
    // and every domain will report as having sent nothing.
    const { sources } = mapDmarcReport(LIVE_REPORT, resolveHit, NOW);
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.sourceIp)).toEqual(['203.0.113.10', '198.51.100.22']);
  });

  it('sums the counts from the records, not from the report count', () => {
    const { report } = mapDmarcReport(LIVE_REPORT, resolveHit, NOW);
    expect(report.totalMessages).toBe(10);
    expect(report.passMessages).toBe(7);
    expect(report.failMessages).toBe(3);
    expect(report.dkimPassMessages).toBe(7);
    expect(report.spfPassMessages).toBe(7);
  });

  it('carries the report header fields through', () => {
    const { report } = mapDmarcReport(LIVE_REPORT, resolveHit, NOW);
    expect(report).toMatchObject({
      stalwartReportId: 'jeqxkziyaaqa',
      policyDomain: 'example.test',
      orgName: 'probe.example.net',
      reporterEmail: 'noreply-dmarc@probe.example.net',
      reportId: 'probe-1',
      policyDisposition: 'none',
      policyAdkim: 'relaxed',
      policyAspf: 'relaxed',
      tenantId: 't-1',
      emailDomainId: 'ed-1',
    });
    expect(report.dateRangeBegin?.toISOString()).toBe('2026-09-12T19:16:16.000Z');
    expect(report.receivedAt.toISOString()).toBe('2026-09-13T19:16:17.000Z');
  });

  it('links every source row to its parent report', () => {
    const { report, sources } = mapDmarcReport(LIVE_REPORT, resolveHit, NOW);
    expect(sources.every((s) => s.reportId === report.id)).toBe(true);
  });

  it('stores an unattributed report rather than dropping it', () => {
    // A report for a domain this platform does not host is still evidence
    // about platform reputation, and dropping it would make "unattributed"
    // indistinguishable from "no reports arrived".
    const { report, sources } = mapDmarcReport(LIVE_REPORT, resolveMiss, NOW);
    expect(report.tenantId).toBeNull();
    expect(report.emailDomainId).toBeNull();
    expect(report.policyDomain).toBe('example.test');
    expect(sources).toHaveLength(2);
  });
});

describe('mapDmarcReport — counting rules', () => {
  const withRecords = (records: Record<string, unknown>): StalwartDmarcReportRow => ({
    ...LIVE_REPORT,
    report: { ...LIVE_REPORT.report, records: records as never },
  });

  it('counts a message as passing when EITHER mechanism passes', () => {
    // DMARC passes on either aligned mechanism, not both. Requiring both would
    // under-report the pass rate and block every tightening forever.
    const { report } = mapDmarcReport(
      withRecords({ '0': { sourceIp: '203.0.113.1', count: 5, evaluatedDkim: 'pass', evaluatedSpf: 'fail' } }),
      resolveHit, NOW,
    );
    expect(report.passMessages).toBe(5);
    expect(report.failMessages).toBe(0);
    expect(report.dkimPassMessages).toBe(5);
    expect(report.spfPassMessages).toBe(0);
  });

  it('counts a message as failing only when BOTH fail', () => {
    const { report } = mapDmarcReport(
      withRecords({ '0': { sourceIp: '203.0.113.1', count: 4, evaluatedDkim: 'fail', evaluatedSpf: 'softFail' } }),
      resolveHit, NOW,
    );
    expect(report.failMessages).toBe(4);
    expect(report.passMessages).toBe(0);
  });

  it('normalises camelCase verdicts before comparing', () => {
    // `softFail` must not be mistaken for a pass, nor silently become neither.
    const { sources } = mapDmarcReport(
      withRecords({ '0': { sourceIp: '203.0.113.1', count: 1, evaluatedDkim: 'Fail', evaluatedSpf: 'softFail' } }),
      resolveHit, NOW,
    );
    expect(sources[0].evaluatedDkim).toBe('fail');
    expect(sources[0].evaluatedSpf).toBe('softfail');
  });

  it('tallies quarantine and reject dispositions', () => {
    const { report } = mapDmarcReport(
      withRecords({
        '0': { sourceIp: '203.0.113.1', count: 2, evaluatedDisposition: 'quarantine', evaluatedDkim: 'fail', evaluatedSpf: 'fail' },
        '1': { sourceIp: '203.0.113.2', count: 3, evaluatedDisposition: 'reject', evaluatedDkim: 'fail', evaluatedSpf: 'fail' },
      }),
      resolveHit, NOW,
    );
    expect(report.quarantinedMessages).toBe(2);
    expect(report.rejectedMessages).toBe(3);
    expect(report.totalMessages).toBe(5);
  });

  it('contributes 0 for a missing or nonsensical count rather than NaN', () => {
    // One malformed record must not turn every total in the UI into "NaN".
    const { report } = mapDmarcReport(
      withRecords({
        '0': { sourceIp: '203.0.113.1', evaluatedDkim: 'pass' },
        '1': { sourceIp: '203.0.113.2', count: -5, evaluatedDkim: 'pass' },
        '2': { sourceIp: '203.0.113.3', count: 6, evaluatedDkim: 'pass', evaluatedSpf: 'pass' },
      }),
      resolveHit, NOW,
    );
    expect(report.totalMessages).toBe(6);
    expect(Number.isNaN(report.totalMessages)).toBe(false);
  });

  it('handles a report with no records at all', () => {
    const { report, sources } = mapDmarcReport(withRecords({}), resolveHit, NOW);
    expect(report.totalMessages).toBe(0);
    expect(sources).toHaveLength(0);
  });

  it('falls back to now when the report carries no receivedAt', () => {
    const row = { ...LIVE_REPORT, receivedAt: undefined };
    const { report } = mapDmarcReport(row, resolveHit, NOW);
    expect(report.receivedAt).toEqual(NOW);
  });

  it('lowercases the policy domain so attribution is case-insensitive', () => {
    const row: StalwartDmarcReportRow = {
      ...LIVE_REPORT,
      report: { ...LIVE_REPORT.report, policyDomain: 'Example.TEST' },
    };
    const seen: string[] = [];
    mapDmarcReport(row, (d) => { seen.push(d); return resolveHit(); }, NOW);
    expect(seen).toEqual(['example.test']);
  });
});
