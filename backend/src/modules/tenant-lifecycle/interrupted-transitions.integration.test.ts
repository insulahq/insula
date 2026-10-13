/**
 * A lifecycle transition whose process is gone is finished — against a REAL
 * Postgres with every migration applied, so the transition, hook-run, tenant,
 * operation and lock rows are the real tables, and the dispatcher and the
 * tenant delete are the real ones.
 *
 * The hooks and the cluster are stand-ins; what is under test is which
 * transitions are taken for interrupted, which of those are finished and which
 * only closed, that a delete is taken to its end, and that a transition
 * somebody is running is never touched.
 *
 * Needs a database — CI's integration job provides DATABASE_URL.
 */
import { hostname } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { storageOperations, tenantLifecycleHookRuns, tenantLifecycleTransitions, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { runLockName } from '../../shared/exclusive-run.js';
import { REPLICA_ID } from '../../shared/scheduler-lease.js';
import { _resetRegistryForTests, registerLifecycleHook, runTransition, type HookCtx, type HookResult, type LifecycleHook, type Transition } from './registry/index.js';
import { transitionLockJob } from './registry/transition-lock.js';
import { tenantLockJob } from './tenant-lock.js';

/** What the hooks and the stand-in cluster were asked to do, in order. */
const did: string[] = [];

vi.mock('../tenant-placement/relocate.js', () => ({ releaseRelocationsInNamespace: async () => undefined }));
vi.mock('./reap-namespace-volumes.js', () => ({
  reapNamespaceVolumes: async () => ({ pvsReaped: [], lhVolsReaped: [], timedOut: false }),
  realReapDeps: () => ({}),
}));

const {
  findInterruptedTransitions, pickUpInterruptedTransitions, requeueInterruptedRetries, whyNotFinished, closeInterruptedTransition,
  DEAD_HOLDER_GRACE_MS, TRANSITION_MAX_RESUMES,
} = await import('./interrupted-transitions.js');

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('lifecycle transitions interrupted by a restart (real Postgres)', () => {
  const db = () => getTestDb() as unknown as Database;
  let regionId = '';
  let planId = '';
  const log: string[] = [];
  /** The API pods the stand-in cluster lists. */
  let apiPods: Array<{ name: string; image: string }> = [];
  /** What each hook answers. */
  let outcome: Record<string, HookResult['status']> = {};
  /** Called inside a hook, by its name. */
  let inside: Record<string, (ctx: HookCtx) => Promise<void>> = {};

  const k8s = {
    core: {
      listNamespacedPod: async () => ({
        items: apiPods.map((p) => ({ metadata: { name: p.name }, spec: { containers: [{ image: p.image }] }, status: { phase: 'Running' } })),
      }),
      deleteNamespace: async ({ name }: { name: string }) => { did.push(`delete namespace ${name}`); },
    },
  } as unknown as K8sClients;

  const ORDER = ['mail', 'status-stamp', 'ingress', 'tell-tenant'] as const;
  const KINDS: Transition[] = ['active', 'suspended', 'archived', 'restored', 'deleted'];
  const hook = (name: string, order: number, blocking: 'abort' | 'continue' = 'continue'): LifecycleHook => ({
    name, order, blocking, transitions: KINDS,
    run: async (ctx: HookCtx) => {
      did.push(`${name}${ctx.suppressTenantNotification ? ' (the tenant not told)' : ''}`);
      await inside[name]?.(ctx);
      const answer = outcome[name] ?? 'ok';
      return answer === 'ok' || answer === 'noop' ? { status: answer } : { status: answer, envelope: { title: `${name} failed` } };
    },
  } as LifecycleHook);

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { _resetRegistryForTests(); await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql.raw('TRUNCATE TABLE tenant_lifecycle_transitions CASCADE'));
    await db().execute(sql.raw(`DELETE FROM platform_settings WHERE setting_key LIKE 'scheduler-lease:%'`));
    regionId = (await seedRegion(db())).id;
    planId = (await seedPlan(db())).id;
    did.length = 0; log.length = 0; outcome = {}; inside = {}; apiPods = [];
    _resetRegistryForTests();
    for (const h of [hook('mail', 100), hook('status-stamp', 250, 'abort'), hook('ingress', 300), hook('tell-tenant', 900)]) registerLifecycleHook(h);
  });

  const key = (job: string): string => `scheduler-lease:${runLockName(job)}`;
  /** A lock row as a process leaves it: `seconds` ahead (negative: lapsed that long ago). */
  const lockAt = (job: string, seconds: number, holder = 'replica-that-died') => db().execute(sql`
    INSERT INTO platform_settings (setting_key, setting_value)
    VALUES (${key(job)}, json_build_object('holder', ${holder}::text, 'until', now() + make_interval(secs => ${seconds}))::text)
    ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`);
  const lockRow = async (job: string): Promise<{ holder: string } | null> => {
    const res = await db().execute(sql`SELECT setting_value FROM platform_settings WHERE setting_key = ${key(job)}`) as unknown as { rows: Array<{ setting_value: string }> };
    return res.rows[0] ? JSON.parse(res.rows[0].setting_value) as { holder: string } : null;
  };
  const DEAD = -(DEAD_HOLDER_GRACE_MS / 1000) - 60;

  interface Cut { tenantId: string; id: string; namespace: string }
  /**
   * A transition whose first run died inside `at`: the hooks before it ended,
   * it reads `running`, the ones after it `pending`, the transition `running`.
   * Its lock lapsed long ago unless `lock` says otherwise (`null`: no lock row,
   * as an older release leaves it).
   */
  const cutOff = async (kind: Transition, over: {
    at?: typeof ORDER[number];
    lock?: number | null;
    minutesOld?: number;
    tenantStatus?: 'active' | 'suspended' | 'archived';
    detail?: Record<string, unknown>;
    tenantId?: string;
    namespace?: string;
    toStatus?: string;
    /** Every hook ended: cut off after the last one, before the transition was ended. */
    hooksDone?: boolean;
  } = {}): Promise<Cut> => {
    const tenant = over.tenantId
      ? { id: over.tenantId, kubernetesNamespace: over.namespace ?? 'tenant-x' }
      : await seedTenant(db(), regionId, planId, { status: over.tenantStatus ?? 'active' });
    const { transitionId } = await runTransition(db(), k8s, {
      tenantId: tenant.id, namespace: tenant.kubernetesNamespace, transition: kind,
      toStatus: over.toStatus ?? (kind === 'restored' ? 'active' : kind), skipExecution: true, ...(over.detail ? { detail: over.detail } : {}),
    });
    const at = over.at ?? 'ingress';
    for (const name of ORDER.slice(0, ORDER.indexOf(at))) {
      await db().update(tenantLifecycleHookRuns).set({ state: 'ok', attempts: 1, completedAt: new Date() })
        .where(sql`${tenantLifecycleHookRuns.transitionId} = ${transitionId} AND ${tenantLifecycleHookRuns.hookName} = ${name}`);
    }
    await db().update(tenantLifecycleHookRuns).set({ state: 'running', attempts: 1, startedAt: new Date() })
      .where(sql`${tenantLifecycleHookRuns.transitionId} = ${transitionId} AND ${tenantLifecycleHookRuns.hookName} = ${at}`);
    if (over.hooksDone) {
      await db().update(tenantLifecycleHookRuns).set({ state: 'ok', attempts: 1, completedAt: new Date() })
        .where(eq(tenantLifecycleHookRuns.transitionId, transitionId));
    }
    await db().execute(sql`UPDATE tenant_lifecycle_transitions SET started_at = now() - make_interval(mins => ${over.minutesOld ?? 30}) WHERE id = ${transitionId}`);
    if (over.lock !== null) await lockAt(transitionLockJob(transitionId), over.lock ?? DEAD);
    return { tenantId: tenant.id, id: transitionId, namespace: tenant.kubernetesNamespace };
  };

  const transition = async (id: string) => (await db().select().from(tenantLifecycleTransitions).where(eq(tenantLifecycleTransitions.id, id)))[0];
  const hooks = async (id: string) => db().select().from(tenantLifecycleHookRuns)
    .where(eq(tenantLifecycleHookRuns.transitionId, id)).orderBy(asc(tenantLifecycleHookRuns.hookOrder));
  const hookStates = async (id: string): Promise<Record<string, string>> => Object.fromEntries((await hooks(id)).map((r) => [r.hookName, r.state]));
  const tenantRow = async (id: string) => (await db().select().from(tenants).where(eq(tenants.id, id)))[0];
  const pickUp = (on: Database = db()) => pickUpInterruptedTransitions(on, k8s, 'platform', (line) => { log.push(line); });
  const found = async () => (await findInterruptedTransitions(db())).map((t) => t.id);
  /** The database, with something happening right after its first raw query — the finder's look. */
  const racing = (then: () => Promise<unknown>): Database => {
    const real = db().execute.bind(db());
    let first = true;
    return new Proxy(db(), {
      get: (target, prop, receiver) => (prop === 'execute'
        ? async (query: unknown) => {
          const res = await real(query as Parameters<typeof real>[0]);
          if (first) { first = false; await then(); }
          return res;
        }
        : Reflect.get(target, prop, receiver)),
    }) as Database;
  };
  /**
   * A storage operation that owns the tenant. It began `minutesAgo` — before
   * the transition, which is 30 minutes old, unless said otherwise — and one
   * that has ended did so just now, or `endedMinutesAgo`.
   */
  const owning = async (tenantId: string, state: 'quiescing' | 'failed' | 'idle', over: { minutesAgo?: number; endedMinutesAgo?: number } = {}) => {
    const opId = crypto.randomUUID();
    await db().insert(storageOperations).values({
      id: opId, tenantId, opType: 'archive', state,
      createdAt: new Date(Date.now() - (over.minutesAgo ?? 45) * 60_000),
      ...(state === 'quiescing' ? {} : { completedAt: new Date(Date.now() - (over.endedMinutesAgo ?? 0) * 60_000) }),
    });
    await db().update(tenants).set({ storageLifecycleState: state, activeStorageOpId: opId }).where(eq(tenants.id, tenantId));
  };

  describe('the dispatcher holds a transition\'s lock for as long as it runs', () => {
    it('held by this process inside a hook, given back when the transition ends', async () => {
      const tenant = await seedTenant(db(), regionId, planId);
      let during: { holder: string } | null = null;
      let id = '';
      inside.ingress = async (ctx) => { id = ctx.transitionId; during = await lockRow(transitionLockJob(ctx.transitionId)); };
      const res = await runTransition(db(), k8s, { tenantId: tenant.id, namespace: tenant.kubernetesNamespace, transition: 'suspended', toStatus: 'suspended' });
      expect(res).toMatchObject({ transitionId: id, state: 'completed' });
      expect(during).toMatchObject({ holder: REPLICA_ID });
      expect(await lockRow(transitionLockJob(id))).toBeNull();
    });

    it('a transition being run is never among the interrupted', async () => {
      const tenant = await seedTenant(db(), regionId, planId);
      let seen: string[] | null = null;
      inside.mail = async () => {
        await db().execute(sql`UPDATE tenant_lifecycle_transitions SET started_at = now() - interval '1 hour'`);
        seen = await found();
      };
      await runTransition(db(), k8s, { tenantId: tenant.id, namespace: tenant.kubernetesNamespace, transition: 'suspended', toStatus: 'suspended' });
      expect(seen).toEqual([]);
    });

    it('keeps the operator\'s "do not tell the tenant" on the row, for whoever finishes it', async () => {
      const tenant = await seedTenant(db(), regionId, planId);
      const res = await runTransition(db(), k8s, {
        tenantId: tenant.id, namespace: tenant.kubernetesNamespace, transition: 'deleted', toStatus: 'deleted',
        suppressTenantNotification: true, detail: { tenantName: 'Acme' },
      });
      expect((await transition(res.transitionId)).detail).toEqual({ tenantName: 'Acme', suppressTenantNotification: true });
      const told = await runTransition(db(), k8s, { tenantId: tenant.id, namespace: tenant.kubernetesNamespace, transition: 'suspended', toStatus: 'suspended' });
      expect((await transition(told.transitionId)).detail).toBeNull();
    });

    it('finishing one that another process is finishing runs nothing', async () => {
      const cut = await cutOff('suspended', { lock: 90 });
      const res = await runTransition(db(), k8s, { tenantId: cut.tenantId, namespace: cut.namespace, transition: 'suspended', toStatus: 'suspended', resumeTransitionId: cut.id });
      expect(res).toMatchObject({ transitionId: cut.id, state: 'running', hooksAttempted: 0 });
      expect(did).toEqual([]);
    });

    it('finishing one that has ended meanwhile runs nothing and leaves it as it ended', async () => {
      const cut = await cutOff('suspended');
      await db().update(tenantLifecycleTransitions).set({ state: 'failed_partial' }).where(eq(tenantLifecycleTransitions.id, cut.id));
      const res = await runTransition(db(), k8s, { tenantId: cut.tenantId, namespace: cut.namespace, transition: 'suspended', toStatus: 'suspended', resumeTransitionId: cut.id });
      expect(res).toMatchObject({ state: 'failed_partial', hooksAttempted: 0 });
      expect(did).toEqual([]);
      expect((await hookStates(cut.id)).ingress).toBe('running');
    });
  });

  describe('which transitions are taken for interrupted', () => {
    it.each(KINDS)('a %s transition that says running and whose lock lapsed more than the grace ago', async (kind) => {
      const cut = await cutOff(kind);
      expect(await findInterruptedTransitions(db())).toEqual([{
        id: cut.id, tenantId: cut.tenantId, kind, toStatus: kind === 'restored' ? 'active' : kind, triggeredByUserId: null,
        namespace: cut.namespace, unlocked: false, tenantExists: true, superseded: false, tooOld: false, resumes: 0,
        hardDelete: kind === 'deleted', ownerFailed: false,
      }]);
    });

    it.each<[string, number]>([
      ['its lock is held', 90],
      ['its lock lapsed only a moment ago — a holder late renewing is not a dead one', -10],
    ])('not one when %s', async (_why, seconds) => {
      await cutOff('suspended', { lock: seconds });
      expect(await found()).toEqual([]);
    });

    it('one with no lock at all, minutes after it began — an older release wrote none', async () => {
      const cut = await cutOff('suspended', { lock: null, minutesOld: 10 });
      expect(await findInterruptedTransitions(db())).toMatchObject([{ id: cut.id, unlocked: true }]);
    });

    it('not one with no lock that began a moment ago', async () => {
      await cutOff('suspended', { lock: null, minutesOld: 1 });
      expect(await found()).toEqual([]);
    });

    it.each(['completed', 'failed_partial', 'failed_blocking'] as const)('not one that ended %s', async (state) => {
      const cut = await cutOff('suspended');
      await db().update(tenantLifecycleTransitions).set({ state }).where(eq(tenantLifecycleTransitions.id, cut.id));
      expect(await found()).toEqual([]);
    });

    it('not one whose tenant a storage operation in flight owns: that operation finishes its own cascades', async () => {
      const cut = await cutOff('archived');
      await owning(cut.tenantId, 'quiescing');
      expect(await found()).toEqual([]);
    });

    it.each(['failed', 'idle'] as const)('one whose tenant still points at an operation that has %s', async (state) => {
      const cut = await cutOff('archived');
      await owning(cut.tenantId, state);
      expect(await findInterruptedTransitions(db())).toMatchObject([{ id: cut.id, ownerFailed: state === 'failed' }]);
    });

    it.each<[string, Parameters<typeof owning>[2], boolean]>([
      ['began inside an operation that has since failed', { minutesAgo: 45 }, true],
      ['began after the failed operation had ended', { minutesAgo: 120, endedMinutesAgo: 60 }, false],
      ['began before the failed operation did', { minutesAgo: 10 }, false],
    ])('knows whether it %s', async (_what, timing, ownerFailed) => {
      const cut = await cutOff('archived');
      await owning(cut.tenantId, 'failed', timing);
      expect(await findInterruptedTransitions(db())).toMatchObject([{ id: cut.id, ownerFailed }]);
    });

    it.each<[string, { toStatus?: string; detail?: Record<string, unknown> }, boolean]>([
      ['a delete of the tenant', {}, true],
      ['a decommission, which keeps the tenant', { toStatus: 'suspended', detail: { preservedTenant: true, source: 'decommission-orchestrator' } }, false],
      ['a delete that says it keeps the tenant', { detail: { preservedTenant: true } }, false],
      ['a delete that does not end in the status deleted', { toStatus: 'suspended' }, false],
    ])('tells %s from the others', async (_what, shape, hardDelete) => {
      const cut = await cutOff('deleted', shape);
      expect(await findInterruptedTransitions(db())).toMatchObject([{ id: cut.id, kind: 'deleted', hardDelete }]);
    });

    it('says so when the tenant has been through a later transition, when it is too old, when its tenant is gone, and how often it was picked up', async () => {
      const later = await cutOff('suspended');
      await runTransition(db(), k8s, { tenantId: later.tenantId, namespace: later.namespace, transition: 'active', toStatus: 'active' });
      const old = await cutOff('suspended', { minutesOld: 7 * 60 });
      const gone = await cutOff('deleted', { tenantId: crypto.randomUUID(), namespace: 'tenant-gone', detail: { resumes: 2 } });
      const all = Object.fromEntries((await findInterruptedTransitions(db())).map((t) => [t.id, t]));
      expect(all[later.id]).toMatchObject({ superseded: true, tooOld: false, tenantExists: true, resumes: 0 });
      expect(all[old.id]).toMatchObject({ superseded: false, tooOld: true });
      expect(all[gone.id]).toMatchObject({ tenantExists: false, namespace: 'tenant-gone', resumes: 2 });
    });
  });

  describe('why one is closed instead of finished', () => {
    const base = { id: 't', tenantId: 'x', kind: 'suspended' as Transition, toStatus: 'suspended', triggeredByUserId: null, namespace: 'ns', unlocked: false, tenantExists: true, superseded: false, tooOld: false, resumes: 0, hardDelete: false, ownerFailed: false };
    const aDelete = { ...base, kind: 'deleted' as Transition, toStatus: 'deleted', hardDelete: true };

    it('one that is the tenant\'s latest, recent, with its tenant there: finished', () => {
      expect(whyNotFinished(base)).toBeNull();
      expect(whyNotFinished({ ...base, resumes: TRANSITION_MAX_RESUMES - 1 })).toBeNull();
    });

    it.each<[string, Partial<typeof base>, string]>([
      ['the tenant has moved on', { superseded: true }, 'later transition'],
      ['it is older than the age rule', { tooOld: true }, 'too long after'],
      ['it was picked up as often as allowed', { resumes: TRANSITION_MAX_RESUMES }, 'more than once'],
      ['no namespace is known for it', { namespace: null }, 'namespace is no longer known'],
      ['its tenant is gone', { tenantExists: false }, 'no longer exists'],
      ['the storage operation it belonged to ended as failed', { ownerFailed: true }, 'has ended as failed'],
      ['it is a decommission\'s — a delete that keeps the tenant', { kind: 'deleted', hardDelete: false }, 'decommission'],
    ])('closed when %s', (_why, over, says) => {
      expect(whyNotFinished({ ...base, ...over })).toContain(says);
    });

    it('a delete of the tenant is finished', () => {
      expect(whyNotFinished(aDelete)).toBeNull();
    });

    // Its hooks still have work: the bundles' expiry is set from rows that
    // outlive the tenant, and the volumes are found by the namespace.
    it('a delete whose tenant is gone is finished all the same: its hooks clean up after the tenant', () => {
      expect(whyNotFinished({ ...aDelete, tenantExists: false })).toBeNull();
    });
  });

  describe('finishing', () => {
    it.each<Transition>(['suspended', 'active', 'archived', 'restored'])('a %s transition: the hook it died in and the ones after are run, the ones before are not run again', async (kind) => {
      const cut = await cutOff(kind);
      expect(await pickUp()).toEqual({ finished: 1, closed: 0, leftAlone: 0 });
      expect(did).toEqual(['ingress', 'tell-tenant']);
      expect(await hookStates(cut.id)).toEqual({ mail: 'ok', 'status-stamp': 'ok', ingress: 'ok', 'tell-tenant': 'ok' });
      const row = await transition(cut.id);
      expect(row).toMatchObject({ state: 'completed', detail: { resumes: 1 } });
      expect(row.completedAt).not.toBeNull();
      expect(await lockRow(transitionLockJob(cut.id))).toBeNull();
      expect(await lockRow(tenantLockJob(cut.tenantId))).toBeNull();
      expect(log).toEqual([`${kind} transition ${cut.id} of tenant ${cut.tenantId} had no live process behind it — its remaining hooks were run`]);
    });

    it('is finished once: the next look finds nothing', async () => {
      await cutOff('suspended');
      await pickUp();
      did.length = 0;
      expect(await pickUp()).toEqual({ finished: 0, closed: 0, leftAlone: 0 });
      expect(did).toEqual([]);
    });

    it('a hook that fails while it is finished leaves the transition failed, as on a first run — and is the retry scheduler\'s from there', async () => {
      const cut = await cutOff('suspended');
      outcome = { ingress: 'retry' };
      expect(await pickUp()).toEqual({ finished: 1, closed: 0, leftAlone: 0 });
      expect(await transition(cut.id)).toMatchObject({ state: 'failed_partial' });
      const ingress = (await hooks(cut.id)).find((h) => h.hookName === 'ingress');
      expect(ingress).toMatchObject({ state: 'failed', attempts: 2 });
      expect(ingress?.nextAttemptAt).not.toBeNull();
    });

    it('keeps the operator\'s "do not tell the tenant"', async () => {
      await cutOff('suspended', { detail: { suppressTenantNotification: true } });
      await pickUp();
      expect(did).toEqual(['ingress (the tenant not told)', 'tell-tenant (the tenant not told)']);
    });

    it('a delete is taken to its end: its remaining hooks, then the namespace, then the tenant\'s row', async () => {
      const cut = await cutOff('deleted', { tenantStatus: 'suspended' });
      expect(await pickUp()).toEqual({ finished: 1, closed: 0, leftAlone: 0 });
      expect(did).toEqual(['ingress', 'tell-tenant', `delete namespace ${cut.namespace}`]);
      expect(await tenantRow(cut.tenantId)).toBeUndefined();
      expect(await transition(cut.id)).toMatchObject({ state: 'completed', detail: { resumes: 1 } });
      expect(await lockRow(tenantLockJob(cut.tenantId))).toBeNull();
    });

    it('a delete cut off after its last hook, before the tenant was dropped, is still found — and taken to its end', async () => {
      const cut = await cutOff('deleted', { hooksDone: true });
      expect(await pickUp()).toEqual({ finished: 1, closed: 0, leftAlone: 0 });
      expect(did).toEqual([`delete namespace ${cut.namespace}`]);    // no hook is run a second time
      expect(await tenantRow(cut.tenantId)).toBeUndefined();
      expect(await transition(cut.id)).toMatchObject({ state: 'completed' });
    });

    it('a delete as it runs: its transition stays running until the tenant is dropped, then ends', async () => {
      const tenant = await seedTenant(db(), regionId, planId);
      const { applyDeleted } = await import('./cascades.js');
      const during: string[] = [];
      const watching = {
        core: {
          ...(k8s.core as unknown as Record<string, unknown>),
          deleteNamespace: async () => {
            const [row] = await db().select().from(tenantLifecycleTransitions).where(eq(tenantLifecycleTransitions.tenantId, tenant.id));
            during.push(`${row.state}, hooks ${Object.values(await hookStates(row.id)).join(',')}`);
          },
        },
      } as unknown as K8sClients;
      const id = await applyDeleted({ db: db(), k8s: watching }, tenant.id, tenant.kubernetesNamespace);
      expect(during).toEqual(['running, hooks ok,ok,ok,ok']);
      expect(await transition(id as string)).toMatchObject({ state: 'completed', toStatus: 'deleted', detail: { tenantName: tenant.name } });
      expect(await tenantRow(tenant.id)).toBeUndefined();
    });

    it('a delete whose drop fails has told its caller so: its transition is ended, and is not the pick-up\'s to try again', async () => {
      const tenant = await seedTenant(db(), regionId, planId);
      const { applyDeleted } = await import('./cascades.js');
      const failing = new Proxy(db(), {
        get: (target, prop, receiver) => (prop === 'delete'
          ? () => { throw new Error('the row could not be dropped'); }
          : Reflect.get(target, prop, receiver)),
      }) as Database;
      await expect(applyDeleted({ db: failing, k8s }, tenant.id, tenant.kubernetesNamespace)).rejects.toThrow('could not be dropped');
      const [row] = await db().select().from(tenantLifecycleTransitions).where(eq(tenantLifecycleTransitions.tenantId, tenant.id));
      expect(row.state).toBe('completed');
      await db().execute(sql`UPDATE tenant_lifecycle_transitions SET started_at = now() - interval '1 hour'`);
      expect(await found()).toEqual([]);
      expect(await tenantRow(tenant.id)).toBeDefined();
    });

    /** The database, with the registry's lock out of reach: every raw statement fails. */
    const registryDown = () => new Proxy(db(), {
      get: (target, prop, receiver) => (prop === 'execute'
        ? async () => { throw new Error('the database did not answer'); }
        : Reflect.get(target, prop, receiver)),
    }) as Database;

    it('a delete being finished goes no further when the registry cannot be reached: nothing is dropped, and it is found again later', async () => {
      const cut = await cutOff('deleted');
      const { applyDeleted } = await import('./cascades.js');
      expect(await applyDeleted({ db: registryDown(), k8s }, cut.tenantId, cut.namespace, cut.id)).toBeNull();
      expect(did).toEqual([]);
      expect(await tenantRow(cut.tenantId)).toBeDefined();
      expect(await found()).toEqual([cut.id]);
    });

    it('a delete as first asked for is not held up by a registry that cannot be reached: the tenant is dropped all the same', async () => {
      const tenant = await seedTenant(db(), regionId, planId);
      const { applyDeleted } = await import('./cascades.js');
      expect(await applyDeleted({ db: registryDown(), k8s }, tenant.id, tenant.kubernetesNamespace)).toBeNull();
      expect(did).toEqual([`delete namespace ${tenant.kubernetesNamespace}`]);
      expect(await tenantRow(tenant.id)).toBeUndefined();
    });

    it('a delete whose tenant is already gone has its remaining hooks run, and nothing deleted twice', async () => {
      const cut = await cutOff('deleted', { tenantId: crypto.randomUUID(), namespace: 'tenant-gone' });
      expect(await pickUp()).toEqual({ finished: 1, closed: 0, leftAlone: 0 });
      expect(did).toEqual(['ingress', 'tell-tenant']);
      expect(await transition(cut.id)).toMatchObject({ state: 'completed' });
    });
  });

  describe('an older release\'s transition, which has no lock', () => {
    const SELF = hostname();

    it('is finished once every API process is this release', async () => {
      const cut = await cutOff('suspended', { lock: null, minutesOld: 10 });
      apiPods = [{ name: SELF, image: 'api:2' }, { name: 'api-b', image: 'api:2' }];
      expect(await pickUp()).toEqual({ finished: 1, closed: 0, leftAlone: 0 });
      expect((await transition(cut.id)).state).toBe('completed');
    });

    it.each<[string, Array<{ name: string; image: string }>]>([
      ['a process of another release is still listed', [{ name: SELF, image: 'api:2' }, { name: 'api-old', image: 'api:1' }]],
      ['it cannot be told', []],
    ])('is left alone while %s', async (_why, pods) => {
      const cut = await cutOff('deleted', { lock: null, minutesOld: 10 });
      apiPods = pods;
      expect(await pickUp()).toEqual({ finished: 0, closed: 0, leftAlone: 1 });
      expect(did).toEqual([]);
      expect((await transition(cut.id)).state).toBe('running');
      expect(await tenantRow(cut.tenantId)).toBeDefined();
      expect(log[0]).toContain('left alone');
    });
  });

  describe('closing', () => {
    const closedWith = async (cut: Cut, says: string) => {
      expect(did).toEqual([]);                                       // nothing is run
      expect(await transition(cut.id)).toMatchObject({ state: 'failed_partial' });
      const rows = await hooks(cut.id);
      expect(rows.map((r) => r.state)).toEqual(['ok', 'ok', 'failed', 'failed']);
      for (const r of rows.slice(2)) {
        expect(r.lastError).toMatchObject({ title: 'Interrupted' });
        expect((r.lastError as { detail: string }).detail).toContain(says);
        expect(r.nextAttemptAt).toBeNull();                          // not the retry scheduler's either
      }
      expect(rows[0].lastError).toBeNull();
    };

    it('a suspend the tenant has since been resumed from is closed: its remaining hooks would half suspend it again', async () => {
      const cut = await cutOff('suspended');
      await runTransition(db(), k8s, { tenantId: cut.tenantId, namespace: cut.namespace, transition: 'active', toStatus: 'active' });
      did.length = 0;
      expect(await pickUp()).toEqual({ finished: 0, closed: 1, leftAlone: 0 });
      await closedWith(cut, 'later transition');
      expect(log[0]).toContain('closed without running its remaining hooks');
    });

    it('one older than the age rule is closed — a delete too, and its tenant is not deleted', async () => {
      const cut = await cutOff('deleted', { minutesOld: 7 * 60 });
      expect(await pickUp()).toEqual({ finished: 0, closed: 1, leftAlone: 0 });
      await closedWith(cut, 'too long after');
      expect(await tenantRow(cut.tenantId)).toBeDefined();
    });

    it('one picked up as often as allowed is closed', async () => {
      const cut = await cutOff('suspended', { detail: { resumes: TRANSITION_MAX_RESUMES } });
      expect(await pickUp()).toEqual({ finished: 0, closed: 1, leftAlone: 0 });
      await closedWith(cut, 'more than once');
    });

    it.each<[string, { toStatus?: string; detail?: Record<string, unknown> }]>([
      ['a decommission\'s', { toStatus: 'suspended', detail: { preservedTenant: true, source: 'decommission-orchestrator' } }],
      ['one of a delete that says it keeps the tenant', { detail: { preservedTenant: true } }],
    ])('%s is closed, and the tenant it keeps is NOT deleted', async (_what, shape) => {
      const cut = await cutOff('deleted', shape);
      expect(await pickUp()).toEqual({ finished: 0, closed: 1, leftAlone: 0 });
      await closedWith(cut, 'decommission');
      expect(await tenantRow(cut.tenantId)).toBeDefined();
    });

    it('an archive\'s, whose operation was since ended as failed, is closed: its hooks would archive the tenant all the same', async () => {
      const cut = await cutOff('archived');
      await owning(cut.tenantId, 'failed');
      expect(await pickUp()).toEqual({ finished: 0, closed: 1, leftAlone: 0 });
      await closedWith(cut, 'has ended as failed');
    });

    it('one of a tenant that no longer exists is closed', async () => {
      const cut = await cutOff('suspended', { tenantId: crypto.randomUUID(), namespace: 'tenant-gone' });
      expect(await pickUp()).toEqual({ finished: 0, closed: 1, leftAlone: 0 });
      await closedWith(cut, 'no longer exists');
    });

    it('is not closed while a process holds its lock, nor when it has ended', async () => {
      const held = await cutOff('suspended', { lock: 90 });
      expect(await closeInterruptedTransition(db(), held.id, 'why')).toBe(false);
      expect((await transition(held.id)).state).toBe('running');
      const done = await cutOff('suspended');
      await db().update(tenantLifecycleTransitions).set({ state: 'completed' }).where(eq(tenantLifecycleTransitions.id, done.id));
      expect(await closeInterruptedTransition(db(), done.id, 'why')).toBe(false);
      expect((await hookStates(done.id)).ingress).toBe('running');
    });
  });

  describe('a transition somebody has after all', () => {
    it('is left alone when the tenant\'s lock is held: something is being started on the tenant', async () => {
      const cut = await cutOff('suspended');
      await lockAt(tenantLockJob(cut.tenantId), 90, 'a-live-request');
      expect(await pickUp()).toEqual({ finished: 0, closed: 0, leftAlone: 1 });
      expect(did).toEqual([]);
      expect(await transition(cut.id)).toMatchObject({ state: 'running', detail: null });
    });

    it('a delete is left alone when the tenant\'s lock is held — at once: the tick does not wait for the tenant', async () => {
      const cut = await cutOff('deleted');
      await lockAt(tenantLockJob(cut.tenantId), 90, 'a-live-request');
      const began = Date.now();
      expect(await pickUp()).toEqual({ finished: 0, closed: 0, leftAlone: 1 });
      expect(Date.now() - began).toBeLessThan(5000);
      expect(did).toEqual([]);
      expect(await tenantRow(cut.tenantId)).toBeDefined();
      expect(log[0]).toContain('could not be finished');
    });

    it.each<Transition>(['suspended', 'deleted'])('a %s transition is left alone when the process that was only slow took its lock back between the look and the finish', async (kind) => {
      const cut = await cutOff(kind);
      const woke = racing(() => lockAt(transitionLockJob(cut.id), 90, 'the-slow-process'));
      expect(await pickUp(woke)).toEqual({ finished: 0, closed: 0, leftAlone: 1 });
      // The hooks are the slow process's — and so are the namespace and the row
      // of a delete: its hooks still read the tenant's rows.
      expect(did).toEqual([]);
      expect((await hookStates(cut.id)).ingress).toBe('running');
      expect(await tenantRow(cut.tenantId)).toBeDefined();
      // Not counted as a pick-up: it was not run.
      expect((await transition(cut.id)).detail).toBeNull();
    });

    it.each<Transition>(['suspended', 'deleted'])('a %s transition that ended between the look and the finish is not touched, and nothing is deleted', async (kind) => {
      const cut = await cutOff(kind);
      const ended = racing(() => db().update(tenantLifecycleTransitions).set({ state: 'failed_blocking', completedAt: new Date() }).where(eq(tenantLifecycleTransitions.id, cut.id)));
      expect(await pickUp(ended)).toEqual({ finished: 0, closed: 0, leftAlone: 1 });
      expect(did).toEqual([]);
      expect(await tenantRow(cut.tenantId)).toBeDefined();
      expect(await transition(cut.id)).toMatchObject({ state: 'failed_blocking', detail: null });
    });

    it('is left alone when a storage operation took the tenant between the look and the finish', async () => {
      const cut = await cutOff('suspended');
      const taken = racing(() => owning(cut.tenantId, 'quiescing'));
      expect(await pickUp(taken)).toEqual({ finished: 0, closed: 0, leftAlone: 1 });
      expect(did).toEqual([]);
    });
  });

  describe('a hook the retry scheduler was running when its process died', () => {
    /** A transition that ended failed, with one hook left saying `running` since `minutes` ago. */
    const retrying = async (minutes: number, over: { attempts?: number; maxAttempts?: number; state?: 'failed_partial' | 'running' } = {}) => {
      const cut = await cutOff('suspended');
      await db().update(tenantLifecycleTransitions).set({ state: over.state ?? 'failed_partial' }).where(eq(tenantLifecycleTransitions.id, cut.id));
      await db().execute(sql`
        UPDATE tenant_lifecycle_hook_runs
           SET attempts = ${over.attempts ?? 2}, max_attempts = ${over.maxAttempts ?? 5}, started_at = now() - make_interval(mins => ${minutes})
         WHERE transition_id = ${cut.id} AND hook_name = 'ingress'`);
      return cut;
    };
    const ingress = async (id: string) => (await hooks(id)).find((h) => h.hookName === 'ingress');

    it('is handed back to it: failed, and due now', async () => {
      const cut = await retrying(40);
      expect(await requeueInterruptedRetries(db())).toBe(1);
      const row = await ingress(cut.id);
      expect(row).toMatchObject({ state: 'failed', attempts: 2, lastError: { title: 'Interrupted' } });
      expect(row?.nextAttemptAt).not.toBeNull();
      expect((await hookStates(cut.id))['tell-tenant']).toBe('pending');   // only the one that was running
    });

    it('is failed for good when it has used its attempts up', async () => {
      const cut = await retrying(40, { attempts: 5, maxAttempts: 5 });
      expect(await requeueInterruptedRetries(db())).toBe(1);
      expect(await ingress(cut.id)).toMatchObject({ state: 'failed', nextAttemptAt: null });
    });

    it.each<[string, Parameters<typeof retrying>]>([
      ['it began a few minutes ago: the scheduler may be running it', [5]],
      ['its transition is itself running: it is the dispatcher\'s', [40, { state: 'running' }]],
    ])('is left as it is when %s', async (_why, args) => {
      const cut = await retrying(...args);
      expect(await requeueInterruptedRetries(db())).toBe(0);
      expect(await ingress(cut.id)).toMatchObject({ state: 'running' });
    });
  });
});
