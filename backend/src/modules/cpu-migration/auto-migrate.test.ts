/**
 * Every tenant left on the old reservation model is moved to CPU shares,
 * one at a time, without an operator's click.
 */
import { describe, it, expect, vi } from 'vitest';
import { ApiError } from '../../shared/errors.js';
import { autoMigrateLegacyTenants, RETRY_AFTER_MS, type Attempt, type AutoMigrateDeps, type LegacyTenant } from './auto-migrate.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const t = (id: string, namespace: string | null = `tenant-${id}`): LegacyTenant => ({ id, name: id.toUpperCase(), namespace });

function deps(over: Partial<AutoMigrateDeps> & { tenants?: LegacyTenant[]; attempts?: Record<string, Attempt> } = {}) {
  const attempts = new Map(Object.entries(over.attempts ?? {}));
  const order: string[] = [];
  const d: AutoMigrateDeps = {
    listLegacy: async () => over.tenants ?? [t('a'), t('b')],
    namespaceExists: async () => true,
    rollingOut: async () => false,
    markTiered: vi.fn(async () => undefined),
    migrate: vi.fn(async (id: string) => { order.push(id); return { outcome: 'completed' as const, reason: null }; }),
    lastAttempt: async (id) => attempts.get(id) ?? null,
    recordAttempt: vi.fn(async (id, a) => { attempts.set(id, a); }),
    now: () => NOW,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
  return { d, order, attempts };
}

describe('autoMigrateLegacyTenants', () => {
  it('migrates every legacy tenant, one after another, oldest first', async () => {
    const { d, order } = deps();
    const r = await autoMigrateLegacyTenants(d, { budgetMs: 60_000, maxTenants: 10 });
    expect(order).toEqual(['a', 'b']);
    expect(r).toMatchObject({ migrated: 2, failed: 0, remaining: 0 });
  });

  it('a tenant with no namespace is marked tiered — nothing in the cluster to move', async () => {
    const { d } = deps({ tenants: [t('never', null), t('archived')], namespaceExists: async (ns) => ns !== 'tenant-archived' });
    const r = await autoMigrateLegacyTenants(d, { budgetMs: 60_000, maxTenants: 10 });
    expect(d.markTiered).toHaveBeenCalledTimes(2);
    expect(d.migrate).not.toHaveBeenCalled();
    expect(r.markedWithoutNamespace).toBe(2);
  });

  it('a failure is recorded and waits a day; the next tenant still goes', async () => {
    const { d, attempts } = deps({
      migrate: vi.fn(async (id: string) => (id === 'a'
        ? { outcome: 'failed' as const, reason: 'workload web never became ready' }
        : { outcome: 'completed' as const, reason: null })),
    });
    const r = await autoMigrateLegacyTenants(d, { budgetMs: 60_000, maxTenants: 10 });
    expect(r).toMatchObject({ migrated: 1, failed: 1 });
    expect(attempts.get('a')).toMatchObject({ outcome: 'failed', reason: 'workload web never became ready' });

    // Inside the day: left alone.
    const again = await autoMigrateLegacyTenants({ ...d, listLegacy: async () => [t('a')] }, { budgetMs: 60_000, maxTenants: 10 });
    expect(again).toMatchObject({ waiting: 1, migrated: 0, failed: 0 });
  });

  it('after a day it is tried again', async () => {
    const old: Attempt = { at: new Date(NOW.getTime() - RETRY_AFTER_MS - 1).toISOString(), outcome: 'failed', reason: 'x' };
    const { d } = deps({ tenants: [t('a')], attempts: { a: old } });
    expect(await autoMigrateLegacyTenants(d, { budgetMs: 60_000, maxTenants: 10 })).toMatchObject({ migrated: 1 });
  });

  it('an operator\'s Stop is respected for the day too', async () => {
    const stopped: Attempt = { at: new Date(NOW.getTime() - 60_000).toISOString(), outcome: 'stopped', reason: null };
    const { d } = deps({ tenants: [t('a')], attempts: { a: stopped } });
    expect(await autoMigrateLegacyTenants(d, { budgetMs: 60_000, maxTenants: 10 })).toMatchObject({ waiting: 1 });
    expect(d.migrate).not.toHaveBeenCalled();
  });

  it('a migration someone started by hand is not counted as a failure', async () => {
    const { d } = deps({
      tenants: [t('a')],
      migrate: vi.fn(async () => { throw new ApiError('CPU_MIGRATION_IN_PROGRESS', 'running', 409); }),
    });
    expect(await autoMigrateLegacyTenants(d, { budgetMs: 60_000, maxTenants: 10 })).toMatchObject({ failed: 0, migrated: 0 });
    expect(d.recordAttempt).not.toHaveBeenCalled();
  });

  it('a thrown error is a failed attempt with its message', async () => {
    const { d, attempts } = deps({ tenants: [t('a')], migrate: vi.fn(async () => { throw new Error('apiserver unreachable'); }) });
    await autoMigrateLegacyTenants(d, { budgetMs: 60_000, maxTenants: 10 });
    expect(attempts.get('a')).toMatchObject({ outcome: 'failed', reason: 'apiserver unreachable' });
  });

  it('a tenant whose cluster read fails costs that tenant a day, not the pass', async () => {
    // Oldest first: if this aborted the pass, the tenant would starve every
    // tenant behind it on every tick.
    const { d, attempts, order } = deps({
      tenants: [t('broken'), t('b')],
      namespaceExists: async (ns) => { if (ns === 'tenant-broken') throw new Error('forbidden'); return true; },
    });
    const r = await autoMigrateLegacyTenants(d, { budgetMs: 60_000, maxTenants: 10 });
    expect(order).toEqual(['b']);
    expect(r).toMatchObject({ migrated: 1, failed: 1 });
    expect(attempts.get('broken')).toMatchObject({ outcome: 'failed', reason: 'forbidden' });
  });

  it('waits for a tenant whose application is mid-rollout — it would be passed over', async () => {
    const { d, order } = deps({ tenants: [t('busy'), t('b')], rollingOut: async (id) => id === 'busy' });
    const r = await autoMigrateLegacyTenants(d, { budgetMs: 60_000, maxTenants: 10 });
    expect(order).toEqual(['b']);
    expect(r).toMatchObject({ waiting: 1, migrated: 1, failed: 0 });
    expect(d.recordAttempt).toHaveBeenCalledTimes(1); // only b — busy is not a failure
  });

  it('moves at most maxTenants a pass', async () => {
    const { d, order } = deps({ tenants: [t('a'), t('b'), t('c'), t('d')] });
    const r = await autoMigrateLegacyTenants(d, { budgetMs: 60_000, maxTenants: 3 });
    expect(order).toEqual(['a', 'b', 'c']);
    expect(r.remaining).toBe(1);
  });

  it('stops starting tenants once its budget is spent, and says how many remain', async () => {
    let clock = NOW.getTime();
    const { d } = deps({
      tenants: [t('a'), t('b'), t('c')],
      now: () => new Date(clock),
      migrate: vi.fn(async () => { clock += 40_000; return { outcome: 'completed' as const, reason: null }; }),
    });
    const r = await autoMigrateLegacyTenants(d, { budgetMs: 60_000, maxTenants: 10 });
    expect(r).toMatchObject({ migrated: 2, remaining: 1 });
  });
});
