/**
 * Unit tests for `recreateMailboxPrincipal` — the one create + re-apply used
 * by drift repair's "Recreate empty" and the backup-restore principal ensure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const client = vi.hoisted(() => ({
  accountSet: vi.fn(),
  updatePrincipal: vi.fn(),
}));
const sieve = vi.hoisted(() => ({
  applyMailRules: vi.fn(),
  applyAccountAccessState: vi.fn(),
}));
const aliases = vi.hoisted(() => ({
  setAccountAliases: vi.fn(),
  reconcileIdentitiesForAccount: vi.fn(),
}));

vi.mock('../stalwart-jmap/client.js', () => client);
vi.mock('../stalwart-jmap/sieve.js', () => sieve);
vi.mock('../stalwart-jmap/account-aliases.js', () => aliases);

import { recreateMailboxPrincipal, type RecreatableMailbox } from './recreate-principal.js';

function row(over: Partial<RecreatableMailbox> = {}): RecreatableMailbox {
  return {
    id: 'mb-1',
    fullAddress: 'jane@example.test',
    displayName: null,
    quotaMb: 1024,
    status: 'active',
    mailboxType: 'mailbox',
    forwardingAddresses: null,
    autoReply: 0,
    autoReplySubject: null,
    autoReplyBody: null,
    ...over,
  };
}

function dbStub(aliasRows: Array<Record<string, unknown>> = []) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve(aliasRows) }) }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => { updates.push(patch); return Promise.resolve(); },
      }),
    }),
  };
  return { db: db as never, updates };
}

const log = { warn: vi.fn() };

function created(id = 'p-new') {
  return { created: { 'recreated-mailbox': { id } }, notCreated: undefined };
}

function run(db: never, r: RecreatableMailbox) {
  return recreateMailboxPrincipal(db, { accountId: 'acct', row: r, stalwartDomainId: 'd-1', log });
}

describe('recreateMailboxPrincipal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.updatePrincipal.mockResolvedValue(undefined);
    sieve.applyMailRules.mockResolvedValue(undefined);
    sieve.applyAccountAccessState.mockResolvedValue(undefined);
    aliases.setAccountAliases.mockResolvedValue(undefined);
    aliases.reconcileIdentitiesForAccount.mockResolvedValue({ created: 0, destroyed: 0 });
  });

  it('sends only the keys Stalwart 0.16 accepts — never `emails`', async () => {
    client.accountSet.mockResolvedValue(created());
    const { db, updates } = dbStub();
    const res = await run(db, row());

    const payload = client.accountSet.mock.calls[0]![0].request.create['recreated-mailbox'];
    expect(Object.keys(payload).sort()).toEqual(['@type', 'credentials', 'domainId', 'name']);
    expect(payload).toMatchObject({ '@type': 'User', name: 'jane', domainId: 'd-1' });
    expect(payload.credentials['0']).toMatchObject({ '@type': 'Password', allowedIps: {}, expiresAt: null });
    expect(payload.credentials['0'].secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res).toEqual({ ok: true, principalId: 'p-new', warnings: [] });
    expect(updates).toEqual([{ stalwartPrincipalId: 'p-new' }]);
  });

  it('re-applies the quota in bytes, and none for send-only or unlimited', async () => {
    client.accountSet.mockResolvedValue(created());
    await run(dbStub().db, row({ quotaMb: 50 }));
    expect(client.updatePrincipal).toHaveBeenCalledWith(expect.objectContaining({
      id: 'p-new', patch: { 'quotas/maxDiskQuota': 50 * 1024 * 1024 },
    }));

    client.updatePrincipal.mockClear();
    await run(dbStub().db, row({ mailboxType: 'send_only' }));
    await run(dbStub().db, row({ quotaMb: 0 }));
    expect(client.updatePrincipal).not.toHaveBeenCalled();
  });

  it('a suspended mailbox comes back suspended, its aliases off and its forwarding dropped', async () => {
    client.accountSet.mockResolvedValue(created());
    const aliasRows = [{ localPart: 'info', fullAddress: 'info@example.test', enabled: 1 }];
    await run(dbStub(aliasRows).db, row({ status: 'disabled', forwardingAddresses: ['x@example.test'] }));

    expect(sieve.applyAccountAccessState).toHaveBeenCalledWith(expect.objectContaining({
      principalId: 'p-new', mailboxType: 'mailbox', suspended: true,
    }));
    expect(sieve.applyMailRules).toHaveBeenCalledWith(expect.objectContaining({
      suspended: true, forwardingAddresses: [],
    }));
    expect(aliases.setAccountAliases).toHaveBeenCalledWith(expect.objectContaining({
      aliases: [{ localPart: 'info', stalwartDomainId: 'd-1', enabled: false }],
    }));
  });

  it('skips the mail rules for a plain mailbox and the alias push when it has none', async () => {
    client.accountSet.mockResolvedValue(created());
    await run(dbStub().db, row());
    expect(sieve.applyAccountAccessState).not.toHaveBeenCalled();
    expect(sieve.applyMailRules).not.toHaveBeenCalled();
    expect(aliases.setAccountAliases).not.toHaveBeenCalled();
  });

  it('a failed re-apply still binds the principal and is named in warnings', async () => {
    client.accountSet.mockResolvedValue(created());
    client.updatePrincipal.mockRejectedValue(new Error('boom'));
    const { db, updates } = dbStub();
    const res = await run(db, row());
    expect(res).toEqual({ ok: true, principalId: 'p-new', warnings: ['quota'] });
    expect(updates).toEqual([{ stalwartPrincipalId: 'p-new' }]);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('a refused create returns the server reason and binds nothing', async () => {
    client.accountSet.mockResolvedValue({
      created: undefined,
      notCreated: { 'recreated-mailbox': { type: 'invalidProperties', description: 'Invalid key for object', properties: ['emails'] } },
    });
    const { db, updates } = dbStub();
    const res = await run(db, row());
    expect(res).toEqual({
      ok: false, code: 'PRINCIPAL_CREATE_REJECTED', reason: 'Invalid key for object',
      type: 'invalidProperties', properties: ['emails'],
    });
    expect(updates).toEqual([]);
  });

  it('an accepted create without an id binds nothing', async () => {
    client.accountSet.mockResolvedValue({ created: { 'recreated-mailbox': {} }, notCreated: undefined });
    const { db, updates } = dbStub();
    const res = await run(db, row());
    expect(res).toMatchObject({ ok: false, code: 'PRINCIPAL_CREATE_NO_ID' });
    expect(updates).toEqual([]);
  });
});
