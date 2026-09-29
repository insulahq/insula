/**
 * Meter-level proof that platform backup bytes never reach the tenant row.
 *
 * The unit tests next door prove the exclusion MAP is right; this proves the
 * subtraction is actually applied to `bandwidth_gb_used`, which is the number
 * a tenant is billed and suspended on.
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

const TOTAL_BYTES = 22_140_000_000;   // what the namespace moved
const BACKUP_BYTES = 17_400_000_000;  // of which the platform's own backup

beforeEach(() => {
  queryInstant.mockReset();
  recordHourlyUsage.mockClear();
  queryInstant.mockImplementation((q: string) => Promise.resolve(
    q.includes('namespace, pod')
      ? [{ labels: { namespace: NS, pod: `${filesJobName(JOB)}-x7k2p` }, value: BACKUP_BYTES }]
      : [{ labels: { namespace: NS }, value: TOTAL_BYTES }],
  ));
});

describe('meterBandwidthOnce · platform backup exclusion', () => {
  it('bills only the non-backup remainder', async () => {
    const captured: Captured = {};
    await meterBandwidthOnce(makeDb([{ id: JOB, tenantId: 'ta', initiator: 'system' }], captured));
    // 10 GB already used + (22.14 - 17.40) GB billable
    expect(captured.used).toBeCloseTo(10 + 4.74, 5);
  });

  it('bills the whole namespace when the backup was the tenant’s own', async () => {
    const captured: Captured = {};
    await meterBandwidthOnce(makeDb([], captured));
    expect(captured.used).toBeCloseTo(10 + 22.14, 5);
  });

  it('never returns bandwidth when the exclusion exceeds the total', async () => {
    queryInstant.mockImplementation((q: string) => Promise.resolve(
      q.includes('namespace, pod')
        ? [{ labels: { namespace: NS, pod: `${filesJobName(JOB)}-x7k2p` }, value: TOTAL_BYTES + 5_000 }]
        : [{ labels: { namespace: NS }, value: TOTAL_BYTES }],
    ));
    const captured: Captured = {};
    await meterBandwidthOnce(makeDb([{ id: JOB, tenantId: 'ta', initiator: 'system' }], captured));
    expect(captured.used).toBe(10); // unchanged, not 10 - something
  });

  it('skips the tick when the exclusion query fails, rather than billing the backup', async () => {
    queryInstant.mockImplementation((q: string) => (q.includes('namespace, pod')
      ? Promise.reject(new Error('vmsingle down'))
      : Promise.resolve([{ labels: { namespace: NS }, value: TOTAL_BYTES }])));
    const captured: Captured = {};
    const updated = await meterBandwidthOnce(makeDb([{ id: JOB, tenantId: 'ta', initiator: 'system' }], captured));
    expect(updated).toBe(0);
    expect(captured.used).toBeUndefined();
  });

  it('records the rollup hour with the billable figure, not the raw one', async () => {
    const captured: Captured = {};
    await meterBandwidthOnce(makeDb([{ id: JOB, tenantId: 'ta', initiator: 'system' }], captured));
    expect(recordHourlyUsage).toHaveBeenCalledTimes(1);
    const arg = recordHourlyUsage.mock.calls[0][2] as { bandwidth_gb: number };
    expect(arg.bandwidth_gb).toBeCloseTo(4.74, 5);
  });
});
