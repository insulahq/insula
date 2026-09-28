/**
 * The boot sweep must not strip a tiered namespace — and must put back the
 * ceilings its own predecessor stripped.
 *
 * This reconciler is the widest blast radius in the platform: it walks EVERY
 * tenant on EVERY API start. When it wrote the legacy CPU shape it removed
 * the ADR-062 burst ceiling from every migrated namespace in one pass.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Database } from '../../db/index.js';
import type { K8sClients } from './k8s-client.js';

const applyResourceQuota = vi.fn();
vi.mock('./service.js', () => ({ applyResourceQuota: (...a: unknown[]) => applyResourceQuota(...a) }));

type Row = Record<string, unknown>;

/**
 * Minimal stand-in for `db.select({...}).from(t).leftJoin(t, on)` plus the
 * raw `db.execute` that looks up in-flight migrations.
 */
function dbWith(rows: Row[], midChange: string[] = []): Database {
  return {
    select: () => ({ from: () => ({ leftJoin: () => Promise.resolve(rows) }) }),
    execute: () => Promise.resolve({ rows: midChange.map((ref_id) => ({ ref_id })) }),
  } as unknown as Database;
}

const log = { info: vi.fn(), warn: vi.fn() };

const BASE: Row = {
  id: 't1',
  namespace: 'tenant-acme',
  planId: 'p1',
  cpuLimitOverride: null,
  memoryLimitOverride: null,
  storageLimitOverride: null,
  cpuSchedulingMode: 'legacy',
  cpuTierOverride: null,
  cpuBurstCoresOverride: null,
  cpuLimit: '0.25',
  memoryLimit: '1.00',
  storageLimit: '5.00',
  planCpuTier: null,
  planCpuBurstCores: null,
};

async function sweep(row: Row, midChange: string[] = []) {
  const { reconcileAllTenantQuotas } = await import('./quota-reconciler.js');
  await reconcileAllTenantQuotas(dbWith([row], midChange), {} as K8sClients, log);
  return applyResourceQuota.mock.calls[0];
}

describe('reconcileAllTenantQuotas', () => {
  beforeEach(() => { applyResourceQuota.mockReset(); });

  it('declares a legacy tenant legacy, so a stray ceiling is dropped', async () => {
    const call = await sweep(BASE);
    expect(call[2]).toEqual({ cpu: '0.25', memory: '1.00', storage: '5.00' });
    expect(call[3]).toEqual({ cpuModel: { mode: 'legacy' } });
  });

  it('carries the resolved ceiling for a tiered tenant so a stripped quota is repaired', async () => {
    // No plan tier and no override: burst is DERIVED from the plan's
    // cpu_limit as max(1, 0.25 x 2) = 1 core, and the quota backstop is 4x.
    const call = await sweep({ ...BASE, cpuSchedulingMode: 'tiered' });
    expect(call[3]).toEqual({ cpuModel: { mode: 'tiered', ceilingCores: 4 } });
  });

  it('prefers the tenant override over the plan for the restored ceiling', async () => {
    const call = await sweep({
      ...BASE,
      cpuSchedulingMode: 'tiered',
      planCpuBurstCores: '1.50',
      cpuBurstCoresOverride: '0.50',
    });
    expect(call[3]).toEqual({ cpuModel: { mode: 'tiered', ceilingCores: 2 } });
  });

  // ★ The window the runners open on purpose. A migration installs the
  // ceiling BEFORE marking the tenant tiered; a revert removes it BEFORE
  // marking the tenant legacy. An API restart inside either window must
  // leave the cluster alone — believing the database would undo the step the
  // runner had just taken, and a ceiling restored onto a reverting tenant is
  // permanent, because nothing removes one from a tenant nobody calls
  // tiered.
  it('leaves the CPU keys alone while a migration or revert is in flight', async () => {
    const call = await sweep({ ...BASE, cpuSchedulingMode: 'tiered' }, ['t1']);
    expect(call[3]).toEqual({ cpuModel: undefined });
  });

  it('leaves them alone mid-REVERT too, when the row still reads tiered', async () => {
    const call = await sweep({ ...BASE, cpuSchedulingMode: 'legacy' }, ['t1']);
    expect(call[3]).toEqual({ cpuModel: undefined });
  });

  // A 0-core burst is a real ceiling and it freezes the namespace. Neither
  // writing it nor calling the tenant legacy (which strips a ceiling it
  // should keep) is acceptable, so the sweep says so and touches nothing.
  it('refuses to derive a ceiling of zero and says why', async () => {
    const call = await sweep({
      ...BASE, cpuSchedulingMode: 'tiered', cpuBurstCoresOverride: '0',
    });
    expect(call[3]).toEqual({ cpuModel: undefined });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1' }),
      expect.stringContaining('no usable burst ceiling'),
    );
  });

  it('keeps reconciling the remaining tenants when one fails', async () => {
    applyResourceQuota.mockRejectedValueOnce(new Error('403 forbidden'));
    const { reconcileAllTenantQuotas } = await import('./quota-reconciler.js');
    const res = await reconcileAllTenantQuotas(
      dbWith([{ ...BASE, id: 'a', namespace: 'ns-a' }, { ...BASE, id: 'b', namespace: 'ns-b' }]),
      {} as K8sClients,
      log,
    );
    expect(res).toMatchObject({ scanned: 2, reconciled: 1, errors: [{ tenantId: 'a' }] });
  });

  it('skips a tenant with no namespace rather than writing a quota nowhere', async () => {
    const res = await (await import('./quota-reconciler.js')).reconcileAllTenantQuotas(
      dbWith([{ ...BASE, namespace: null }]), {} as K8sClients, log,
    );
    expect(res.skipped).toBe(1);
    expect(applyResourceQuota).not.toHaveBeenCalled();
  });
});
