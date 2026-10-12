import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import type { TenantAutomationStatus } from '@insula/api-contracts';
import { errorHandler } from '../../../middleware/error-handler.js';
import { registerAuth } from '../../../middleware/auth.js';

/**
 * The automation routes as the admin panel reaches them: through the lifecycle
 * plugin's gates, with the real validation. The sweep, the settings store and
 * the run lock are stand-ins — each has its own tests.
 */

const STATUS: TenantAutomationStatus = {
  settings: { autoArchiveEnabled: false, autoArchiveAfterDays: 30, autoDeleteEnabled: false, autoDeleteAfterDays: 90, noticeDays: 7 },
  intervalHours: 6, running: false, lastRun: null, nextRunAt: null, archiveBlockedReason: null, archiveRetentionDays: 90,
  suspended: [], archived: [], kept: [],
};

const getStatus = vi.fn(async () => STATUS);
const sweepOnce = vi.fn(async () => ({}));
const save = vi.fn(async () => STATUS.settings);
const setExempt = vi.fn(async (_db: unknown, tenantId: string, exempt: boolean) => {
  if (tenantId === 'nobody') {
    const { ApiError } = await import('../../../shared/errors.js');
    throw new ApiError('TENANT_NOT_FOUND', 'Tenant nobody not found', 404);
  }
  return { tenantId, name: 'Acme', status: 'suspended', exempt };
});
/** Whether the run lock is free; the stand-in for runExclusive honours it. */
let lockFree = true;
const lockedJobs: string[] = [];

vi.mock('./real.js', () => ({
  getTenantAutomationStatus: (...args: unknown[]) => getStatus(...(args as [])),
  sweepTenantsOnce: (...args: unknown[]) => sweepOnce(...(args as [])),
  setTenantAutomationExempt: (...args: unknown[]) => setExempt(...(args as [unknown, string, boolean])),
  TENANT_AUTOMATION_JOB: 'storage-auto-archive',
  TENANT_AUTOMATION_MAX_HOLD_MS: 1000,
}));
vi.mock('./settings.js', () => ({
  saveTenantAutomationSettings: (...args: unknown[]) => save(...(args as [])),
}));
vi.mock('../../../shared/exclusive-run.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  runExclusive: async (_db: unknown, job: string, fn: () => Promise<unknown>) => {
    lockedJobs.push(job);
    return lockFree ? { ran: true, value: await fn() } : { ran: false };
  },
}));
vi.mock('../../k8s-provisioner/k8s-client.js', () => ({ createK8sClients: () => ({}) }));

const { tenantLifecycleRoutes } = await import('../routes.js');

describe('tenant automation routes', () => {
  let app: FastifyInstance;
  const audit: Array<Record<string, unknown>> = [];
  const token = (role: string, panel = 'admin'): string =>
    app.jwt.sign({ sub: `${role}-1`, role, panel, iat: Math.floor(Date.now() / 1000) });
  const call = (method: 'GET' | 'PATCH' | 'POST' | 'PUT', path: string, role: string | null, payload?: unknown, panel?: string) => app.inject({
    method, url: `/api/v1/admin/lifecycle/automation${path}`,
    ...(role ? { headers: { authorization: `Bearer ${token(role, panel)}` } } : {}),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', {
      insert: () => ({ values: async (row: Record<string, unknown>) => { audit.push(row); } }),
    } as never);
    app.decorate('config', {} as never);
    await app.register(tenantLifecycleRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    getStatus.mockClear(); sweepOnce.mockClear(); save.mockClear(); setExempt.mockClear();
    audit.length = 0; lockedJobs.length = 0; lockFree = true;
  });

  it.each([
    ['GET', ''], ['PATCH', ''], ['POST', '/run'], ['PUT', '/tenants/t-1'],
  ] as const)('%s %s is for a signed-in admin or super admin of the admin panel only', async (method, path) => {
    const body = method === 'PATCH' ? { autoArchiveEnabled: true } : method === 'PUT' ? { exempt: true } : undefined;
    expect((await call(method, path, null, body)).statusCode).toBe(401);
    for (const role of ['support', 'billing', 'read_only']) {
      expect((await call(method, path, role, body)).statusCode, role).toBe(403);
    }
    expect((await call(method, path, 'tenant_admin', body, 'tenant')).statusCode).toBe(403);
    expect(save).not.toHaveBeenCalled();
    expect(sweepOnce).not.toHaveBeenCalled();
    expect(setExempt).not.toHaveBeenCalled();
    for (const role of ['admin', 'super_admin']) {
      expect((await call(method, path, role, body)).statusCode, role).toBeLessThan(300);
    }
  });

  it('GET answers the status in the usual envelope', async () => {
    const res = await call('GET', '', 'admin');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual(STATUS);
  });

  it('PATCH saves exactly what was sent, records who changed what, and answers the stored settings', async () => {
    const stored = { ...STATUS.settings, autoDeleteEnabled: true, autoDeleteAfterDays: 60 };
    save.mockResolvedValueOnce(stored);
    const res = await call('PATCH', '', 'super_admin', { autoDeleteEnabled: true, autoDeleteAfterDays: 60 });
    expect(res.statusCode).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][1]).toEqual({ autoDeleteEnabled: true, autoDeleteAfterDays: 60 });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actionType: 'tenant_lifecycle_automation.update',
      actorId: 'super_admin-1',
      httpMethod: 'PATCH',
      changes: { autoDeleteEnabled: true, autoDeleteAfterDays: 60 },
    });
    expect(res.json().data).toEqual({ settings: stored });
  });

  it('a save that happened is answered as one, even when the status cannot be read just then', async () => {
    getStatus.mockRejectedValue(new Error('the cluster did not answer'));
    try {
      const res = await call('PATCH', '', 'admin', { autoArchiveAfterDays: 14 });
      expect(res.statusCode).toBe(200);
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      getStatus.mockReset();
      getStatus.mockImplementation(async () => STATUS);
    }
  });

  it.each([
    [{ autoArchiveAfterDays: 0 }, 'autoArchiveAfterDays'],
    [{ autoDeleteAfterDays: 3651 }, 'autoDeleteAfterDays'],
    [{ autoArchiveAfterDays: '30' }, 'autoArchiveAfterDays'],
    [{ autoArchiveEnabled: 'yes' }, 'autoArchiveEnabled'],
  ])('PATCH refuses %j with the field named, and saves nothing', async (body, field) => {
    const res = await call('PATCH', '', 'admin', body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'VALIDATION_ERROR', details: { field } });
    expect(save).not.toHaveBeenCalled();
    expect(audit).toEqual([]);
  });

  it('PATCH refuses a field it does not know instead of dropping it, and an empty body', async () => {
    // A dropped field would turn `{ autoDeleteEnabled: true, typo: … }` into a
    // save the sender did not fully mean.
    const unknown = await call('PATCH', '', 'admin', { autoArchiveEnabled: true, autoPurgeEnabled: true });
    expect(unknown.statusCode).toBe(400);
    const empty = await call('PATCH', '', 'admin', {});
    expect(empty.statusCode).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('POST /run starts a sweep under the job\'s run lock and answers 202 without waiting for it', async () => {
    let finish: () => void = () => {};
    sweepOnce.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({}); }));
    const res = await call('POST', '/run', 'admin');
    expect(res.statusCode).toBe(202);
    expect(res.json().data).toEqual({ started: true });
    expect(lockedJobs).toEqual(['storage-auto-archive']);
    expect(sweepOnce).toHaveBeenCalledTimes(1);
    expect(sweepOnce.mock.calls[0][1]).toBe('manual');
    // A sweep archives and deletes: who started this one is on record.
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actionType: 'tenant_lifecycle_automation.run', actorId: 'admin-1', httpMethod: 'POST', httpStatus: 202 });
    finish();
  });

  it('POST /run while a sweep is under way: 409, nothing started, and the words to show for it', async () => {
    lockFree = false;
    const res = await call('POST', '/run', 'admin');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'JOB_ALREADY_RUNNING',
      details: { job: 'storage-auto-archive', operatorError: { title: 'Already running' } },
    });
    expect(sweepOnce).not.toHaveBeenCalled();
    expect(audit).toEqual([]);          // nothing was started, so nothing to record
  });

  it('a sweep that fails after the answer was sent is logged, not thrown at nobody', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      sweepOnce.mockRejectedValueOnce(new Error('database went away'));
      expect((await call('POST', '/run', 'admin')).statusCode).toBe(202);
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      expect(errors).toHaveBeenCalledWith('[tenant-automation] sweep failed:', 'database went away');
    } finally {
      errors.mockRestore();
    }
  });

  // ── keeping one tenant out ────────────────────────────────────────────────

  it('PUT …/tenants/:id keeps a tenant out, answers it as stored, and records who did it against that tenant', async () => {
    const res = await call('PUT', '/tenants/t-1', 'admin', { exempt: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ tenantId: 't-1', name: 'Acme', status: 'suspended', exempt: true });
    expect(setExempt).toHaveBeenCalledWith(expect.anything(), 't-1', true);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actionType: 'tenant_lifecycle_automation.exempt',
      tenantId: 't-1',
      resourceType: 'tenant',
      resourceId: 't-1',
      actorId: 'admin-1',
      httpMethod: 'PUT',
      changes: { exempt: true },
    });
  });

  it('PUT …/tenants/:id puts a tenant back with exempt: false', async () => {
    const res = await call('PUT', '/tenants/t-1', 'super_admin', { exempt: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.exempt).toBe(false);
    expect(setExempt).toHaveBeenCalledWith(expect.anything(), 't-1', false);
  });

  it.each([
    ['no body', undefined],
    ['an empty body', {}],
    ['a word for the flag', { exempt: 'yes' }],
    ['a field it does not know', { exempt: true, until: '2027-01-01' }],
  ])('PUT …/tenants/:id refuses %s and changes nothing', async (_what, body) => {
    const res = await call('PUT', '/tenants/t-1', 'admin', body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(setExempt).not.toHaveBeenCalled();
    expect(audit).toEqual([]);
  });

  it('PUT …/tenants/:id answers 404 for a tenant that does not exist, and records nothing', async () => {
    const res = await call('PUT', '/tenants/nobody', 'admin', { exempt: true });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TENANT_NOT_FOUND');
    expect(audit).toEqual([]);
  });
});
