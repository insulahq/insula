/**
 * A tenant's cascades for an operation picked up again — against a REAL
 * Postgres with every migration applied, so the transition and hook-run rows
 * are the real tables and the dispatcher is the real one.
 *
 * A storage operation that archives or restores a tenant runs the tenant's
 * cascades near its end. When its process dies there and the operation is
 * picked up, the cascades must be neither repeated nor cut short: a hook that
 * ended is not run again, and the ones the first run never reached are.
 *
 * Needs a database — CI's integration job provides DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { tenantLifecycleHookRuns, tenantLifecycleTransitions } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { applyOnceSince } from './cascades.js';
import { _resetRegistryForTests, registerLifecycleHook, runTransition, type HookResult, type LifecycleHook } from './registry/index.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('cascades of an operation picked up again (real Postgres)', () => {
  const db = () => getTestDb() as unknown as Database;
  const k8s = {} as K8sClients;
  let tenantId = '';
  const ran: string[] = [];
  /** What each hook answers; `dies` stands for the process ending inside it. */
  let outcome: Record<string, HookResult['status'] | 'dies'> = {};

  const hook = (name: string, order: number, blocking: 'abort' | 'continue' = 'continue'): LifecycleHook => ({
    name, order, blocking, transitions: ['archived'],
    run: async () => {
      ran.push(name);
      const answer = outcome[name] ?? 'ok';
      if (answer === 'dies') throw new ProcessDied();
      return answer === 'ok' || answer === 'noop' ? { status: answer } : { status: answer, envelope: { title: `${name} failed` } };
    },
  } as LifecycleHook);
  class ProcessDied extends Error {}

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { _resetRegistryForTests(); await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    const region = await seedRegion(db());
    const plan = await seedPlan(db());
    tenantId = (await seedTenant(db(), region.id, plan.id)).id;
    ran.length = 0; outcome = {};
    _resetRegistryForTests();
    for (const h of [hook('mail', 100), hook('status-stamp', 250, 'abort'), hook('ingress', 300), hook('tell-tenant', 900)]) registerLifecycleHook(h);
  });

  const transitions = () => db().select().from(tenantLifecycleTransitions).where(eq(tenantLifecycleTransitions.tenantId, tenantId)).orderBy(asc(tenantLifecycleTransitions.startedAt));
  const hookStates = async (transitionId: string): Promise<Record<string, string>> => Object.fromEntries(
    (await db().select().from(tenantLifecycleHookRuns).where(eq(tenantLifecycleHookRuns.transitionId, transitionId)))
      .map((r) => [r.hookName, r.state]),
  );
  /**
   * A first run whose process died inside `at`: the hooks before it ended, it
   * reads `running`, the ones after it `pending`, the transition `running`.
   */
  const firstRunDiedIn = async (at: string): Promise<string> => {
    const { transitionId } = await runTransition(db(), k8s, { tenantId, namespace: 'tenant-x', transition: 'archived', toStatus: 'archived', skipExecution: true });
    const order = ['mail', 'status-stamp', 'ingress', 'tell-tenant'];
    for (const name of order.slice(0, order.indexOf(at))) {
      await db().update(tenantLifecycleHookRuns).set({ state: 'ok', attempts: 1, completedAt: new Date() })
        .where(eq(tenantLifecycleHookRuns.hookName, name));
    }
    await db().update(tenantLifecycleHookRuns).set({ state: 'running', attempts: 1, startedAt: new Date() })
      .where(eq(tenantLifecycleHookRuns.hookName, at));
    return transitionId;
  };
  const opBegan = new Date(Date.now() - 60_000);
  const once = (since = opBegan) => applyOnceSince({ db: db(), k8s }, tenantId, 'tenant-x', 'archived', since);

  it('the first run never got to the cascades: they are run, all of them', async () => {
    const id = await once();
    expect(ran).toEqual(['mail', 'status-stamp', 'ingress', 'tell-tenant']);
    expect(await transitions()).toMatchObject([{ id, state: 'completed', transitionKind: 'archived', toStatus: 'archived' }]);
  });

  it('the first run died after the status was stamped: the hooks after it are run — and the ones before it are not run again', async () => {
    const first = await firstRunDiedIn('ingress');
    expect(await once()).toBe(first);
    expect(ran).toEqual(['ingress', 'tell-tenant']);
    expect(await hookStates(first)).toEqual({ mail: 'ok', 'status-stamp': 'ok', ingress: 'ok', 'tell-tenant': 'ok' });
    const all = await transitions();
    expect(all).toMatchObject([{ id: first, state: 'completed' }]);      // finished, not started a second time
    expect(all[0].completedAt).not.toBeNull();
  });

  it('the first run died inside the last hook, the tenant\'s message: that one is run again, nothing else', async () => {
    const first = await firstRunDiedIn('tell-tenant');
    await once();
    expect(ran).toEqual(['tell-tenant']);
    expect((await transitions())[0]).toMatchObject({ id: first, state: 'completed' });
  });

  it('the first run finished them: nothing is run — the tenant is not told twice', async () => {
    const first = await once();
    ran.length = 0;
    expect(await once()).toBe(first);
    expect(ran).toEqual([]);
    expect(await transitions()).toHaveLength(1);
  });

  it('a hook that failed the first time stays the retry scheduler\'s: it is not run here, and the transition says so', async () => {
    outcome = { mail: 'retry' };
    const first = await once();
    expect((await transitions())[0].state).toBe('failed_partial');
    ran.length = 0;
    await once();
    expect(ran).toEqual([]);
    expect((await hookStates(first!)).mail).toBe('failed');
  });

  it('a blocking hook that failed before the process died still stops the rest', async () => {
    const first = await firstRunDiedIn('ingress');
    await db().update(tenantLifecycleHookRuns).set({ state: 'failed' }).where(eq(tenantLifecycleHookRuns.hookName, 'status-stamp'));
    await once();
    expect(ran).toEqual([]);
    expect((await transitions())[0]).toMatchObject({ id: first, state: 'failed_blocking' });
    expect(await hookStates(first)).toMatchObject({ ingress: 'running', 'tell-tenant': 'pending' });
  });

  it('a transition from before the operation began is another archive\'s: the cascades are run anew', async () => {
    const earlier = await firstRunDiedIn('ingress');
    await db().update(tenantLifecycleTransitions).set({ startedAt: new Date(opBegan.getTime() - 3_600_000) }).where(eq(tenantLifecycleTransitions.id, earlier));
    const id = await once();
    expect(id).not.toBe(earlier);
    expect(ran).toEqual(['mail', 'status-stamp', 'ingress', 'tell-tenant']);
    expect((await transitions()).map((t) => t.state)).toEqual(['running', 'completed']);
  });

  it.each<[string, (id: string) => Promise<unknown>]>([
    ['of another kind', (id) => db().update(tenantLifecycleTransitions).set({ transitionKind: 'suspended' }).where(eq(tenantLifecycleTransitions.id, id))],
    ['of another tenant', (id) => db().update(tenantLifecycleTransitions).set({ tenantId: crypto.randomUUID() }).where(eq(tenantLifecycleTransitions.id, id))],
  ])('a transition %s is not this operation\'s: the cascades are run anew', async (_what, makeItSo) => {
    const other = await firstRunDiedIn('ingress');
    await makeItSo(other);
    const id = await once();
    expect(id).not.toBe(other);
    expect(ran).toEqual(['mail', 'status-stamp', 'ingress', 'tell-tenant']);
    expect((await hookStates(other)).ingress).toBe('running');           // left as it was
  });
});
