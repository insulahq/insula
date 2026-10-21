import { describe, it, expect, vi } from 'vitest';
import { withMailCaptureLogin } from './mail-capture-window.js';
import type { Database } from '../../db/index.js';

/**
 * The archive's final bundle reads a SUSPENDED tenant's mail: login is
 * allowed for the capture, and taken away again after it — whatever the
 * capture did.
 */

const dbWith = (rows: Array<{ principalId: string | null; mailboxType: string }>): Database => ({
  select: () => ({ from: () => ({ where: async () => rows }) }),
}) as unknown as Database;

function deps(accountId: string | null = 'acc') {
  const calls: Array<{ principalId: string; suspended: boolean }> = [];
  return {
    calls,
    d: {
      principalsAccountId: vi.fn(async () => accountId),
      setAccess: vi.fn(async (a: { principalId: string; suspended: boolean }) => { calls.push({ principalId: a.principalId, suspended: a.suspended }); }),
      warn: vi.fn(),
    },
  };
}

describe('withMailCaptureLogin', () => {
  it('opens login for every provisioned mailbox, captures, then closes it again', async () => {
    const { calls, d } = deps();
    const order: string[] = [];
    d.setAccess.mockImplementation(async (a) => { calls.push(a); order.push(`${a.suspended ? 'close' : 'open'} ${a.principalId}`); });
    const out = await withMailCaptureLogin(
      dbWith([{ principalId: 'p1', mailboxType: 'mailbox' }, { principalId: null, mailboxType: 'mailbox' }, { principalId: 'p2', mailboxType: 'send_only' }]),
      't1',
      async () => { order.push('capture'); return 'bundle'; },
      d,
    );
    expect(out).toBe('bundle');
    expect(order).toEqual(['open p1', 'open p2', 'capture', 'close p1', 'close p2']);
  });

  it('closes login again when the capture fails', async () => {
    const { calls, d } = deps();
    await expect(withMailCaptureLogin(dbWith([{ principalId: 'p1', mailboxType: 'mailbox' }]), 't1', async () => { throw new Error('capture broke'); }, d))
      .rejects.toThrow('capture broke');
    expect(calls.at(-1)).toEqual(expect.objectContaining({ principalId: 'p1', suspended: true }));
  });

  it('a tenant without mailboxes is captured as it is', async () => {
    const { d } = deps();
    await expect(withMailCaptureLogin(dbWith([]), 't1', async () => 'ok', d)).resolves.toBe('ok');
    expect(d.setAccess).not.toHaveBeenCalled();
  });

  it('refuses when the mail server cannot be asked — the bundle would be taken without the mail', async () => {
    const { d } = deps(null);
    const capture = vi.fn();
    await expect(withMailCaptureLogin(dbWith([{ principalId: 'p1', mailboxType: 'mailbox' }]), 't1', capture, d))
      .rejects.toMatchObject({ code: 'MAIL_SERVER_UNREACHABLE' });
    expect(capture).not.toHaveBeenCalled();
  });
});
