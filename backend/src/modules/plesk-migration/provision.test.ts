import { describe, it, expect } from 'vitest';
import { finalizeItemLeg, mailDomainsOf, checkCapacity, netNewMailboxCount } from './provision.js';
import type { PleskSubscription } from '@insula/api-contracts';

function sub(mailboxes: PleskSubscription['mailboxes']): PleskSubscription {
  return {
    name: 'acme.example', sysUser: 'acme', cronCount: 0, cronLines: [], mailBytes: 0,
    domains: [], databases: [], mailboxes,
  };
}

describe('netNewMailboxCount (idempotent-retry capacity)', () => {
  it('counts all on a first run (none exist yet)', () => {
    expect(netNewMailboxCount(['a@x.test', 'b@x.test'], [])).toBe(2);
  });
  it('counts zero when every subscription mailbox already exists (a retry)', () => {
    expect(netNewMailboxCount(['a@x.test', 'b@x.test'], ['a@x.test', 'b@x.test'])).toBe(0);
  });
  it('counts only the missing ones on a partial retry, case-insensitively', () => {
    expect(netNewMailboxCount(['A@x.test', 'b@x.test', 'c@x.test'], ['a@x.test'])).toBe(2);
  });
  it('ignores unrelated mailboxes already on the tenant', () => {
    expect(netNewMailboxCount(['a@x.test'], ['other@y.test'])).toBe(1);
  });
});

describe('finalizeItemLeg', () => {
  const prev = { status: 'running' as const, startedAt: '2026-06-13T00:00:00.000Z' };

  it('marks an empty leg skipped (no work to do)', () => {
    const leg = finalizeItemLeg(prev, [], 'domains');
    expect(leg.status).toBe('skipped');
    expect(leg.detail).toBe('no domains');
    expect(leg.startedAt).toBe(prev.startedAt); // carries prev fields
  });

  it('marks completed when every item succeeded', () => {
    const leg = finalizeItemLeg(prev, [
      { name: 'a.com', status: 'completed' },
      { name: 'b.com', status: 'completed' },
    ], 'domains');
    expect(leg.status).toBe('completed');
    expect(leg.detail).toBe('2/2 domains');
    expect(leg.items).toHaveLength(2);
  });

  it('counts skipped items as non-failures (still completed)', () => {
    const leg = finalizeItemLeg(prev, [
      { name: 'a.com', status: 'completed' },
      { name: 'b.com', status: 'skipped', message: 'already exists' },
    ], 'domains');
    expect(leg.status).toBe('completed');
    expect(leg.detail).toBe('2/2 domains');
  });

  it('marks partial (not failed) when any item failed — the tenant still exists', () => {
    const leg = finalizeItemLeg(prev, [
      { name: 'a.com', status: 'completed' },
      { name: 'bad_domain', status: 'failed', message: 'invalid' },
    ], 'domains');
    expect(leg.status).toBe('partial');
    expect(leg.detail).toBe('1/2 domains'); // 1 ok of 2
  });
});

describe('mailDomainsOf', () => {
  it('returns the distinct, lower-cased domains that host mailboxes', () => {
    const result = mailDomainsOf(sub([
      { address: 'reception@acme.example', quotaMb: null, passwordType: 'sym' },
      { address: 'info@ACME.EXAMPLE', quotaMb: null, passwordType: 'sym' },
      { address: 'sales@shop.acme.example', quotaMb: null, passwordType: 'sym' },
    ]));
    expect(result.sort()).toEqual(['acme.example', 'shop.acme.example']);
  });

  it('is empty when the subscription has no mailboxes', () => {
    expect(mailDomainsOf(sub([]))).toEqual([]);
  });

  it('ignores malformed addresses with no domain part', () => {
    expect(mailDomainsOf(sub([
      { address: 'broken-no-at', quotaMb: null, passwordType: null },
    ]))).toEqual([]);
  });
});

describe('checkCapacity (tenant-first preflight)', () => {
  const GIB = 1_073_741_824; // platform sizes storage in GiB

  it('passes when the subscription fits the plan', () => {
    expect(checkCapacity({
      mailboxesNeeded: 46, mailboxesExisting: 0, mailboxLimit: 50,
      bytesNeeded: 2 * GIB, storageBytesAvailable: 5 * GIB,
    })).toEqual([]);
  });

  it('flags too many mailboxes (count + existing exceeds the plan limit)', () => {
    const problems = checkCapacity({
      mailboxesNeeded: 46, mailboxesExisting: 6, mailboxLimit: 50,
      bytesNeeded: 0, storageBytesAvailable: 5 * GIB,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0].resource).toBe('mailboxes');
    expect(problems[0].needed).toBe(52); // 46 + 6
    expect(problems[0].message).toContain('plus 6 already');
  });

  it('flags insufficient storage (mail + DB bytes exceed the plan)', () => {
    const problems = checkCapacity({
      mailboxesNeeded: 5, mailboxesExisting: 0, mailboxLimit: 50,
      bytesNeeded: 8 * GIB, storageBytesAvailable: 5 * GIB,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0].resource).toBe('storage');
    expect(problems[0].message).toContain('GiB');
  });

  it('reports BOTH problems when the tenant is under-sized on each axis', () => {
    const problems = checkCapacity({
      mailboxesNeeded: 100, mailboxesExisting: 0, mailboxLimit: 10,
      bytesNeeded: 20 * GIB, storageBytesAvailable: 2 * GIB,
    });
    expect(problems.map((p) => p.resource).sort()).toEqual(['mailboxes', 'storage']);
  });

  it('treats an exactly-fitting subscription as OK (boundary)', () => {
    expect(checkCapacity({
      mailboxesNeeded: 50, mailboxesExisting: 0, mailboxLimit: 50,
      bytesNeeded: 5 * GIB, storageBytesAvailable: 5 * GIB,
    })).toEqual([]);
  });
});
