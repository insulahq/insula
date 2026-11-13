/**
 * assertFreshStepUp — the server-side gate in front of routes that hand out
 * key material (a DKIM private key, a certificate bundle). The panel's dialog
 * only saves a round trip; this is what refuses.
 *
 * The fake database answers the credential holder's row, then the session's
 * step-up row. Session binding itself is proven in step-up.integration.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { assertFreshStepUp } from './step-up-service.js';
import { ApiError } from '../../shared/errors.js';

function dbWith(user: Record<string, unknown> | null, stepUpAt: Date | null = null) {
  const queue: unknown[][] = [user ? [user] : [], stepUpAt ? [{ at: stepUpAt }] : []];
  const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => queue.shift() ?? [] }) }) }));
  return { db: { select } as never, select };
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const password = { email: 'u@example.test', passwordHash: 'h', passkeyMode: null, status: 'active' };
const session = { sub: 'u1', sid: 'family-1' };

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
  it('lets a session through that stepped up inside the 5-minute key window', async () => {
    await expect(assertFreshStepUp(dbWith(password, minutesAgo(4)).db, session, 'dkim_private_key')).resolves.toBeUndefined();
  });

  it('asks again past 5 minutes for key material', async () => {
    const err = await errorOf(assertFreshStepUp(dbWith(password, minutesAgo(6)).db, session, 'cert_download'));
    expect(err.code).toBe('STEP_UP_REQUIRED');
    expect(err.details).toMatchObject({ maxAgeSeconds: 300 });
  });

  it('asks for a step-up after sign-in alone, listing the methods', async () => {
    const err = await errorOf(assertFreshStepUp(dbWith({ ...password, passkeyMode: 'alternative' }).db, session, 'cert_download'));
    expect(err.status).toBe(403);
    expect(err.code).toBe('STEP_UP_REQUIRED');
    expect(err.details).toMatchObject({ purpose: 'cert_download', methods: ['password', 'passkey'], impersonation: false });
  });

  it('says plainly when the account has nothing to step up with (OIDC-only)', async () => {
    const err = await errorOf(assertFreshStepUp(dbWith({ ...password, passwordHash: null }).db, session, 'dkim_private_key'));
    expect(err.status).toBe(409);
    expect(err.code).toBe('STEP_UP_UNAVAILABLE');
    expect(err.message).toMatch(/passkey/);
  });

  it('under "Login as tenant" asks for the staff member\'s own credential, and lets a fresh one through', async () => {
    const caller = { sub: 'tenant-user', impersonatedBy: 'staff-1', sid: 'imp:t1' };
    const err = await errorOf(assertFreshStepUp(dbWith({ ...password, email: 'staff@example.test' }).db, caller, 'dkim_private_key'));
    expect(err.code).toBe('STEP_UP_REQUIRED');
    expect(err.message).toMatch(/your own staff/);
    expect(err.details).toMatchObject({ impersonation: true, credentialEmail: 'staff@example.test' });
    await expect(assertFreshStepUp(dbWith(password, minutesAgo(1)).db, caller, 'dkim_private_key')).resolves.toBeUndefined();
  });

  it('an API token passes without a step-up, without even a database read', async () => {
    const { db, select } = dbWith(null);
    await expect(assertFreshStepUp(db, { sub: 'u1', apiToken: { tokenId: 't1' } }, 'cert_download')).resolves.toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });

  it('refuses an unknown or disabled account', async () => {
    expect((await errorOf(assertFreshStepUp(dbWith(null).db, session, 'cert_download'))).code).toBe('STEP_UP_UNAVAILABLE');
    expect((await errorOf(assertFreshStepUp(
      dbWith({ ...password, status: 'disabled' }, minutesAgo(1)).db, session, 'cert_download',
    ))).code).toBe('STEP_UP_UNAVAILABLE');
  });
});
