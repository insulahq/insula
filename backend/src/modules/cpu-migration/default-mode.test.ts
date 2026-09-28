/**
 * A release must never move an existing cluster onto a new CPU model, and
 * must never leave a fresh one on the old one.
 *
 * The decision is made ONCE — at the first boot that runs this code — and
 * recorded, because "is this an upgrade or a fresh install" stops being
 * answerable the moment the first tenant is created afterwards.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Database } from '../../db/index.js';
import {
  ensureCpuSchedulingDefault, readCpuSchedulingDefault, cpuModeForNewTenant,
  CPU_SCHEDULING_DEFAULT_KEY,
} from './default-mode.js';

/** A stand-in for the one SELECT and the one INSERT this module makes. */
function dbWith({ stored, tenantCount }: { stored?: string; tenantCount?: number }) {
  const inserted: Array<{ key: string; value: string }> = [];
  let current = stored;
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(current === undefined ? [] : [{ value: current }]),
      }),
    }),
    execute: () => Promise.resolve({ rows: [{ n: String(tenantCount ?? 0) }] }),
    insert: () => ({
      values: (v: { key: string; value: string }) => ({
        onConflictDoNothing: () => {
          inserted.push(v);
          if (current === undefined) current = v.value;
          return Promise.resolve();
        },
      }),
    }),
  } as unknown as Database;
  return { db, inserted };
}

describe('ensureCpuSchedulingDefault', () => {
  it('starts a FRESH install on the tier model', async () => {
    const { db, inserted } = dbWith({ tenantCount: 0 });
    await expect(ensureCpuSchedulingDefault(db)).resolves.toBe('tiered');
    expect(inserted).toEqual([{ key: CPU_SCHEDULING_DEFAULT_KEY, value: 'tiered' }]);
  });

  it('leaves an EXISTING cluster on legacy', async () => {
    // Its tenants are legacy and its plans are sized as reservations.
    // Quietly creating tiered tenants alongside them would hand the
    // operator a namespace-by-namespace split nobody chose.
    const { db, inserted } = dbWith({ tenantCount: 30 });
    await expect(ensureCpuSchedulingDefault(db)).resolves.toBe('legacy');
    expect(inserted).toEqual([{ key: CPU_SCHEDULING_DEFAULT_KEY, value: 'legacy' }]);
  });

  it('never revisits a decision already recorded', async () => {
    // Even on a cluster that now has tenants: the operator may have chosen
    // this, and a boot must not argue with it.
    const { db, inserted } = dbWith({ stored: 'tiered', tenantCount: 30 });
    await expect(ensureCpuSchedulingDefault(db)).resolves.toBe('tiered');
    expect(inserted).toEqual([]);
  });

  it('yields to a replica that won the race', async () => {
    // Two replicas boot together; the insert is ON CONFLICT DO NOTHING, so
    // the loser must report the stored answer, not its own.
    const { db } = dbWith({ tenantCount: 0 });
    const logged: object[] = [];
    await ensureCpuSchedulingDefault(db, { info: (o) => { logged.push(o); } });
    expect(logged[0]).toMatchObject({ decided: 'tiered' });
  });
});

describe('cpuModeForNewTenant', () => {
  /**
   * ★ Asked when a tenant is about to be created, not at boot.
   *
   * A disaster-recovery rebuild starts the API against a freshly-migrated,
   * EMPTY database and restores the backup afterwards. A boot-time decision
   * would see zero tenants, conclude "fresh install", and permanently
   * record `tiered` for a cluster with thirty legacy tenants about to
   * reappear. Asking at creation time cannot race a restore, because a
   * restore is what puts the tenants there.
   */
  it('decides on FIRST USE when nothing is recorded yet', async () => {
    const { db, inserted } = dbWith({ tenantCount: 0 });
    await expect(cpuModeForNewTenant(db)).resolves.toBe('tiered');
    expect(inserted).toHaveLength(1);
  });

  it('answers legacy for a cluster that already has tenants', async () => {
    const { db } = dbWith({ tenantCount: 30 });
    await expect(cpuModeForNewTenant(db)).resolves.toBe('legacy');
  });

  it('falls back to legacy when the read THROWS', async () => {
    const db = { select: () => { throw new Error('db down'); } } as unknown as Database;
    await expect(cpuModeForNewTenant(db)).resolves.toBe('legacy');
  });

  it('reports the recorded value without re-deciding', async () => {
    const { db, inserted } = dbWith({ stored: 'tiered', tenantCount: 30 });
    await expect(cpuModeForNewTenant(db)).resolves.toBe('tiered');
    expect(inserted).toEqual([]);
  });

  it('treats an unrecognised stored value as undecided', async () => {
    const { db } = dbWith({ stored: 'banana' });
    await expect(readCpuSchedulingDefault(db)).resolves.toBeNull();
  });
});
