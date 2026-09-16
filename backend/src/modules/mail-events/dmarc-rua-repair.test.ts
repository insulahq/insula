import { describe, expect, it, vi, beforeEach } from 'vitest';
import { repairRuaValue, BROKEN_RUA_LOCAL_PART } from './dmarc-rua-repair.js';

/**
 * The risk here is not "does it rewrite" — it is "does it rewrite something it
 * should not have touched". An operator who points rua= at their own aggregator
 * has made a deliberate choice, and silently overriding it is the kind of change
 * nobody notices until reports stop arriving where they expected them.
 */
describe('repairRuaValue', () => {
  const D = 'example.test';

  it('repoints the exact address the platform used to publish', () => {
    expect(repairRuaValue(`v=DMARC1; p=quarantine; rua=mailto:${BROKEN_RUA_LOCAL_PART}@${D}`, D))
      .toBe('v=DMARC1; p=quarantine; rua=mailto:dmarc@example.test');
  });

  it('preserves every other tag byte-for-byte', () => {
    const before = `v=DMARC1; p=reject; sp=quarantine; pct=50; adkim=s; ruf=mailto:forensic@${D}; rua=mailto:${BROKEN_RUA_LOCAL_PART}@${D}; fo=1`;
    const after = repairRuaValue(before, D);
    expect(after).toBe(before.replace(`mailto:${BROKEN_RUA_LOCAL_PART}@${D}`, 'mailto:dmarc@example.test'));
    expect(after).toContain('p=reject');
    expect(after).toContain('pct=50');
    expect(after).toContain(`ruf=mailto:forensic@${D}`);
  });

  it('leaves an operator-chosen third-party aggregator alone', () => {
    // The whole point of the narrow scope.
    expect(repairRuaValue(`v=DMARC1; p=none; rua=mailto:reports@dmarc-vendor.example`, D)).toBeNull();
  });

  it('leaves an already-correct record alone', () => {
    expect(repairRuaValue(`v=DMARC1; p=none; rua=mailto:dmarc@${D}`, D)).toBeNull();
  });

  it('does not touch the same local part at a DIFFERENT domain', () => {
    // A shared reporting mailbox on another domain is a deliberate choice too.
    expect(repairRuaValue(`v=DMARC1; p=none; rua=mailto:${BROKEN_RUA_LOCAL_PART}@other.test`, D)).toBeNull();
  });

  it('ignores a record that merely mentions the string without a mailto', () => {
    expect(repairRuaValue(`v=DMARC1; p=none; rua=mailto:x@${D}; note=${BROKEN_RUA_LOCAL_PART}@${D}`, D)).toBeNull();
  });

  it('is not fooled by a non-DMARC TXT record that happens to match', () => {
    expect(repairRuaValue(`v=spf1 include:mailto:${BROKEN_RUA_LOCAL_PART}@${D} ~all`, D)).toBeNull();
  });

  it('handles multiple rua addresses, repointing only the broken one', () => {
    const before = `v=DMARC1; p=none; rua=mailto:${BROKEN_RUA_LOCAL_PART}@${D},mailto:keep@vendor.example`;
    expect(repairRuaValue(before, D))
      .toBe('v=DMARC1; p=none; rua=mailto:dmarc@example.test,mailto:keep@vendor.example');
  });

  it('matches the address case-insensitively but the domain exactly', () => {
    expect(repairRuaValue(`v=DMARC1; p=none; rua=mailto:DMARC-Reports@Example.Test`, D))
      .toBe('v=DMARC1; p=none; rua=mailto:dmarc@example.test');
  });

  it('returns null for a record that is not DMARC at all', () => {
    expect(repairRuaValue('some other txt value', D)).toBeNull();
    expect(repairRuaValue('', D)).toBeNull();
  });
});

// ── the repair must never publish an address that does not exist yet ────────

const syncSpy = vi.fn();
vi.mock('../email-domains/dns-provisioning.js', () => ({
  syncRecordToProviders: (...args: unknown[]) => {
    syncSpy(...args);
    return Promise.resolve({ status: 'ok' as const, message: '' });
  },
}));

/** Mock db whose select-chain resolves to `rows`. */
function db(rows: readonly unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'leftJoin']) chain[m] = () => chain;
  chain.where = () => Promise.resolve(rows);
  return {
    select: () => chain,
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  } as never;
}

const log = { info: () => {}, warn: () => {}, error: () => {} } as never;

const row = (over: Record<string, unknown> = {}) => ({
  recordId: 'r1',
  domainId: 'd1',
  domainName: 'example.test',
  recordName: '_dmarc.example.test',
  recordValue: 'v=DMARC1; p=none; rua=mailto:dmarc-reports@example.test',
  ttl: 3600,
  intakeMailboxId: 'mb1',
  ...over,
});

describe('repairDmarcRuaRecords — mailbox precondition', () => {
  beforeEach(() => syncSpy.mockClear());

  it('does NOT repoint a domain whose dmarc@ mailbox does not exist yet', async () => {
    // Otherwise a domain whose intake mailbox creation keeps failing has one
    // permanently-bouncing address swapped for another — the exact trap this
    // whole change exists to close.
    const { repairDmarcRuaRecords } = await import('./dmarc-rua-repair.js');
    const r = await repairDmarcRuaRecords(db([row({ intakeMailboxId: null })]), log, 'key');
    expect(r.skippedNoMailbox).toBe(1);
    expect(r.repaired).toBe(0);
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it('repoints once the intake mailbox is there', async () => {
    const { repairDmarcRuaRecords } = await import('./dmarc-rua-repair.js');
    const r = await repairDmarcRuaRecords(db([row()]), log, 'key');
    expect(r.repaired).toBe(1);
    expect(r.skippedNoMailbox).toBe(0);
    expect(syncSpy).toHaveBeenCalled();
  });
});
