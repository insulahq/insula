/**
 * The Banned IPs list, as the rest of the platform sees it.
 *
 * Two operator complaints meet here:
 *
 *   1. A manual ban's "Why" read `<user id>:probing /.env` — the scenario
 *      string carries the operator's user id, and the panel printed it. The
 *      "Added by" pill said "Operator" without saying who.
 *   2. The dashboard's Web defence tile reported 7 banned IPs while the list
 *      it links to held many more. The tile counted the auto-ban scheduler's
 *      own run table, so traffic-detection, operator and permanent bans were
 *      invisible to it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CrowdsecDecision } from '@insula/api-contracts';
import * as crowdsec from './crowdsec.js';
import {
  attachOperatorNames,
  countActivePlatformBans,
  countBannedAddresses,
  formatOperatorName,
} from './crowdsec-ban-list.js';

afterEach(() => { vi.restoreAllMocks(); });

const ALICE = '11111111-2222-4333-8444-555555555555';
const BOB = '22222222-3333-4444-8555-666666666666';

const decision = (over: Partial<CrowdsecDecision> = {}): CrowdsecDecision => ({
  id: 1,
  origin: 'crowdsec',
  type: 'ban',
  scope: 'Ip',
  value: '203.0.113.10',
  scenario: 'crowdsecurity/http-probing',
  duration: '1h',
  expiresAt: null,
  manualByOperator: false,
  staticByOperator: false,
  autoBanned: false,
  simulated: false,
  addedBy: 'auto-ban-traffic',
  operatorReason: null,
  addedByName: null,
  ...over,
});

const operatorBan = (actor: string, over: Partial<CrowdsecDecision> = {}) => decision({
  origin: 'cscli',
  scenario: `admin-panel:${actor}:probing /.env`,
  manualByOperator: true,
  addedBy: 'operator',
  operatorReason: 'probing /.env',
  ...over,
});

const permanentBan = (actor: string, over: Partial<CrowdsecDecision> = {}) => decision({
  origin: 'cscli',
  scenario: `admin-panel-static:${actor}:known scanner`,
  staticByOperator: true,
  addedBy: 'static-list',
  operatorReason: 'known scanner',
  ...over,
});

/** Minimal drizzle chain: select().from().where() resolves to `rows`. */
function fakeDb(rows: ReadonlyArray<{ id: string; fullName: string | null; email: string | null }>) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } as never, select, where };
}

describe('formatOperatorName', () => {
  it('reads as a person: name and email', () => {
    expect(formatOperatorName({ fullName: 'Alice Admin', email: 'alice@example.test' }))
      .toBe('Alice Admin (alice@example.test)');
  });

  it('falls back to whichever half exists', () => {
    expect(formatOperatorName({ fullName: '  ', email: 'alice@example.test' })).toBe('alice@example.test');
    expect(formatOperatorName({ fullName: 'Alice Admin', email: null })).toBe('Alice Admin');
  });

  it('is null when there is nothing to show', () => {
    expect(formatOperatorName({ fullName: null, email: '' })).toBeNull();
  });
});

describe('attachOperatorNames', () => {
  it('names the operator behind a timed AND a permanent ban', async () => {
    const { db } = fakeDb([
      { id: ALICE, fullName: 'Alice Admin', email: 'alice@example.test' },
      { id: BOB, fullName: 'Bob Builder', email: 'bob@example.test' },
    ]);
    const out = await attachOperatorNames(db, [
      operatorBan(ALICE, { id: 1 }),
      permanentBan(BOB, { id: 2, value: '203.0.113.11' }),
    ]);
    expect(out[0].addedByName).toBe('Alice Admin (alice@example.test)');
    expect(out[1].addedByName).toBe('Bob Builder (bob@example.test)');
  });

  it('leaves automatic rows alone and never queries for them', async () => {
    const { db, select } = fakeDb([]);
    const auto = decision({
      origin: 'cscli',
      scenario: 'admin-panel:autoban-scheduler:auto-ban:rules 920450 count 6',
      autoBanned: true,
      addedBy: 'auto-ban-waf',
    });
    const traffic = decision();
    const out = await attachOperatorNames(db, [auto, traffic]);
    expect(out.map((d) => d.addedByName)).toEqual([null, null]);
    // No operator rows: no database round-trip at all.
    expect(select).not.toHaveBeenCalled();
  });

  it('looks each operator up ONCE however many bans they added', async () => {
    const { db, where } = fakeDb([{ id: ALICE, fullName: 'Alice Admin', email: 'alice@example.test' }]);
    await attachOperatorNames(db, [
      operatorBan(ALICE, { id: 1, value: '203.0.113.1' }),
      operatorBan(ALICE, { id: 2, value: '203.0.113.2' }),
      permanentBan(ALICE, { id: 3, value: '203.0.113.3' }),
    ]);
    expect(where).toHaveBeenCalledTimes(1);
  });

  it('leaves the name null — not the raw id — for an account that no longer exists', async () => {
    const { db } = fakeDb([]);
    const [out] = await attachOperatorNames(db, [operatorBan(ALICE)]);
    expect(out.addedByName).toBeNull();
    expect(JSON.stringify({ name: out.addedByName, reason: out.operatorReason })).not.toContain(ALICE);
  });

  it('returns new objects instead of mutating the input', async () => {
    const { db } = fakeDb([{ id: ALICE, fullName: 'Alice Admin', email: 'alice@example.test' }]);
    const input = [operatorBan(ALICE)];
    const out = await attachOperatorNames(db, input);
    expect(input[0].addedByName).toBeNull();
    expect(out[0]).not.toBe(input[0]);
  });
});

describe('countBannedAddresses', () => {
  it('counts ADDRESSES, the way the list renders rows — not decisions', () => {
    // CrowdSec stores one decision per (address, scenario). The list collapses
    // them into one row per address, so the count must too.
    expect(countBannedAddresses([
      decision({ id: 1, value: '203.0.113.9', scenario: 'crowdsecurity/http-probing' }),
      decision({ id: 2, value: '203.0.113.9', scenario: 'crowdsecurity/http-sensitive-files' }),
      decision({ id: 3, value: '203.0.113.10' }),
    ])).toBe(2);
  });

  it('keeps an address and a range that share a value apart, as the list does', () => {
    expect(countBannedAddresses([
      decision({ id: 1, scope: 'Ip', value: '198.51.100.0' }),
      decision({ id: 2, scope: 'Range', value: '198.51.100.0' }),
    ])).toBe(2);
  });

  it('is zero for an empty list', () => {
    expect(countBannedAddresses([])).toBe(0);
  });
});

describe('countActivePlatformBans', () => {
  it('counts exactly what the Banned IPs list shows by default — every platform engine', async () => {
    const spy = vi.spyOn(crowdsec, 'listDecisions').mockResolvedValue({
      decisions: [
        decision({ id: 1, value: '203.0.113.1' }), // traffic detection
        decision({ id: 2, value: '203.0.113.1', scenario: 'crowdsecurity/http-bad-user-agent' }),
        decision({
          id: 3, origin: 'cscli', value: '203.0.113.2', addedBy: 'auto-ban-waf', autoBanned: true,
          scenario: 'admin-panel:autoban-scheduler:auto-ban:rules 930130 count 9',
        }),
        operatorBan(ALICE, { id: 4, value: '203.0.113.3' }),
        permanentBan(ALICE, { id: 5, value: '203.0.113.4' }),
      ],
      totalActive: 16_225,
      totalMatching: 5,
      limit: 5,
      offset: 0,
    });
    await expect(countActivePlatformBans(undefined)).resolves.toBe(4);
    // The list's own query — not a second definition of "banned". The list
    // defaults to platform decisions, so the community feed stays out of
    // both (16,220 of the 16,225 here).
    expect(spy).toHaveBeenCalledWith(undefined, { source: 'platform' });
  });

  it('propagates a LAPI failure instead of reporting zero bans', async () => {
    vi.spyOn(crowdsec, 'listDecisions').mockRejectedValue(new Error('LAPI GET /v1/decisions → HTTP 503'));
    await expect(countActivePlatformBans(undefined)).rejects.toThrow(/503/);
  });
});
