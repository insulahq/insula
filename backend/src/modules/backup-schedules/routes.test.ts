/**
 * Saving a retention: refused when it would limit nothing, applied at once
 * when it does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../../middleware/auth.js', () => ({
  authenticate: async (req: { user?: unknown }) => { req.user = { sub: 'admin-1', role: 'super_admin' }; },
  requireRole: () => async () => {},
}));

const getSchedule = vi.fn();
const updateSchedule = vi.fn();
vi.mock('./service.js', () => ({
  getSchedule: (...a: unknown[]) => getSchedule(...a),
  updateSchedule: (...a: unknown[]) => updateSchedule(...a),
  listSchedules: vi.fn(),
}));

const applyRetentionNow = vi.fn();
vi.mock('./apply-retention-now.js', () => ({
  applyRetentionNow: (...a: unknown[]) => applyRetentionNow(...a),
}));

const { backupSchedulesRoutes } = await import('./routes.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  getSchedule.mockResolvedValue({ subsystem: 'secrets_bundle', retentionDays: null, retentionCount: 14 });
  updateSchedule.mockImplementation(async (_db, subsystem, patch) => ({ subsystem, ...patch }));
  app = Fastify();
  app.decorate('db', {} as never);
  app.decorate('config', {} as never);
  app.setErrorHandler(errorHandler);
  await app.register(backupSchedulesRoutes, { prefix: '/api/v1' });
  await app.ready();
});
afterEach(async () => { await app.close(); });

const patch = (subsystem: string, body: unknown) => app.inject({
  method: 'PATCH', url: `/api/v1/admin/backups/schedules/${subsystem}`, payload: body as Record<string, unknown>,
});

describe('PATCH /admin/backups/schedules/:subsystem — retention', () => {
  it('refuses a change that leaves no limit, merged with what is stored', async () => {
    // Stored: count 14, no days. Clearing the count leaves nothing.
    const res = await patch('secrets_bundle', { retentionCount: null });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('RETENTION_UNLIMITED');
    expect(updateSchedule).not.toHaveBeenCalled();
    expect(applyRetentionNow).not.toHaveBeenCalled();
  });

  it('treats 0 as no limit too', async () => {
    getSchedule.mockResolvedValue({ subsystem: 'mail', retentionDays: 0, retentionCount: 48 });
    expect((await patch('mail', { retentionCount: 0 })).statusCode).toBe(400);
  });

  it('accepts one limit replacing the other, and applies it at once', async () => {
    const res = await patch('secrets_bundle', { retentionDays: 14, retentionCount: null });
    expect(res.statusCode).toBe(200);
    expect(updateSchedule).toHaveBeenCalledOnce();
    expect(applyRetentionNow).toHaveBeenCalledOnce();
    expect(applyRetentionNow.mock.calls[0][1]).toBe('secrets_bundle');
  });

  it('does not touch retention for a cadence-only save', async () => {
    getSchedule.mockResolvedValue({ subsystem: 'tenant_bundle', retentionDays: null, retentionCount: null });
    const res = await patch('tenant_bundle', { cronExpression: '0 3 * * *' });
    expect(res.statusCode).toBe(200);
    expect(applyRetentionNow).not.toHaveBeenCalled();
  });

  it('applies a tenant-bundle change at once', async () => {
    getSchedule.mockResolvedValue({ subsystem: 'tenant_bundle', retentionDays: 30, retentionCount: null });
    expect((await patch('tenant_bundle', { retentionDays: 14 })).statusCode).toBe(200);
    expect(applyRetentionNow.mock.calls[0][1]).toBe('tenant_bundle');
  });
});
