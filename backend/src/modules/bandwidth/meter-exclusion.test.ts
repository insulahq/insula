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

const SERVED_BYTES = 4_740_000_000;   // what the ingress served for them

beforeEach(() => {
  queryInstant.mockReset();
  recordHourlyUsage.mockClear();
  queryInstant.mockImplementation(() => Promise.resolve(
    [{ labels: { namespace: NS }, value: SERVED_BYTES }],
  ));
});

describe('meterBandwidthOnce · bills external egress only', () => {
  it('reads the ingress, never the pod counters', async () => {
    const captured: Captured = {};
    await meterBandwidthOnce(makeDb([{ id: JOB, tenantId: 'ta', initiator: 'system' }], captured));
    const queries = queryInstant.mock.calls.map((c) => String(c[0]));
    expect(queries.join(' ')).toContain('traefik_service_responses_bytes_total');
    // The old instrument counted the database answering the application.
    expect(queries.join(' ')).not.toContain('container_network_transmit_bytes_total');
  });

  it('bills exactly what was served', async () => {
    const captured: Captured = {};
    await meterBandwidthOnce(makeDb([{ id: JOB, tenantId: 'ta', initiator: 'system' }], captured));
    expect(captured.used).toBeCloseTo(10 + 4.74, 5);
  });

  it('does not run an exclusion query, and bills the same either way', async () => {
    // A platform backup does not pass through the ingress, so there is
    // nothing to deduct. Deducting anyway would hand back bandwidth the
    // tenant did use — and the clamp below would hide most of it.
    const withBackup: Captured = {};
    await meterBandwidthOnce(makeDb([{ id: JOB, tenantId: 'ta', initiator: 'system' }], withBackup));
    const queries = queryInstant.mock.calls.map((c) => String(c[0]));
    expect(queries.some((q) => q.includes('namespace, pod'))).toBe(false);

    queryInstant.mockClear();
    const withNone: Captured = {};
    await meterBandwidthOnce(makeDb([], withNone));
    expect(withNone.used).toBeCloseTo(withBackup.used as number, 5);
  });

  it('never returns bandwidth — a counter reset floors at zero', async () => {
    queryInstant.mockImplementation(() => Promise.resolve(
      [{ labels: { namespace: NS }, value: -5_000 }],
    ));
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
    expect(arg.bandwidth_gb).toBeCloseTo(4.74, 5);
  });
});
