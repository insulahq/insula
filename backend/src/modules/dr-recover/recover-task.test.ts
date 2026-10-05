/**
 * `POST /admin/dr/tenants/:tenantId/recover` with `background: true` — the
 * recovery runs as a `dr.recover` task-center task instead of holding the
 * request open.
 *
 * What matters to the operator, and what these pin:
 *  - the call answers at once with the task id, and the task opens the
 *    `dr-recover` progress modal from the chip;
 *  - every phase lands on the task as a step, so the modal shows where it is
 *    (and where it stopped);
 *  - the terminal result — the same one the synchronous call returns — is on
 *    the task, so the modal can show it after the page that started it is gone;
 *  - a failure is an OperatorError naming the step, never a raw upstream error;
 *  - the provision/restore-cart rows the driven routes enroll are folded under
 *    the recovery, so the chip shows one operation, not three.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import type { DrRecoverStep, OperatorError } from '@insula/api-contracts';
import { errorHandler } from '../../middleware/error-handler.js';
import { authenticate, requirePanel, requireRole } from '../../middleware/auth.js';
import {
  tenants, backupJobs, backupComponents, tenantLifecycleTransitions, restoreJobs, restoreItems, users, tasks,
} from '../../db/schema.js';

vi.mock('../tasks/service.js', () => ({
  start: vi.fn(async () => ({ id: 'task-1', idempotent: false })),
  progress: vi.fn(async () => undefined),
  finish: vi.fn(async () => undefined),
  adoptChildByRef: vi.fn(async () => true),
  hasActiveTask: vi.fn(async () => false),
  failStaleActive: vi.fn(async () => []),
  // The lock itself is Postgres's job (exclusive.integration.test.ts); here
  // the callback runs against the same mock.
  withTaskLock: vi.fn(async (db: unknown, _key: string, fn: (tx: unknown) => Promise<unknown>) => fn(db)),
}));
vi.mock('./recreate.js', () => ({ recreateTenantFromBundle: vi.fn() }));
vi.mock('./reconcile.js', () => ({ reconcileRecoveredTenant: vi.fn() }));

const taskService = await import('../tasks/service.js');
const { recreateTenantFromBundle } = await import('./recreate.js');
const { drRecoverRoutes } = await import('./routes.js');

const JWT_SECRET = 'test-jwt-secret-for-dr-recover-task';
type Row = Record<string, unknown>;

/** The admin who starts the recovery, as the users table holds them — tests mutate it mid-run. */
let initiator: Row | null = null;

interface DbOpts {
  readonly tenantPresent?: boolean;
  readonly cartLastError?: string | null;
  readonly newestBundleRows?: Row[];
  /** restore_jobs of the tenant still `executing`. */
  readonly executingCarts?: Row[];
  /** The dr.recover task that owns such a cart, if any. */
  readonly cartOwner?: Row[];
}

/** Drizzle-shaped mock routed by the TABLE a query reads. */
function makeDb(opts: DbOpts) {
  const rowsFor = (table: unknown, cols: Record<string, unknown> | undefined): Row[] => {
    const keys = Object.keys(cols ?? {});
    if (table === users) return initiator ? [initiator] : [];
    if (table === tasks) return opts.cartOwner ?? [];
    if (table === tenants) {
      if (opts.tenantPresent === false) return [];
      if (keys.length === 1 && keys[0] === 'name') return [{ name: 'Acme' }];
      if (keys.length === 1 && keys[0] === 'id') return [{ id: 't-1' }];
      return [{ id: 't-1', name: 'Acme', status: 'active', provisioningStatus: 'provisioned' }];
    }
    if (table === tenantLifecycleTransitions) {
      return [{ detail: { tenantName: 'Gone Co' }, namespace: 'tenant-example-0a1b2c3d' }];
    }
    if (table === backupJobs) {
      return [{ id: 'bundle-9', tenantId: 't-1', status: 'completed', createdAt: new Date('2026-01-02T03:04:00Z') }];
    }
    if (table === backupComponents) {
      return [{ component: 'config', status: 'completed' }, { component: 'files', status: 'completed' }];
    }
    if (table === restoreJobs) {
      if (keys.includes('startedAt')) return opts.executingCarts ?? [];
      return [{ lastError: opts.cartLastError ?? null }];
    }
    if (table === restoreItems) return [];
    return [];
  };
  const builder = (cols?: Record<string, unknown>) => {
    let table: unknown = null;
    const b: Record<string, unknown> = { from: (t: unknown) => { table = t; return b; } };
    for (const k of ['where', 'orderBy', 'limit', 'innerJoin']) b[k] = () => b;
    b.then = (resolve: (r: Row[]) => void) => resolve(rowsFor(table, cols));
    return b;
  };
  const writer = () => {
    const w: Record<string, unknown> = {};
    for (const k of ['set', 'where']) w[k] = () => w;
    w.then = (resolve: (r: unknown) => void) => resolve(undefined);
    return w;
  };
  return {
    select: (cols?: Record<string, unknown>) => builder(cols),
    update: () => writer(),
    execute: async () => ({ rows: opts.newestBundleRows ?? [{ id: 'bundle-9' }] }),
  };
}

interface StubOptions {
  readonly provisionStatus?: string;
  readonly execStatus?: string;
  /** Status code the cart-create stub answers with (default 201). */
  readonly cartStatusCode?: number;
  /** Runs inside the provision POST — to change the world mid-recovery. */
  readonly onProvision?: () => void;
}

interface SeenCall {
  readonly route: string;
  readonly authorization: string;
  readonly claims: Record<string, unknown>;
}

async function setupApp(dbOpts: DbOpts = {}, stub: StubOptions = {}) {
  const logs: string[] = [];
  const app = Fastify({ logger: { level: 'trace', stream: { write: (line: string) => { logs.push(line); } } } });
  app.setErrorHandler(errorHandler);
  await app.register(fastifyJwt, { secret: JWT_SECRET });
  app.decorate('db', makeDb(dbOpts) as unknown);
  app.decorate('config', { KUBECONFIG_PATH: undefined });
  const injected: string[] = [];
  const seen: SeenCall[] = [];
  await app.register(drRecoverRoutes, { prefix: '/api/v1' });
  // The driven routes behind the SAME guards the real ones have: a token that
  // is expired, mis-signed or lacks the role is refused here, exactly as there.
  await app.register(async (a: FastifyInstance) => {
    a.addHook('onRequest', authenticate);
    a.addHook('onRequest', requirePanel('admin'));
    a.addHook('onRequest', requireRole('super_admin', 'admin'));
    a.addHook('preHandler', async (req) => {
      injected.push(`${req.method} ${req.url}`);
      seen.push({
        route: `${req.method} ${req.url}`,
        authorization: String(req.headers.authorization),
        claims: req.user as unknown as Record<string, unknown>,
      });
    });
    a.post('/admin/tenants/:tenantId/provision', async (_req, reply) => {
      stub.onProvision?.();
      reply.status(202).send({ data: { taskId: 'prov-task-1', status: 'pending' } });
    });
    a.get('/admin/tenants/:tenantId/provision/status', async (_req, reply) => {
      reply.status(200).send({ data: { status: stub.provisionStatus ?? 'completed' } });
    });
    a.post('/admin/restores/carts', async (_req, reply) => {
      const code = stub.cartStatusCode ?? 201;
      if (code === 401) return reply.status(401).send({ error: { code: 'INVALID_TOKEN', message: 'Token is invalid or expired' } });
      reply.status(code).send({ data: { id: 'rstr-cart-1' } });
    });
    a.post('/admin/restores/carts/:id/items', async (_req, reply) => {
      reply.status(201).send({ data: { id: 'item-x' } });
    });
    a.post('/admin/restores/carts/:id/execute', async (_req, reply) => {
      reply.status(200).send({ data: { id: 'rstr-cart-1', status: stub.execStatus ?? 'done', items: [] } });
    });
  }, { prefix: '/api/v1' });
  await app.ready();
  const operatorToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin' });
  const recover = (body: Record<string, unknown>, tenantId = 't-1', token = operatorToken) => app.inject({
    method: 'POST',
    url: `/api/v1/admin/dr/tenants/${tenantId}/recover`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
  return { app, injected, recover, seen, logs, operatorToken };
}

interface FinishArgs {
  readonly status: string;
  readonly error?: string | null;
  readonly detailsPatch?: { steps?: DrRecoverStep[]; result?: Record<string, unknown> | null; error?: OperatorError | null };
}

async function finished(): Promise<FinishArgs> {
  await vi.waitFor(() => expect(vi.mocked(taskService.finish)).toHaveBeenCalled());
  return vi.mocked(taskService.finish).mock.calls[0]![2] as FinishArgs;
}

const stateOf = (steps: DrRecoverStep[] | undefined) =>
  Object.fromEntries((steps ?? []).map((s) => [s.key, s.state]));

beforeEach(() => {
  vi.mocked(taskService.start).mockClear();
  vi.mocked(taskService.progress).mockClear();
  vi.mocked(taskService.finish).mockClear();
  vi.mocked(taskService.adoptChildByRef).mockClear();
  vi.mocked(taskService.hasActiveTask).mockReset().mockResolvedValue(false);
  vi.mocked(taskService.failStaleActive).mockClear();
  vi.mocked(taskService.withTaskLock).mockClear();
  vi.mocked(recreateTenantFromBundle).mockReset();
  initiator = { id: 'admin-1', roleName: 'super_admin', panel: 'admin', status: 'active' };
});

describe('background recovery — starting it', () => {
  it('answers at once with the task, which opens the dr-recover modal', async () => {
    const { recover } = await setupApp();
    const res = await recover({ background: true });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).data).toEqual({ taskId: 'task-1', tenantId: 't-1' });

    const args = vi.mocked(taskService.start).mock.calls[0]![1];
    expect(args.kind).toBe('dr.recover');
    expect(args.scope).toBe('admin');
    expect(args.userId).toBe('admin-1');
    expect(args.tenantId).toBe('t-1');
    expect(args.label).toBe('Recover tenant Acme');
    expect(args.target).toEqual({ type: 'modal', modal: 'dr-recover', modalProps: { tenantId: 't-1' } });
    const details = args.details as { steps: DrRecoverStep[]; result: unknown; error: unknown };
    expect(details.steps.map((s) => s.key)).toEqual(['recreate', 'bundle', 'provision', 'queue', 'restore', 'reconcile']);
    expect(details.steps.every((s) => s.state === 'pending')).toBe(true);
    expect(details.result).toBeNull();
    await finished();
  });

  it('names a deleted tenant by the name it was deleted under', async () => {
    vi.mocked(recreateTenantFromBundle).mockResolvedValue({ residualGaps: [] });
    const { recover } = await setupApp({ tenantPresent: false });
    const res = await recover({ background: true }, 'gone-1');
    expect(res.statusCode).toBe(202);
    expect(vi.mocked(taskService.start).mock.calls[0]![1].label).toBe('Recover tenant Gone Co');
    await finished();
  });

  it('refuses a second recovery of a tenant already being recovered — and starts nothing', async () => {
    vi.mocked(taskService.hasActiveTask).mockResolvedValue(true);
    const { recover, injected } = await setupApp();
    const res = await recover({ background: true });
    expect(res.statusCode).toBe(409);
    const err = JSON.parse(res.body).error;
    expect(err.code).toBe('DR_RECOVER_IN_PROGRESS');
    expect(err.details.operatorError.title).toBe('Already being recovered');
    expect(taskService.start).not.toHaveBeenCalled();
    expect(injected).toEqual([]);
  });

  it('enrolls under the tenant\'s DB lock, after failing runs that stopped heartbeating', async () => {
    const { recover } = await setupApp();
    await recover({ background: true });
    expect(vi.mocked(taskService.withTaskLock).mock.calls[0]![1]).toBe('dr.recover:t-1');
    const [, kind, args] = vi.mocked(taskService.failStaleActive).mock.calls[0]!;
    expect(kind).toBe('dr.recover');
    expect(args).toMatchObject({ tenantId: 't-1', staleSeconds: 180 });
    expect(args.error).toMatch(/restarted/);
    // reap → check → insert, in that order.
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0]!;
    expect(order(vi.mocked(taskService.failStaleActive))).toBeLessThan(order(vi.mocked(taskService.hasActiveTask)));
    expect(order(vi.mocked(taskService.hasActiveTask))).toBeLessThan(order(vi.mocked(taskService.start)));
    await finished();
  });

  it('refuses while a restore of the tenant is still executing — no second restore stacked on it', async () => {
    const { recover, injected } = await setupApp({
      executingCarts: [{ id: 'rstr-old', startedAt: new Date('2026-01-02T03:04:00Z') }],
      cartOwner: [], // a cart no recovery of ours owns — its executor may be alive
    });
    const res = await recover({ background: true });
    expect(res.statusCode).toBe(409);
    const err = JSON.parse(res.body).error;
    expect(err.code).toBe('DR_RESTORE_IN_PROGRESS');
    expect(err.details.operatorError.detail).toContain('rstr-old');
    expect(taskService.start).not.toHaveBeenCalled();
    expect(injected).toEqual([]);
  });

  it('a restore left executing by a recovery that already ended is failed, and the start refused once to say so', async () => {
    const { recover } = await setupApp({
      executingCarts: [{ id: 'rstr-old', startedAt: new Date('2026-01-02T03:04:00Z') }],
      cartOwner: [{ status: 'failed' }],
    });
    const res = await recover({ background: true });
    expect(res.statusCode).toBe(409);
    const err = JSON.parse(res.body).error;
    expect(err.code).toBe('DR_PREVIOUS_RECOVERY_INCOMPLETE');
    expect(err.details.operatorError.remediation.join(' ')).toMatch(/Start the recovery again/);
    expect(taskService.start).not.toHaveBeenCalled();
  });

  it('refuses an unknown tenant with nothing to re-create it from, before any task exists', async () => {
    const { recover } = await setupApp({ tenantPresent: false, newestBundleRows: [] });
    const res = await recover({ background: true }, 'never-had-it');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('TENANT_NOT_FOUND');
    expect(taskService.start).not.toHaveBeenCalled();
  });

  it('the synchronous call is unchanged — no task, terminal result in the response', async () => {
    const { recover } = await setupApp();
    const res = await recover({});
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).data).toMatchObject({ cartId: 'rstr-cart-1', status: 'done' });
    expect(taskService.start).not.toHaveBeenCalled();
  });
});

describe('background recovery — the run on its task', () => {
  it('reports every phase as a step and finishes with the full result', async () => {
    const { recover, injected } = await setupApp();
    await recover({ background: true });
    const fin = await finished();

    expect(fin.status).toBe('succeeded');
    expect(fin.detailsPatch?.error).toBeNull();
    expect(fin.detailsPatch?.result).toMatchObject({
      cartId: 'rstr-cart-1', bundleId: 'bundle-9', status: 'done', components: ['config', 'files'], recreated: false,
    });
    expect(stateOf(fin.detailsPatch?.steps)).toEqual({
      recreate: 'skipped', bundle: 'done', provision: 'done', queue: 'done', restore: 'done', reconcile: 'skipped',
    });
    const bundleStep = fin.detailsPatch!.steps!.find((s) => s.key === 'bundle')!;
    expect(bundleStep.note).toBe('Taken 2026-01-02 03:04 UTC · config, files');
    // It really drove the restore, through the same routes as ever.
    expect(injected).toContain('POST /api/v1/admin/restores/carts/rstr-cart-1/execute');

    // The modal can follow the cart's items as soon as the cart exists.
    const patches = vi.mocked(taskService.progress).mock.calls.map((c) => c[2].detailsPatch ?? {});
    expect(patches).toContainEqual({ cartId: 'rstr-cart-1' });
    expect(patches).toContainEqual({ bundleId: 'bundle-9' });
    const texts = vi.mocked(taskService.progress).mock.calls.map((c) => c[2].text).filter(Boolean);
    expect(texts).toContain('Step 2 of 6 — Check the bundle');
    expect(texts).toContain('Step 5 of 6 — Restore the data');
  });

  it('folds the provision and restore-cart rows under the recovery', async () => {
    const { recover } = await setupApp();
    await recover({ background: true });
    await finished();
    const adopted = vi.mocked(taskService.adoptChildByRef).mock.calls.map((c) => [c[1], c[2], c[3]]);
    expect(adopted).toContainEqual(['tenant.provision', 'prov-task-1', 'task-1']);
    expect(adopted).toContainEqual(['restore.cart', 'rstr-cart-1', 'task-1']);
  });

  it('a failed step is an OperatorError naming the step, and the later steps never ran', async () => {
    const { recover, injected } = await setupApp({}, { provisionStatus: 'failed' });
    await recover({ background: true });
    const fin = await finished();

    expect(fin.status).toBe('failed');
    const error = fin.detailsPatch!.error!;
    expect(error.code).toBe('DR_PROVISION_FAILED');
    expect(error.title).toBe('Recovery failed at “Provision the namespace and storage”');
    expect(error.remediation[0]).toContain('resolve the failed step');
    expect(fin.error).toContain('Provision the namespace and storage');
    expect(stateOf(fin.detailsPatch?.steps)).toMatchObject({
      bundle: 'done', provision: 'failed', queue: 'pending', restore: 'pending',
    });
    expect(injected.some((c) => c.includes('/restores/carts'))).toBe(false);
  });

  it('a restore that stops at a failed item fails the task, with the cart error and the result', async () => {
    const { recover } = await setupApp({ cartLastError: 'item i-1 (files-paths): EXECUTOR_FAILED: restore item failed (see server logs)' }, { execStatus: 'failed' });
    await recover({ background: true });
    const fin = await finished();

    expect(fin.status).toBe('failed');
    expect(fin.detailsPatch!.error!.code).toBe('DR_RESTORE_FAILED');
    expect(fin.detailsPatch!.error!.detail).toContain('EXECUTOR_FAILED');
    expect(fin.detailsPatch!.result).toMatchObject({ status: 'failed', cartId: 'rstr-cart-1' });
    expect(stateOf(fin.detailsPatch?.steps)).toMatchObject({ restore: 'failed', reconcile: 'skipped' });
  });

  it('never shows the operator a raw unexpected error', async () => {
    vi.mocked(recreateTenantFromBundle).mockRejectedValue(new Error('open s3://private-bucket/tenant-x: connection refused'));
    const { recover } = await setupApp({ tenantPresent: false });
    await recover({ background: true }, 'gone-1');
    const fin = await finished();

    expect(fin.status).toBe('failed');
    const error = fin.detailsPatch!.error!;
    expect(error.code).toBe('DR_RECOVER_FAILED');
    expect(error.title).toBe('Recovery failed at “Re-create the deleted tenant from its bundle”');
    expect(JSON.stringify(error)).not.toContain('private-bucket');
    expect(fin.error).not.toContain('private-bucket');
    expect(stateOf(fin.detailsPatch?.steps)).toMatchObject({ recreate: 'failed', bundle: 'pending' });
  });
});

describe('background recovery — the credential its steps carry', () => {
  it('every internal call carries a fresh short-lived token minted for the initiator — never the session token', async () => {
    const { recover, seen, operatorToken } = await setupApp();
    await recover({ background: true });
    await finished();

    expect(seen.length).toBeGreaterThanOrEqual(6); // provision, status, cart, items…, execute
    for (const call of seen) {
      expect(call.authorization).not.toContain(operatorToken);
      expect(call.claims).toMatchObject({ sub: 'admin-1', role: 'super_admin', panel: 'admin', via: 'dr-recover-task' });
      const { iat, exp } = call.claims as { iat: number; exp: number };
      expect(exp - iat).toBeLessThanOrEqual(300);
    }
    // One per call, not one reused for the run.
    expect(new Set(seen.map((c) => c.claims.jti)).size).toBe(seen.length);
  });

  it('a token it minted never lands in the task row or the log', async () => {
    const { recover, seen, logs } = await setupApp();
    await recover({ background: true });
    await finished();
    const tokens = seen.map((c) => c.authorization.replace(/^Bearer /, ''));
    expect(tokens.length).toBeGreaterThan(0);
    const taskWrites = JSON.stringify([
      vi.mocked(taskService.start).mock.calls.map((c) => c[1]),
      vi.mocked(taskService.progress).mock.calls.map((c) => c.slice(1)),
      vi.mocked(taskService.finish).mock.calls.map((c) => c.slice(1)),
    ]);
    const logText = logs.join('\n');
    expect(logText.length).toBeGreaterThan(0);
    for (const t of tokens) {
      expect(taskWrites).not.toContain(t);
      expect(logText).not.toContain(t);
    }
  });

  it.each([
    ['demoted', { roleName: 'read_only' }, 'their role is now read_only'],
    ['disabled', { status: 'disabled' }, 'their account is disabled'],
  ])('an initiator %s mid-run stops the run cleanly at the next step', async (_label, change, reason) => {
    const { recover, injected } = await setupApp({}, {
      // Changed while provisioning runs: the next call (the status poll) re-checks.
      onProvision: () => { initiator = { ...initiator!, ...change }; },
    });
    await recover({ background: true });
    const fin = await finished();

    expect(fin.status).toBe('failed');
    const error = fin.detailsPatch!.error!;
    expect(error.code).toBe('DR_INITIATOR_NO_ACCESS');
    expect(error.title).toBe('The operator who started this recovery no longer has access');
    expect(error.detail).toContain(reason);
    expect(error.remediation[0]).toMatch(/start the recovery again/i);
    expect(stateOf(fin.detailsPatch?.steps)).toMatchObject({ provision: 'failed', queue: 'pending' });
    // Nothing destructive ran on its authority after the change.
    expect(injected.some((c) => c.includes('/restores/carts'))).toBe(false);
  });

  it('an initiator whose account is gone stops the run before its first internal call', async () => {
    const { recover, injected } = await setupApp();
    initiator = null;
    await recover({ background: true });
    const fin = await finished();
    expect(fin.detailsPatch!.error!.code).toBe('DR_INITIATOR_NO_ACCESS');
    expect(fin.detailsPatch!.error!.detail).toContain('no longer exists');
    expect(injected).toEqual([]);
  });

  it('a refused credential is reported as such — not as a failed or timed-out step', async () => {
    const { recover } = await setupApp({}, { cartStatusCode: 401 });
    await recover({ background: true });
    const fin = await finished();
    expect(fin.detailsPatch!.error!.code).toBe('DR_CREDENTIAL_REJECTED');
    expect(fin.detailsPatch!.error!.detail).toContain('creating the restore (HTTP 401');
  });
});

describe('synchronous recovery — a session that runs out mid-run', () => {
  afterEach(() => vi.useRealTimers());

  it('is reported as a refused credential, not as a provisioning timeout', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app, recover } = await setupApp({}, {
      // The operator's 30-minute session expires while provisioning runs.
      onProvision: () => { vi.setSystemTime(Date.now() + 31 * 60_000); },
    });
    const now = Math.floor(Date.now() / 1000);
    const shortSession = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: now, exp: now + 30 * 60 });
    const res = await recover({}, 't-1', shortSession);
    expect(res.statusCode).toBe(502);
    const err = JSON.parse(res.body).error;
    expect(err.code).toBe('DR_CREDENTIAL_REJECTED');
    expect(err.message).toContain('checking the provisioning (HTTP 401');
  });
});
