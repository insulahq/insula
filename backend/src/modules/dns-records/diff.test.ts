import { describe, it, expect } from 'vitest';
import { computeRecordDiff, type LocalRecord, type RemoteRecord } from './diff.js';

const ZONE = 'example.test';

function local(p: Partial<LocalRecord> & { recordType: string; recordValue: string }): LocalRecord {
  return { id: `id-${p.recordType}-${p.recordName ?? '@'}`, recordName: null, ttl: 3600, priority: null, weight: null, port: null, ...p };
}
function remote(p: Partial<RemoteRecord> & { type: string; content: string }): RemoteRecord {
  return { name: `${ZONE}.`, ttl: 3600, ...p };
}

/**
 * Each case here reproduces a way the Sync Records dialog reported a
 * permanent, unclearable difference between a local row and the identical
 * record on the DNS server.
 */
describe('computeRecordDiff — records that ARE the same must report in_sync', () => {
  it('CNAME: local target without a trailing dot vs remote with one', () => {
    const diff = computeRecordDiff(
      ZONE,
      [local({ recordType: 'CNAME', recordName: 'www', recordValue: 'ingress.platform.test' })],
      [remote({ type: 'CNAME', name: 'www.example.test.', content: 'ingress.platform.test.' })],
    );
    expect(diff).toHaveLength(1);
    expect(diff[0].status).toBe('in_sync');
  });

  it('NS: same mismatch at the apex', () => {
    const diff = computeRecordDiff(
      ZONE,
      [local({ recordType: 'NS', recordName: '@', recordValue: 'ns1.platform.test' })],
      [remote({ type: 'NS', content: 'ns1.platform.test.' })],
    );
    expect(diff[0].status).toBe('in_sync');
  });

  it('MX: local stores target + priority column, remote stores composed content', () => {
    const diff = computeRecordDiff(
      ZONE,
      [local({ recordType: 'MX', recordName: '@', recordValue: 'mail.platform.test', priority: 10 })],
      [remote({ type: 'MX', content: '10 mail.platform.test.' })],
    );
    expect(diff[0].status).toBe('in_sync');
  });

  it('SRV: local stores target + priority/weight/port columns', () => {
    const diff = computeRecordDiff(
      ZONE,
      [local({ recordType: 'SRV', recordName: '_sip._tcp', recordValue: 'sip.platform.test', priority: 10, weight: 5, port: 5060 })],
      [remote({ type: 'SRV', name: '_sip._tcp.example.test.', content: '10 5 5060 sip.platform.test.' })],
    );
    expect(diff[0].status).toBe('in_sync');
  });

  it('TXT: local unquoted vs remote quoted', () => {
    const diff = computeRecordDiff(
      ZONE,
      [local({ recordType: 'TXT', recordName: '@', recordValue: 'v=spf1 mx ~all' })],
      [remote({ type: 'TXT', content: '"v=spf1 mx ~all"' })],
    );
    expect(diff[0].status).toBe('in_sync');
  });

  // email-domains/dns-provisioning.ts writes the FULL record name into the
  // local row (`example.test`, `_dmarc.example.test`) while panel-created
  // rows hold a bare label. Both must normalise to the same key.
  it('mail rows whose local name is the full FQDN still match the apex record', () => {
    const diff = computeRecordDiff(
      ZONE,
      [local({ recordType: 'TXT', recordName: ZONE, recordValue: 'v=spf1 mx ~all' })],
      [remote({ type: 'TXT', content: '"v=spf1 mx ~all"' })],
    );
    expect(diff[0].status).toBe('in_sync');
    expect(diff[0].name).toBe('@');
  });

  it('a whole realistic zone reports no differences at all', () => {
    const diff = computeRecordDiff(
      ZONE,
      [
        local({ recordType: 'A', recordName: '@', recordValue: '203.0.113.10' }),
        local({ recordType: 'CNAME', recordName: 'www', recordValue: 'ingress.platform.test' }),
        local({ recordType: 'MX', recordName: ZONE, recordValue: 'mail.platform.test', priority: 10 }),
        local({ recordType: 'TXT', recordName: ZONE, recordValue: 'v=spf1 mx ~all' }),
        local({ recordType: 'TXT', recordName: `_dmarc.${ZONE}`, recordValue: 'v=DMARC1; p=none' }),
      ],
      [
        remote({ type: 'A', content: '203.0.113.10' }),
        remote({ type: 'CNAME', name: 'www.example.test.', content: 'ingress.platform.test.' }),
        remote({ type: 'MX', content: '10 mail.platform.test.' }),
        remote({ type: 'TXT', content: '"v=spf1 mx ~all"' }),
        remote({ type: 'TXT', name: '_dmarc.example.test.', content: '"v=DMARC1; p=none"' }),
        // Present in every zone; must not surface as a difference.
        remote({ type: 'SOA', content: 'ns1.platform.test. hostmaster.example.test. 2026081901 10800 3600 604800 3600' }),
      ],
    );
    expect(diff.every((e) => e.status === 'in_sync')).toBe(true);
    expect(diff).toHaveLength(5);
  });
});

describe('computeRecordDiff — SOA', () => {
  it('is excluded even when the serials differ, since PowerDNS owns it', () => {
    const diff = computeRecordDiff(
      ZONE,
      [local({ recordType: 'SOA', recordName: '@', recordValue: 'ns1.platform.test. hostmaster.example.test. 1 10800 3600 604800 3600' })],
      [remote({ type: 'SOA', content: 'ns1.platform.test. hostmaster.example.test. 999 10800 3600 604800 3600' })],
    );
    expect(diff).toHaveLength(0);
  });
});

describe('computeRecordDiff — genuine differences are still reported', () => {
  it('reports a real value change as a conflict', () => {
    const diff = computeRecordDiff(
      ZONE,
      [local({ recordType: 'A', recordName: 'www', recordValue: '203.0.113.10' })],
      [remote({ type: 'A', name: 'www.example.test.', content: '198.51.100.20' })],
    );
    expect(diff[0].status).toBe('conflict');
    expect(diff[0].local?.value).toBe('203.0.113.10');
    expect(diff[0].remote?.value).toBe('198.51.100.20');
  });

  it('reports a record missing from the provider as local_only', () => {
    const diff = computeRecordDiff(
      ZONE,
      [local({ recordType: 'A', recordName: 'new', recordValue: '203.0.113.10' })],
      [],
    );
    expect(diff[0].status).toBe('local_only');
  });

  it('reports a record only on the provider as remote_only', () => {
    const diff = computeRecordDiff(
      ZONE,
      [],
      [remote({ type: 'A', name: 'extra.example.test.', content: '203.0.113.10' })],
    );
    expect(diff[0].status).toBe('remote_only');
    expect(diff[0].name).toBe('extra');
  });

  it('keeps both values of a two-value MX set distinct', () => {
    const diff = computeRecordDiff(
      ZONE,
      [
        local({ recordType: 'MX', recordName: '@', recordValue: 'mail1.platform.test', priority: 10 }),
        { ...local({ recordType: 'MX', recordName: '@', recordValue: 'mail2.platform.test', priority: 20 }), id: 'id-mx-2' },
      ],
      [
        remote({ type: 'MX', content: '10 mail1.platform.test.' }),
        remote({ type: 'MX', content: '20 mail2.platform.test.' }),
      ],
    );
    expect(diff).toHaveLength(2);
    expect(diff.every((e) => e.status === 'in_sync')).toBe(true);
  });

  it('surfaces an unpublishable legacy row (MX with no priority) as local_only', () => {
    const diff = computeRecordDiff(
      ZONE,
      [local({ recordType: 'MX', recordName: '@', recordValue: 'mail.platform.test' })],
      [],
    );
    expect(diff[0].status).toBe('local_only');
  });
});

describe('computeRecordDiff — display names', () => {
  it.each([
    ['@', '@'],
    ['www', 'www'],
  ])('renders local name %s as %s', (input, expected) => {
    const diff = computeRecordDiff(ZONE, [local({ recordType: 'A', recordName: input, recordValue: '203.0.113.10' })], []);
    expect(diff[0].name).toBe(expected);
  });

  it('renders a remote apex record as @', () => {
    const diff = computeRecordDiff(ZONE, [], [remote({ type: 'A', content: '203.0.113.10' })]);
    expect(diff[0].name).toBe('@');
  });
});
