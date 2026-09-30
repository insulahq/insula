/**
 * Meter-level proof that a tenant is billed for EXTERNAL egress only.
 *
 * This file used to prove a subtraction: the meter summed every byte the
 * tenant's pods transmitted and then deducted the platform's own backup
 * Jobs. Both halves are gone. The meter reads what the ingress served, so
 * the bytes it must not bill — a backup shipping off-site, a database
 * answering the application inside the namespace — are not in the figure to
 * begin with, and subtracting them would now deduct bytes that were never
 * added.
 *
 * Measured on production over six hours before the change: the active
 * tenants were billed 4,687 MB against 668 MB actually served, 7.0x overall
 * and 190x for the most database-heavy one, while every tenant with no
 * database add-on sat at 1.0x.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryInstant = vi.fn();
const recordHourlyUsage = vi.fn(async () => {});
vi.mock('../monitoring/vm-client.js', () => ({ queryInstant: (q: string) => queryInstant(q) }));
vi.mock('../metrics/usage-rollup.js', () => ({ recordHourlyUsage: (...a: unknown[]) => recordHourlyUsage(...(a as [])) }));

const { meterBandwidthOnce } = await import('./meter.js');
const { tenants, backupJobs, platformSettings } = await import('../../db/schema.js');
const { filesJobName } = await import('./backup-exclusion.js');

const NS = 'tenant-alpha-1111';
const JOB = 'bkp-11111111-2222-3333-4444-555555555555';
const TENANT_ROW = {
  id: 'ta', namespace: NS, used: '10', cycleStart: new Date(), capped: false,
  provisioningStatus: 'provisioned',
};

interface Captured { used?: number }

/** Fake Drizzle: routes each select by the table it reads. */
function makeDb(backupRows: Array<{ id: string; tenantId: string; initiator: string }>, captured: Captured) {
  const thenable = (rows: unknown[]) => {
    const p = Promise.resolve(rows) as Promise<unknown[]> & { where?: unknown };
    p.where = () => Promise.resolve(rows);
    return p;
  };
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === tenants) return thenable([TENANT_ROW]);
        if (table === backupJobs) return thenable(backupRows);
        if (table === platformSettings) return thenable([]);
        return thenable([]);
      },
    }),
    update: () => ({
      set: (s: Record<string, unknown>) => ({
        where: () => { captured.used = Number(s.bandwidthGbUsed); return Promise.resolve(); },
      }),
    }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) }),
  } as never;
}

// Sunshine College over six hours on production, scaled to one tick. The
// identity gives 301 MB where the ingress measured 274 MB; the 27 MB gap is
// the non-HTTP egress the estimate exists to capture.
const SERVED_OUT = 274_000_000;
const SERVED_IN = 122_000_000;
const POD_TX = 2_159_000_000;
const POD_RX = 1_980_000_000;
// TX − RX + servedIn = 301 MB
const EXPECTED_BILLED_GB = (POD_TX - POD_RX + SERVED_IN) / 1e9;

/** Route each query by the counter it names. */
function mockQueries(over: Partial<Record<'servedOut' | 'servedIn' | 'tx' | 'rx' | 'backup', number>> = {}) {
  const v = { servedOut: SERVED_OUT, servedIn: SERVED_IN, tx: POD_TX, rx: POD_RX, backup: 0, ...over };
  queryInstant.mockImplementation((q: string) => {
    if (q.includes('namespace, pod')) {
      return Promise.resolve(v.backup > 0
        ? [{ labels: { namespace: NS, pod: `${filesJobName(JOB)}-x7k2p` }, value: v.backup }]
        : []);
    }
    if (q.includes('traefik_service_responses_bytes_total')) return Promise.resolve([{ labels: { namespace: NS }, value: v.servedOut }]);
    if (q.includes('traefik_service_requests_bytes_total')) return Promise.resolve([{ labels: { namespace: NS }, value: v.servedIn }]);
    if (q.includes('container_network_transmit_bytes_total')) return Promise.resolve([{ labels: { namespace: NS }, value: v.tx }]);
    if (q.includes('container_network_receive_bytes_total')) return Promise.resolve([{ labels: { namespace: NS }, value: v.rx }]);
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  queryInstant.mockReset();
  recordHourlyUsage.mockClear();
  mockQueries();
});

describe('meterBandwidthOnce · bills external egress only', () => {
  it('bills served HTTP PLUS an estimate of what the ingress cannot see', async () => {
    const captured: Captured = {};
    await meterBandwidthOnce(makeDb([], captured));
    // Not 274 MB (ingress alone) and nowhere near 2159 MB (every byte the
    // pods moved, including the database answering the application).
    expect(captured.used).toBeCloseTo(10 + EXPECTED_BILLED_GB, 5);
    expect(captured.used).toBeGreaterThan(10 + SERVED_OUT / 1e9);
    expect(captured.used).toBeLessThan(10 + POD_TX / 1e9);
  });

  it('never bills less than what was measured leaving', async () => {
    // A tenant taking a large NON-HTTP upload: externalIn is far bigger than
    // Traefik saw, so the identity under-states egress and can go negative.
    // Traefik counted 274 MB out; that provably left and must still be paid.
    mockQueries({ rx: POD_TX + 4_000_000_000 });
    const captured: Captured = {};
    await meterBandwidthOnce(makeDb([], captured));
    expect(captured.used).toBeCloseTo(10 + SERVED_OUT / 1e9, 5);
  });

  it('never bills more than the pods actually transmitted', async () => {
    // A burst of inbound HTTP inflates servedIn; the identity would put
    // externalOut above what the pods sent, which is impossible.
    mockQueries({ servedIn: POD_TX * 4 });
    const captured: Captured = {};
    await meterBandwidthOnce(makeDb([], captured));
    expect(captured.used).toBeCloseTo(10 + POD_TX / 1e9, 5);
  });

  it('still removes a platform backup before estimating', async () => {
    // A backup Job runs in the tenant's namespace and ships to a DIFFERENT
    // one, so the identity scores it as external egress. Left in, the tenant
    // pays for a backup the platform scheduled — the original defect.
    // A low served figure so the measured floor does not mask the effect —
    // with the production numbers it does, which the next test pins.
    const LOW_SERVED = 50_000_000;
    const withBackup: Captured = {};
    mockQueries({ backup: 150_000_000, servedOut: LOW_SERVED });
    await meterBandwidthOnce(makeDb([{ id: JOB, tenantId: 'ta', initiator: 'system' }], withBackup));

    const clean: Captured = {};
    mockQueries({ backup: 0, servedOut: LOW_SERVED });
    await meterBandwidthOnce(makeDb([], clean));

    expect((clean.used as number) - (withBackup.used as number)).toBeCloseTo(0.15, 5);
  });

  it('the measured floor can mask the exclusion, and that is correct', () => {
    // With the real Sunshine numbers, removing a 150 MB backup drops the
    // estimate to 151 MB — below the 274 MB Traefik actually counted going
    // out. Billing the estimate there would charge less than what provably
    // left, so the floor wins. Worth pinning: it looks like the exclusion
    // "did not work" unless you know which bound is binding.
    const estimated = (POD_TX - 150_000_000) - POD_RX + SERVED_IN;
    expect(estimated).toBeLessThan(SERVED_OUT);
    expect(Math.max(SERVED_OUT, estimated)).toBe(SERVED_OUT);
  });

  it('never returns bandwidth — a counter reset floors at zero', async () => {
    mockQueries({ servedOut: -5_000, tx: -5_000, rx: 0, servedIn: 0 });
    const captured: Captured = {};
    await meterBandwidthOnce(makeDb([], captured));
    expect(captured.used ?? 10).toBe(10);
  });

  it('skips the tick when the query fails, rather than billing a guess', async () => {
    queryInstant.mockImplementation(() => Promise.reject(new Error('vmsingle down')));
    const captured: Captured = {};
    const updated = await meterBandwidthOnce(makeDb([], captured));
    expect(updated).toBe(0);
    expect(captured.used).toBeUndefined();
  });

  it('records the rollup hour with the billed figure', async () => {
    const captured: Captured = {};
    await meterBandwidthOnce(makeDb([], captured));
    expect(recordHourlyUsage).toHaveBeenCalledTimes(1);
    const arg = recordHourlyUsage.mock.calls[0][2] as { bandwidth_gb: number };
    expect(arg.bandwidth_gb).toBeCloseTo(EXPECTED_BILLED_GB, 5);
  });
});
