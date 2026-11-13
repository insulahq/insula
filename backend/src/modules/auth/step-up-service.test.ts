/**
 * Step-up status and password verification, against a fake database that
 * answers each select in turn (the credential holder, then the session's
 * step-up row). That the row is looked up for THIS session and THIS holder is
 * a WHERE clause, so it is proven against Postgres in
 * step-up.integration.test.ts, not here.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  getStepUpStatus,
  verifyStepUpPassword,
  stepUpMaxAgeMs,
  stepUpSessionId,
  stepUpCredentialHolder,
  attributionOf,
  DEFAULT_STEP_UP_MAX_AGE_MS,
  KEY_MATERIAL_STEP_UP_MAX_AGE_MS,
} from './step-up-service.js';
import { hashNewPassword } from './service.js';
import { ApiError } from '../../shared/errors.js';

/** Each select() resolves to the next entry of `answers`. */
function sequencedDb(answers: unknown[][]) {
  const queue = [...answers];
  const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  const db = {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: async () => queue.shift() ?? [] }) }),
    })),
    update: vi.fn(() => ({ set: updateSet })),
  };
  return { db: db as never, raw: db, updateSet };
}

const active = { email: 'owner@example.test', passwordHash: 'h', passkeyMode: null, status: 'active' };
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);
const session = { sub: 'u1', sid: 'family-1' };

describe('getStepUpStatus', () => {
  it('requires a step-up and offers nothing for a missing or inactive account', async () => {
    for (const row of [[], [{ ...active, status: 'disabled' }]]) {
      const status = await getStepUpStatus(sequencedDb([row]).db, session);
      expect(status).toMatchObject({ required: true, methods: [], lastCredentialCheckAt: null });
    }
  });

  it('lists the methods: password, passkey, both, or none (OIDC-only)', async () => {
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ passwordHash: 'h', passkeyMode: null }, ['password']],
      [{ passwordHash: null, passkeyMode: 'alternative' }, ['passkey']],
      [{ passwordHash: 'h', passkeyMode: 'second_factor' }, ['password', 'passkey']],
      [{ passwordHash: null, passkeyMode: null }, []],
    ];
    for (const [over, methods] of cases) {
      const status = await getStepUpStatus(sequencedDb([[{ ...active, ...over }], []]).db, session);
      expect(status.methods).toEqual(methods);
    }
  });

  it('sign-in alone is not a step-up: no row for the session means required', async () => {
    const status = await getStepUpStatus(sequencedDb([[active], []]).db, session);
    expect(status.required).toBe(true);
    expect(status.lastCredentialCheckAt).toBeNull();
  });

  it('a row inside the window satisfies it; one past it does not', async () => {
    const fresh = await getStepUpStatus(sequencedDb([[active], [{ at: secondsAgo(60) }]]).db, session, KEY_MATERIAL_STEP_UP_MAX_AGE_MS);
    expect(fresh.required).toBe(false);
    const stale = await getStepUpStatus(sequencedDb([[active], [{ at: secondsAgo(6 * 60) }]]).db, session, KEY_MATERIAL_STEP_UP_MAX_AGE_MS);
    expect(stale.required).toBe(true);
    // The node terminal's longer window still accepts the same row.
    const terminal = await getStepUpStatus(sequencedDb([[active], [{ at: secondsAgo(6 * 60) }]]).db, session, DEFAULT_STEP_UP_MAX_AGE_MS);
    expect(terminal.required).toBe(false);
  });

  it('a token with no session id never satisfies it, and is not even looked up', async () => {
    const { db, raw } = sequencedDb([[active], [{ at: new Date() }]]);
    const status = await getStepUpStatus(db, { sub: 'u1' });
    expect(status.required).toBe(true);
    expect(raw.select).toHaveBeenCalledTimes(1);
  });

  it('under "Login as tenant" asks for the staff member\'s credential, and names it', async () => {
    const status = await getStepUpStatus(
      sequencedDb([[{ ...active, email: 'staff@example.test', passkeyMode: 'alternative' }], []]).db,
      { sub: 'tenant-user', impersonatedBy: 'staff-1', sid: 'imp:t1' },
    );
    expect(status).toMatchObject({
      impersonation: true, credentialEmail: 'staff@example.test', methods: ['password', 'passkey'], required: true,
    });
  });
});

describe('step-up helpers', () => {
  it('windows: 30 minutes for the node terminal, 5 for key material', () => {
    expect(stepUpMaxAgeMs('node_terminal')).toBe(30 * 60_000);
    expect(stepUpMaxAgeMs('dkim_private_key')).toBe(5 * 60_000);
    expect(stepUpMaxAgeMs('cert_download')).toBe(5 * 60_000);
  });

  it('the session is the sid, else the jti', () => {
    expect(stepUpSessionId({ sub: 'u', sid: 's', jti: 'j' })).toBe('s');
    expect(stepUpSessionId({ sub: 'u', jti: 'j' })).toBe('j');
    expect(stepUpSessionId({ sub: 'u' })).toBeNull();
  });

  it('the credential holder is the impersonator when there is one', () => {
    expect(stepUpCredentialHolder({ sub: 'u' })).toBe('u');
    expect(stepUpCredentialHolder({ sub: 'u', impersonatedBy: 'staff' })).toBe('staff');
  });

  it('attribution names the impersonator and the API token, nothing for a plain session', () => {
    expect(attributionOf({ sub: 'u' })).toEqual({});
    expect(attributionOf({ sub: 'u', impersonatedBy: 'staff' })).toEqual({ impersonatedBy: 'staff' });
    expect(attributionOf({ sub: 'u', apiToken: { tokenId: 't1', name: 'ci', via: 'api' } }))
      .toEqual({ via: 'api', apiTokenId: 't1', apiTokenName: 'ci' });
  });
});

describe('verifyStepUpPassword', () => {
  it('needs a password', async () => {
    await expect(verifyStepUpPassword(sequencedDb([]).db, 'u1', '')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
  });

  it('fails the same way for a missing, inactive or wrong-password account', async () => {
    const hash = await hashNewPassword('correct');
    await expect(verifyStepUpPassword(sequencedDb([[]]).db, 'gone', 'pw')).rejects.toMatchObject({ code: 'STEP_UP_FAILED', status: 401 });
    await expect(verifyStepUpPassword(sequencedDb([[{ id: 'u1', passwordHash: hash, status: 'disabled' }]]).db, 'u1', 'correct'))
      .rejects.toMatchObject({ code: 'STEP_UP_FAILED' });
    await expect(verifyStepUpPassword(sequencedDb([[{ id: 'u1', passwordHash: hash, status: 'active' }]]).db, 'u1', 'wrong'))
      .rejects.toBeInstanceOf(ApiError);
  });

  it('says so when the account has no password', async () => {
    await expect(verifyStepUpPassword(sequencedDb([[{ id: 'u1', passwordHash: null, status: 'active' }]]).db, 'u1', 'x'))
      .rejects.toMatchObject({ code: 'STEP_UP_METHOD_UNAVAILABLE', status: 409 });
  });

  it('on success notes the credential check, and records no step-up by itself', async () => {
    const { db, updateSet } = sequencedDb([[{ id: 'u1', passwordHash: await hashNewPassword('correct'), status: 'active' }]]);
    await verifyStepUpPassword(db, 'u1', 'correct');
    expect(updateSet).toHaveBeenCalledWith({ lastCredentialCheckAt: expect.any(Date) });
  });
});
