/**
 * assertFreshStepUp — the server-side gate in front of routes that hand out
 * key material (a DKIM private key, a certificate bundle). The panel's dialog
 * only saves a round trip; this is what refuses.
 */
import { describe, it, expect } from 'vitest';
import { assertFreshStepUp } from './step-up-service.js';
import { ApiError } from '../../shared/errors.js';

interface UserRow {
  passwordHash: string | null;
  passkeyMode: string | null;
  status: string;
  lastStepUpAt: Date | null;
}

function dbWith(user: UserRow | null) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (user ? [user] : []) }),
      }),
    }),
  } as never;
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function errorOf(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected the gate to refuse');
}

describe('assertFreshStepUp', () => {
  const password = { passwordHash: 'h', passkeyMode: null, status: 'active' };

  it('lets a caller through who stepped up inside the window', async () => {
    await expect(assertFreshStepUp(dbWith({ ...password, lastStepUpAt: minutesAgo(5) }), { sub: 'u1' }, 'dkim_private_key'))
      .resolves.toBeUndefined();
  });

  it('asks for a step-up after sign-in alone, listing the methods', async () => {
    const err = await errorOf(assertFreshStepUp(
      dbWith({ ...password, passkeyMode: 'alternative', lastStepUpAt: null }), { sub: 'u1' }, 'cert_download',
    ));
    expect(err.status).toBe(403);
    expect(err.code).toBe('STEP_UP_REQUIRED');
    expect(err.details).toMatchObject({ purpose: 'cert_download', methods: ['password', 'passkey'] });
  });

  it('asks again once the window has passed', async () => {
    const err = await errorOf(assertFreshStepUp(dbWith({ ...password, lastStepUpAt: minutesAgo(31) }), { sub: 'u1' }, 'cert_download'));
    expect(err.code).toBe('STEP_UP_REQUIRED');
  });

  it('says plainly when the account has nothing to step up with (OIDC-only)', async () => {
    const err = await errorOf(assertFreshStepUp(
      dbWith({ passwordHash: null, passkeyMode: null, status: 'active', lastStepUpAt: null }), { sub: 'u1' }, 'dkim_private_key',
    ));
    expect(err.status).toBe(409);
    expect(err.code).toBe('STEP_UP_UNAVAILABLE');
    expect(err.message).toMatch(/passkey/);
  });

  it('refuses while impersonating, even with a fresh step-up on the tenant account', async () => {
    const err = await errorOf(assertFreshStepUp(
      dbWith({ ...password, lastStepUpAt: minutesAgo(1) }), { sub: 'u1', impersonatedBy: 'staff-1' }, 'dkim_private_key',
    ));
    expect(err.status).toBe(403);
    expect(err.code).toBe('IMPERSONATION_FORBIDDEN');
  });

  it('refuses an unknown or disabled account', async () => {
    expect((await errorOf(assertFreshStepUp(dbWith(null), { sub: 'gone' }, 'cert_download'))).code).toBe('STEP_UP_UNAVAILABLE');
    expect((await errorOf(assertFreshStepUp(
      dbWith({ ...password, status: 'disabled', lastStepUpAt: minutesAgo(1) }), { sub: 'u1' }, 'cert_download',
    ))).code).toBe('STEP_UP_UNAVAILABLE');
  });
});
