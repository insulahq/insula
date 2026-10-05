import { describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../../shared/errors.js';
import { forwardedAuth, taskMintedAuth, TASK_TOKEN_TTL_SECONDS, TASK_TOKEN_VIA } from './task-credential.js';

type UserRow = { id: string; roleName: string; panel: string; status: string };

const USER_ID = '00000000-0000-4000-8000-0000000000ad';

function fakeApp(rows: () => UserRow[]): { app: FastifyInstance; sign: ReturnType<typeof vi.fn> } {
  const sign = vi.fn((payload: Record<string, unknown>) => `signed.${JSON.stringify(payload)}`);
  const chain = { from: () => chain, where: () => chain, limit: async () => rows() };
  const app = { db: { select: () => chain }, jwt: { sign } } as unknown as FastifyInstance;
  return { app, sign };
}

const admin = (over: Partial<UserRow> = {}): UserRow => ({
  id: USER_ID, roleName: 'super_admin', panel: 'admin', status: 'active', ...over,
});

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try { await p; } catch (err) { return err as ApiError; }
  throw new Error('expected a rejection');
}

describe('taskMintedAuth', () => {
  it('mints a fresh short-lived token for an active admin on every call', async () => {
    const { app, sign } = fakeApp(() => [admin()]);
    const auth = taskMintedAuth(app, USER_ID);
    const first = await auth();
    const second = await auth();

    expect(first.startsWith('Bearer ')).toBe(true);
    expect(sign).toHaveBeenCalledTimes(2);
    const payload = sign.mock.calls[0][0] as Record<string, number | string>;
    expect(payload.sub).toBe(USER_ID);
    expect(payload.panel).toBe('admin');
    expect(payload.via).toBe(TASK_TOKEN_VIA);
    expect(Number(payload.exp) - Number(payload.iat)).toBeLessThanOrEqual(TASK_TOKEN_TTL_SECONDS);
    expect(sign.mock.calls[0][0].jti).not.toBe(sign.mock.calls[1][0].jti);
  });

  it.each([
    ['disabled', admin({ status: 'disabled' }), /account is disabled/],
    ['demoted to read_only', admin({ roleName: 'read_only' }), /role is now read_only/],
    ['moved to the tenant panel', admin({ panel: 'tenant', roleName: 'tenant_admin' }), /role is now tenant_admin/],
  ])('stops the run when the initiator was %s', async (_label, row, reason) => {
    const { app, sign } = fakeApp(() => [row]);
    const err = await rejection(taskMintedAuth(app, USER_ID)());
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('DR_INITIATOR_NO_ACCESS');
    expect(err.status).toBe(403);
    expect(err.message).toMatch(reason);
    expect(sign).not.toHaveBeenCalled();
  });

  it('stops the run when the initiator no longer exists', async () => {
    const { app, sign } = fakeApp(() => []);
    const err = await rejection(taskMintedAuth(app, USER_ID)());
    expect(err.code).toBe('DR_INITIATOR_NO_ACCESS');
    expect(err.message).toMatch(/no longer exists/);
    expect(sign).not.toHaveBeenCalled();
  });

  it('re-checks live: a demotion between two steps stops the second one', async () => {
    let row = admin();
    const { app } = fakeApp(() => [row]);
    const auth = taskMintedAuth(app, USER_ID);
    await expect(auth()).resolves.toMatch(/^Bearer /);
    row = admin({ roleName: 'support' });
    const err = await rejection(auth());
    expect(err.code).toBe('DR_INITIATOR_NO_ACCESS');
  });
});

describe('forwardedAuth', () => {
  it('returns the caller header unchanged (synchronous route only)', async () => {
    await expect(forwardedAuth('Bearer abc')()).resolves.toBe('Bearer abc');
  });
});
