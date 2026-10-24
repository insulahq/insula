/**
 * Unit tests for the login-passwords service. The JMAP wire is mocked;
 * the live round-trip is covered by the local E2E (create → secret →
 * IMAP/webmail login → revoke).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
      { id: 'a2', description: 'SMTP', createdAt: '2026-03-01T00:00:00Z', expiresAt: '2099-09-01T00:00:00Z', allowedIps: { '203.0.113.4/32': true } },
    ]);
    const out = await listLoginPasswords(dbWith([MB]), 't1', 'mb1');
    expect(jmap.appPasswordGet).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'b' }));
    expect(out).toEqual([
      { id: 'a1', label: 'iPhone', kind: 'login', createdAt: '2026-05-01T00:00:00Z', expiresAt: null, allowedIps: [] },
      { id: 'a2', label: 'SMTP', kind: 'login', createdAt: '2026-03-01T00:00:00Z', expiresAt: '2099-09-01T00:00:00Z', allowedIps: ['203.0.113.4/32'] },
    ]);
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('tolerates a missing description (empty label)', async () => {
    jmap.appPasswordGet.mockResolvedValue([{ id: 'a1' }]);
    const out = await listLoginPasswords(dbWith([MB]), 't1', 'mb1');
    expect(out[0]).toEqual({ id: 'a1', label: '', kind: 'login', createdAt: null, expiresAt: null, allowedIps: [] });
  });

  // Bulwark >= 1.11.1 signs a panel "Open webmail" in with an app password it
  // creates on the mailbox, named after the token's jti. Shown raw, a tenant
  // reads "Support session 3f2a…" as someone from support having opened it.
  it('labels a webmail session created by "Open webmail"', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-04T12:00:00Z'), toFake: ['Date'] });
    try {
      jmap.appPasswordGet.mockResolvedValue([
        { id: 'w1', description: 'Support session 0b8f4c2e-7a1d-4e5b-9c3a-2f6d8e1b4a7c', createdAt: '2026-10-04T08:00:00Z', expiresAt: '2026-10-04T16:00:00Z', allowedIps: {} },
      ]);
      const out = await listLoginPasswords(dbWith([MB]), 't1', 'mb1');
      expect(out[0]).toEqual({
        id: 'w1', label: 'Webmail session', kind: 'webmail_session',
        createdAt: '2026-10-04T08:00:00Z', expiresAt: '2026-10-04T16:00:00Z', allowedIps: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // Stalwart keeps an expired app password, and Bulwark deletes its own only
  // on Sign out: an ended session stayed in the list as if still open, an
  // expired login password as if it still worked.
  it('leaves out every login password that has expired', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-24T12:00:00Z'), toFake: ['Date'] });
    try {
      jmap.appPasswordGet.mockResolvedValue([
        { id: 'ended', description: 'Support session 0b8f4c2e-7a1d-4e5b-9c3a-2f6d8e1b4a7c', expiresAt: '2026-10-16T03:22:51Z' },
        { id: 'open', description: 'Support session 1c9e5d3f-8b2e-4f6c-8d4b-3a7e9f2c5b8d', expiresAt: '2026-10-24T18:00:00Z' },
        { id: 'login', description: 'Old laptop', expiresAt: '2026-10-01T00:00:00Z' },
        { id: 'later', description: 'Phone', expiresAt: '2027-01-01T00:00:00Z' },
        { id: 'standing', description: 'Initial', expiresAt: null },
      ]);
      const out = await listLoginPasswords(dbWith([MB]), 't1', 'mb1');
      expect(out.map((r) => r.id)).toEqual(['open', 'later', 'standing']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to create a login password named like a webmail session', async () => {
    const { createLoginPasswordSchema } = await import('@insula/api-contracts');
    const r = createLoginPasswordSchema.safeParse({ label: 'Support session 0b8f4c2e-7a1d-4e5b-9c3a-2f6d8e1b4a7c' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['label']);
    expect(r.error?.issues[0]?.message).toMatch(/reserved for webmail sessions/);
    expect(createLoginPasswordSchema.safeParse({ label: 'Support session laptop' }).success).toBe(true);
  });

  it.each([
    ['a tenant label that only starts the same way', 'Support session laptop'],
    ['a jti-shaped suffix with more text after it', 'Support session 0b8f4c2e-7a1d-4e5b-9c3a-2f6d8e1b4a7c (old)'],
    ['different wording', 'support session 0b8f4c2e-7a1d-4e5b-9c3a-2f6d8e1b4a7c'],
  ])('keeps %s as an ordinary login password', async (_why, description) => {
    jmap.appPasswordGet.mockResolvedValue([{ id: 'x', description }]);
    const out = await listLoginPasswords(dbWith([MB]), 't1', 'mb1');
    expect(out[0]).toMatchObject({ label: description, kind: 'login' });
  });
});

describe('login-passwords/service: createLoginPassword', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-24T12:00:00Z'), toFake: ['Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

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

  // An expired login password is deleted, so one created already expired would
  // show its secret once and be gone within the hour, never having worked.
  it.each([
    ['in the past', '2026-10-01T00:00:00Z'],
    ['right now', '2026-10-24T12:00:00Z'],
  ])('refuses an expiry %s', async (_when, expiresAt) => {
    await expect(createLoginPassword(dbWith([MB]), 't1', 'mb1', { label: 'Laptop', expiresAt }))
      .rejects.toMatchObject({ code: 'INVALID_FIELD_VALUE', status: 400, message: 'The expiry date must be in the future' });
    expect(jmap.appPasswordSet).not.toHaveBeenCalled();
  });

  it('accepts an expiry a second ahead', async () => {
    jmap.appPasswordSet.mockResolvedValue({ created: { n1: { id: 'new1', secret: 's' } } });
    await createLoginPassword(dbWith([MB]), 't1', 'mb1', { label: 'Laptop', expiresAt: '2026-10-24T12:00:01Z' });
    expect(jmap.appPasswordSet).toHaveBeenCalledTimes(1);
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
