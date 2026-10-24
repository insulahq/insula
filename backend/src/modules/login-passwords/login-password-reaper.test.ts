/**
 * The reaper deletes every login password (app password) that has expired —
 * Stalwart never does, and Bulwark deletes an "Open webmail" session's only on
 * Sign out — and nothing else. The JMAP wire is mocked; the live run is the
 * DEV E2E.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const jmap = vi.hoisted(() => ({
  appPasswordGet: vi.fn(),
  appPasswordSet: vi.fn(),
  JmapError: class JmapError extends Error {
    constructor(message: string, readonly code: string) { super(message); }
  },
}));
vi.mock('../stalwart-jmap/client.js', () => jmap);

import { reapExpiredLoginPasswords, GRACE_MS, MAX_CONSECUTIVE_FAILURES } from './login-password-reaper.js';

const NOW = new Date('2026-10-24T12:00:00Z');
const SESSION = (uuid: string) => `Support session ${uuid}`;
const U1 = '0b8f4c2e-7a1d-4e5b-9c3a-2f6d8e1b4a7c';
const U2 = '1c9e5d3f-8b2e-4f6c-8d4b-3a7e9f2c5b8d';
const U3 = '2d0f6e4a-9c3f-4a7d-9e5c-4b8f0a3d6c9e';

/** select().from().where().orderBy() → the mailbox rows. */
function dbWith(rows: Array<{ id: string; principalId: string }>) {
  return {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => Promise.resolve(rows) }) }) }),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  jmap.appPasswordSet.mockImplementation(async ({ destroy }: { destroy: string[] }) => ({ destroyed: destroy }));
});

describe('reapExpiredLoginPasswords', () => {
  it('deletes every login password that expired more than the grace ago', async () => {
    jmap.appPasswordGet.mockResolvedValue([
      { id: 'ended', description: SESSION(U1), expiresAt: '2026-10-16T03:22:51Z' },
      { id: 'expired-login', description: 'Old laptop', expiresAt: '2026-10-01T00:00:00Z' },
      { id: 'expired-unlabelled', expiresAt: '2026-10-20T00:00:00Z' },
      { id: 'just-ended', description: SESSION(U2), expiresAt: new Date(NOW.getTime() - GRACE_MS + 1000).toISOString() },
      { id: 'just-expired', description: 'Tablet', expiresAt: new Date(NOW.getTime() - GRACE_MS + 1000).toISOString() },
      { id: 'open', description: SESSION(U3), expiresAt: '2026-10-24T18:00:00Z' },
      { id: 'later', description: 'Phone', expiresAt: '2027-01-01T00:00:00Z' },
      { id: 'no-expiry', description: 'Initial', expiresAt: null },
      { id: 'no-expiry-field', description: 'Desktop' },
    ]);

    const r = await reapExpiredLoginPasswords(dbWith([{ id: 'mb1', principalId: 'b' }]), NOW);

    expect(jmap.appPasswordSet).toHaveBeenCalledTimes(1);
    expect(jmap.appPasswordSet).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'b', destroy: ['ended', 'expired-login', 'expired-unlabelled'],
    }));
    expect(r).toEqual({ mailboxesChecked: 1, passwordsDeleted: 3, failures: 0, abandoned: false, firstError: null });
  });

  it('writes nothing to a mailbox with no expired login password', async () => {
    jmap.appPasswordGet.mockResolvedValue([{ id: 'open', description: SESSION(U3), expiresAt: '2026-10-24T18:00:00Z' }]);
    const r = await reapExpiredLoginPasswords(dbWith([{ id: 'mb1', principalId: 'b' }, { id: 'mb2', principalId: 'c' }]), NOW);
    expect(jmap.appPasswordSet).not.toHaveBeenCalled();
    expect(r).toMatchObject({ mailboxesChecked: 2, passwordsDeleted: 0 });
  });

  it('leaves a login password whose expiry it cannot read', async () => {
    jmap.appPasswordGet.mockResolvedValue([{ id: 'odd', description: SESSION(U1), expiresAt: 'not a date' }]);
    const r = await reapExpiredLoginPasswords(dbWith([{ id: 'mb1', principalId: 'b' }]), NOW);
    expect(jmap.appPasswordSet).not.toHaveBeenCalled();
    expect(r).toMatchObject({ passwordsDeleted: 0, failures: 0 });
  });

  it('counts a login password already gone as deleted', async () => {
    jmap.appPasswordGet.mockResolvedValue([{ id: 'ended', description: SESSION(U1), expiresAt: '2026-10-16T03:22:51Z' }]);
    jmap.appPasswordSet.mockResolvedValue({ destroyed: [], notDestroyed: { ended: { type: 'notFound' } } });
    const r = await reapExpiredLoginPasswords(dbWith([{ id: 'mb1', principalId: 'b' }]), NOW);
    expect(r).toMatchObject({ passwordsDeleted: 1, failures: 0 });
  });

  it('reports a login password the mail server refused to delete', async () => {
    jmap.appPasswordGet.mockResolvedValue([{ id: 'ended', description: SESSION(U1), expiresAt: '2026-10-16T03:22:51Z' }]);
    jmap.appPasswordSet.mockResolvedValue({ destroyed: [], notDestroyed: { ended: { type: 'forbidden' } } });
    const r = await reapExpiredLoginPasswords(dbWith([{ id: 'mb1', principalId: 'b' }]), NOW);
    expect(r).toMatchObject({ passwordsDeleted: 0, failures: 1 });
    expect(r.firstError).toMatch(/^mb1: .*forbidden/);
  });

  it('counts what was deleted when the mail server keeps some', async () => {
    jmap.appPasswordGet.mockResolvedValue([
      { id: 'a', description: SESSION(U1), expiresAt: '2026-10-16T03:22:51Z' },
      { id: 'b', description: SESSION(U2), expiresAt: '2026-10-16T03:22:51Z' },
    ]);
    jmap.appPasswordSet.mockResolvedValue({ destroyed: ['a'], notDestroyed: { b: { type: 'forbidden' } } });
    const r = await reapExpiredLoginPasswords(dbWith([{ id: 'mb1', principalId: 'b' }]), NOW);
    expect(r).toMatchObject({ passwordsDeleted: 1, failures: 1, abandoned: false });
    expect(r.firstError).toBe('mb1: mail server kept 1 expired login password(s): forbidden');
  });

  it('goes on past a mailbox that fails', async () => {
    jmap.appPasswordGet
      .mockRejectedValueOnce(new jmap.JmapError('JMAP error: Account not found.', 'forbidden'))
      .mockResolvedValueOnce([{ id: 'ended', description: SESSION(U1), expiresAt: '2026-10-16T03:22:51Z' }]);
    const r = await reapExpiredLoginPasswords(dbWith([{ id: 'mb1', principalId: 'b' }, { id: 'mb2', principalId: 'c' }]), NOW);
    expect(jmap.appPasswordSet).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'c', destroy: ['ended'] }));
    expect(r).toEqual({ mailboxesChecked: 1, passwordsDeleted: 1, failures: 1, abandoned: false, firstError: 'mb1: JMAP error: Account not found.' });
  });

  it('does not mistake failures spread among answering mailboxes for an outage', async () => {
    const total = 2 * (MAX_CONSECUTIVE_FAILURES + 1);
    let call = 0;
    jmap.appPasswordGet.mockImplementation(async () => {
      call += 1;
      if (call % 2 === 1) throw new Error('Account not found');
      return [];
    });
    const many = Array.from({ length: total }, (_, i) => ({ id: `mb${i}`, principalId: `p${i}` }));
    const r = await reapExpiredLoginPasswords(dbWith(many), NOW);
    expect(jmap.appPasswordGet).toHaveBeenCalledTimes(total);
    expect(r).toMatchObject({ mailboxesChecked: total / 2, failures: total / 2, abandoned: false });
  });

  // A row of mailboxes whose accounts are gone from the mail server is not an
  // outage: stopping there would stop every run at the same place, for good.
  it('goes on past a row of mailboxes the mail server answers with an error', async () => {
    const stale = MAX_CONSECUTIVE_FAILURES + 5;
    let call = 0;
    jmap.appPasswordGet.mockImplementation(async () => {
      call += 1;
      if (call <= stale) throw new jmap.JmapError('JMAP error: Account not found.', 'forbidden');
      return [{ id: 'ended', description: SESSION(U1), expiresAt: '2026-10-16T03:22:51Z' }];
    });
    const rows = Array.from({ length: stale + 1 }, (_, i) => ({ id: `mb${i}`, principalId: `p${i}` }));
    const r = await reapExpiredLoginPasswords(dbWith(rows), NOW);
    expect(r).toMatchObject({ mailboxesChecked: 1, passwordsDeleted: 1, failures: stale, abandoned: false });
  });

  it.each([
    ['refuses connections', new TypeError('fetch failed')],
    ['times out', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
    ['answers with an HTTP error', new jmap.JmapError('JMAP request failed: HTTP 502 Bad Gateway', 'httpError')],
  ])('stops when the mail server %s instead of asking every mailbox', async (_why, err) => {
    jmap.appPasswordGet.mockRejectedValue(err);
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `mb${i}`, principalId: `p${i}` }));
    const r = await reapExpiredLoginPasswords(dbWith(many), NOW);
    expect(jmap.appPasswordGet).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES);
    expect(r).toMatchObject({ mailboxesChecked: 0, failures: MAX_CONSECUTIVE_FAILURES, abandoned: true });
  });
});
