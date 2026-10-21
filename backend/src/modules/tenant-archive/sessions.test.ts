import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assertTenantOpenForSignIn, endTenantSessions, resetTenantSignInCache, tenantClosedForSignIn } from './sessions.js';
import type { Database } from '../../db/index.js';

/** An archived tenant is closed to every sign-in, and its open sessions end. */

function dbWithStatus(status: string | null) {
  const limit = vi.fn(async () => (status === null ? [] : [{ status }]));
  const db = { select: vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) })) } as unknown as Database;
  return { db, limit };
}

beforeEach(() => resetTenantSignInCache());

describe('tenantClosedForSignIn', () => {
  it('is closed for an archived tenant only — suspended and active sign in', async () => {
    expect(await tenantClosedForSignIn(dbWithStatus('archived').db, 't1')).toBe(true);
    resetTenantSignInCache();
    expect(await tenantClosedForSignIn(dbWithStatus('suspended').db, 't1')).toBe(false);
    resetTenantSignInCache();
    expect(await tenantClosedForSignIn(dbWithStatus('active').db, 't1')).toBe(false);
  });

  it('a tenant that is not there is not "archived"', async () => {
    expect(await tenantClosedForSignIn(dbWithStatus(null).db, 't1')).toBe(false);
  });

  it('asks once per window on the request path; a sign-in reads fresh', async () => {
    const { db, limit } = dbWithStatus('active');
    await tenantClosedForSignIn(db, 't1', { now: 1_000 });
    await tenantClosedForSignIn(db, 't1', { now: 5_000 });
    expect(limit).toHaveBeenCalledTimes(1);
    await tenantClosedForSignIn(db, 't1', { now: 20_000 });
    expect(limit).toHaveBeenCalledTimes(2);
    await tenantClosedForSignIn(db, 't1', { now: 20_001, fresh: true });
    expect(limit).toHaveBeenCalledTimes(3);
  });
});

describe('assertTenantOpenForSignIn', () => {
  it('refuses an archived tenant with TENANT_ARCHIVED, and says so', async () => {
    await expect(assertTenantOpenForSignIn(dbWithStatus('archived').db, 't1'))
      .rejects.toMatchObject({ code: 'TENANT_ARCHIVED', status: 403, message: expect.stringContaining('archived') });
  });

  it('lets a user without a tenant through (an admin)', async () => {
    await expect(assertTenantOpenForSignIn(dbWithStatus('archived').db, null)).resolves.toBeUndefined();
  });
});

describe('endTenantSessions', () => {
  it('revokes the refresh tokens of the tenant\'s users, as tenant_archived', async () => {
    const set = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
    const db = {
      select: vi.fn(() => ({ from: () => ({ where: async () => [{ id: 'u1' }, { id: 'u2' }] }) })),
      update: vi.fn(() => ({ set })),
    } as unknown as Database;
    await endTenantSessions(db, 't1');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ revokedReason: 'tenant_archived', revokedAt: expect.any(Date) }));
  });
});
