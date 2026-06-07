/**
 * Unit tests for the login-passwords service. The JMAP wire is mocked;
 * the live round-trip is covered by the local E2E (create → secret →
 * IMAP/webmail login → revoke).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const jmap = vi.hoisted(() => ({
  appPasswordGet: vi.fn(),
  appPasswordSet: vi.fn(),
}));
vi.mock('../stalwart-jmap/client.js', () => jmap);

import {
  listLoginPasswords,
  createLoginPassword,
  revokeLoginPassword,
  LoginPasswordError,
} from './service.js';

// Minimal Drizzle stub: select().from().innerJoin().innerJoin().where()
// resolves to the supplied mailbox rows.
function dbWith(rows: Array<Record<string, unknown>>) {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => Promise.resolve(rows),
          }),
        }),
      }),
    }),
  } as never;
}

const MB = { id: 'mb1', fullAddress: 'jane@acme.com', stalwartPrincipalId: 'b' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('login-passwords/service: resolveMailbox guards', () => {
  it('404 when the mailbox is not under the tenant', async () => {
    await expect(listLoginPasswords(dbWith([]), 't1', 'mb1'))
      .rejects.toMatchObject({ code: 'MAILBOX_NOT_FOUND', status: 404 });
  });

  it('409 when the mailbox has no stalwart principal yet', async () => {
    const db = dbWith([{ ...MB, stalwartPrincipalId: null }]);
    await expect(listLoginPasswords(db, 't1', 'mb1'))
      .rejects.toBeInstanceOf(LoginPasswordError);
    await expect(listLoginPasswords(db, 't1', 'mb1'))
      .rejects.toMatchObject({ code: 'MAILBOX_NOT_PROVISIONED', status: 409 });
  });
});

describe('login-passwords/service: listLoginPasswords', () => {
  it('maps Stalwart rows (description→label, allowedIps map→array, secret never present)', async () => {
    jmap.appPasswordGet.mockResolvedValue([
      { id: 'a1', description: 'iPhone', createdAt: '2026-05-01T00:00:00Z', expiresAt: null, allowedIps: {}, secret: '****' },
      { id: 'a2', description: 'SMTP', createdAt: '2026-03-01T00:00:00Z', expiresAt: '2026-09-01T00:00:00Z', allowedIps: { '203.0.113.4/32': true } },
    ]);
    const out = await listLoginPasswords(dbWith([MB]), 't1', 'mb1');
    expect(jmap.appPasswordGet).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'b' }));
    expect(out).toEqual([
      { id: 'a1', label: 'iPhone', createdAt: '2026-05-01T00:00:00Z', expiresAt: null, allowedIps: [] },
      { id: 'a2', label: 'SMTP', createdAt: '2026-03-01T00:00:00Z', expiresAt: '2026-09-01T00:00:00Z', allowedIps: ['203.0.113.4/32'] },
    ]);
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('tolerates a missing description (empty label)', async () => {
    jmap.appPasswordGet.mockResolvedValue([{ id: 'a1' }]);
    const out = await listLoginPasswords(dbWith([MB]), 't1', 'mb1');
    expect(out[0]).toEqual({ id: 'a1', label: '', createdAt: null, expiresAt: null, allowedIps: [] });
  });
});

describe('login-passwords/service: createLoginPassword', () => {
  it('submits description/expiresAt/allowedIps-map and returns the one-time secret', async () => {
    jmap.appPasswordSet.mockResolvedValue({ created: { n1: { id: 'new1', secret: 'app-aaaa-bbbb' } } });
    const out = await createLoginPassword(dbWith([MB]), 't1', 'mb1', {
      label: 'iPhone Mail', expiresAt: '2026-12-31T00:00:00Z', allowedIps: ['10.0.0.2', '10.0.0.3'],
    });
    const arg = jmap.appPasswordSet.mock.calls[0][0];
    expect(arg.accountId).toBe('b');
    expect(arg.create.n1).toEqual({
      description: 'iPhone Mail',
      allowedIps: { '10.0.0.2': true, '10.0.0.3': true },
      expiresAt: '2026-12-31T00:00:00Z',
    });
    expect(out).toEqual({
      id: 'new1', label: 'iPhone Mail', secret: 'app-aaaa-bbbb',
      expiresAt: '2026-12-31T00:00:00Z', allowedIps: ['10.0.0.2', '10.0.0.3'],
    });
  });

  it('defaults: no expiry, no IPs → expiresAt null + empty allowedIps map', async () => {
    jmap.appPasswordSet.mockResolvedValue({ created: { n1: { id: 'new1', secret: 's' } } });
    await createLoginPassword(dbWith([MB]), 't1', 'mb1', { label: 'Webmail' });
    const arg = jmap.appPasswordSet.mock.calls[0][0];
    expect(arg.create.n1).toEqual({ description: 'Webmail', allowedIps: {}, expiresAt: null });
  });

  it('502 when Stalwart returns no created entry / no secret', async () => {
    jmap.appPasswordSet.mockResolvedValue({ created: {}, notCreated: { n1: { type: 'overQuota' } } });
    await expect(createLoginPassword(dbWith([MB]), 't1', 'mb1', { label: 'x' }))
      .rejects.toMatchObject({ code: 'STALWART_API_ERROR', status: 502 });
  });
});

describe('login-passwords/service: revokeLoginPassword', () => {
  it('resolves when Stalwart reports the id destroyed', async () => {
    jmap.appPasswordSet.mockResolvedValue({ destroyed: ['a1'] });
    await expect(revokeLoginPassword(dbWith([MB]), 't1', 'mb1', 'a1')).resolves.toBeUndefined();
    expect(jmap.appPasswordSet.mock.calls[0][0]).toMatchObject({ accountId: 'b', destroy: ['a1'] });
  });

  it('is idempotent — notFound is treated as already-revoked', async () => {
    jmap.appPasswordSet.mockResolvedValue({ destroyed: [], notDestroyed: { a1: { type: 'notFound' } } });
    await expect(revokeLoginPassword(dbWith([MB]), 't1', 'mb1', 'a1')).resolves.toBeUndefined();
  });

  it('502 on a non-notFound rejection', async () => {
    jmap.appPasswordSet.mockResolvedValue({ destroyed: [], notDestroyed: { a1: { type: 'forbidden' } } });
    await expect(revokeLoginPassword(dbWith([MB]), 't1', 'mb1', 'a1'))
      .rejects.toMatchObject({ code: 'STALWART_API_ERROR', status: 502 });
  });
});
