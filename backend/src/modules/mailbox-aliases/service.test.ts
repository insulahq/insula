import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../stalwart-jmap/client.js', () => ({
  getCachedPrincipalsAccountId: vi.fn().mockResolvedValue('acct-1'),
  JmapError: class JmapError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
}));
vi.mock('../stalwart-jmap/account-aliases.js', () => ({
  setAccountAliases: vi.fn().mockResolvedValue(undefined),
  ensureIdentityForAddress: vi.fn().mockResolvedValue(undefined),
  destroyIdentitiesForAddress: vi.fn().mockResolvedValue(undefined),
}));

const accountAliases = await import('../stalwart-jmap/account-aliases.js');
const clientMod = await import('../stalwart-jmap/client.js');
const {
  createMailboxAlias,
  listMailboxAliases,
  updateMailboxAlias,
  deleteMailboxAlias,
} = await import('./service.js');

const MAILBOX = {
  id: 'mb1',
  emailDomainId: 'ed1',
  tenantId: 'c1',
  localPart: 'myname',
  fullAddress: 'myname@example.com',
  mailboxType: 'mailbox',
  status: 'active',
  stalwartPrincipalId: 'sp-1',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const EMAIL_DOMAIN = {
  id: 'ed1',
  domainId: 'd1',
  tenantId: 'c1',
  enabled: 1,
  stalwartDomainId: 'sd-1',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const PARENT_DOMAIN = { id: 'd1', tenantId: 'c1', domainName: 'example.com' };

const ALIAS = {
  id: 'al1',
  mailboxId: 'mb1',
  emailDomainId: 'ed1',
  tenantId: 'c1',
  localPart: 'info',
  fullAddress: 'info@example.com',
  enabled: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** Mock DB returning per-sequential-select results (see email-aliases tests). */
function createMockDb(selectResults: unknown[][] = []) {
  let callIdx = 0;
  const whereFn = vi.fn().mockImplementation(() => {
    const result = selectResults[callIdx] ?? [];
    callIdx++;
    return Promise.resolve(result);
  });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  const updateSetWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateSetWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  return {
    db: {
      select: selectFn,
      insert: insertFn,
      update: updateFn,
      delete: deleteFn,
    } as unknown as Parameters<typeof createMailboxAlias>[0],
    insertValues,
    deleteWhere,
    updateSet,
  };
}

beforeEach(() => {
  vi.mocked(accountAliases.setAccountAliases).mockClear().mockResolvedValue(undefined);
  vi.mocked(accountAliases.ensureIdentityForAddress).mockClear().mockResolvedValue(undefined);
  vi.mocked(accountAliases.destroyIdentitiesForAddress).mockClear().mockResolvedValue(undefined);
  vi.mocked(clientMod.getCachedPrincipalsAccountId).mockResolvedValue('acct-1');
});

describe('createMailboxAlias', () => {
  it('pushes the whole map + identity, then inserts the row', async () => {
    // selects: mailbox, emailDomain, parentDomain, alias-count, dup-mailbox,
    // dup-list-alias, dup-mailbox-alias, desired-map rows, created row
    const { db, insertValues } = createMockDb([
      [MAILBOX], [EMAIL_DOMAIN], [PARENT_DOMAIN], [], [], [], [], [], [ALIAS],
    ]);
    const result = await createMailboxAlias(db, 'c1', 'mb1', { local_part: 'Info' });
    expect(result).toEqual(ALIAS);
    expect(accountAliases.setAccountAliases).toHaveBeenCalledWith(expect.objectContaining({
      principalId: 'sp-1',
      aliases: [{ localPart: 'info', stalwartDomainId: 'sd-1', enabled: true }],
    }));
    expect(accountAliases.ensureIdentityForAddress).toHaveBeenCalledWith(expect.objectContaining({
      principalId: 'sp-1',
      address: 'info@example.com',
    }));
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      localPart: 'info',
      fullAddress: 'info@example.com',
      enabled: 1,
    }));
  });

  it('409s when the address is already a mailbox', async () => {
    const { db } = createMockDb([
      [MAILBOX], [EMAIL_DOMAIN], [PARENT_DOMAIN], [], [{ id: 'other-mb' }],
    ]);
    await expect(createMailboxAlias(db, 'c1', 'mb1', { local_part: 'taken' }))
      .rejects.toMatchObject({ code: 'DUPLICATE_ENTRY' });
    expect(accountAliases.setAccountAliases).not.toHaveBeenCalled();
  });

  it('409s when the address is already a mailing-list alias', async () => {
    const { db } = createMockDb([
      [MAILBOX], [EMAIL_DOMAIN], [PARENT_DOMAIN], [], [], [{ id: 'list-alias' }],
    ]);
    await expect(createMailboxAlias(db, 'c1', 'mb1', { local_part: 'taken' }))
      .rejects.toMatchObject({ code: 'DUPLICATE_ENTRY' });
  });

  it('409s at the per-mailbox alias cap', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `al${i}` }));
    const { db } = createMockDb([
      [MAILBOX], [EMAIL_DOMAIN], [PARENT_DOMAIN], many,
    ]);
    await expect(createMailboxAlias(db, 'c1', 'mb1', { local_part: 'extra' }))
      .rejects.toMatchObject({ code: 'MAILBOX_ALIAS_LIMIT_REACHED' });
    expect(accountAliases.setAccountAliases).not.toHaveBeenCalled();
  });

  it('maps a Stalwart primaryKeyViolation to DUPLICATE_ENTRY and rolls back the map', async () => {
    const { JmapError } = clientMod as unknown as { JmapError: new (m: string, c: string) => Error };
    vi.mocked(accountAliases.setAccountAliases)
      .mockRejectedValueOnce(new JmapError('collision', 'primaryKeyViolation'))
      .mockResolvedValueOnce(undefined); // compensating re-push
    const { db, insertValues } = createMockDb([
      [MAILBOX], [EMAIL_DOMAIN], [PARENT_DOMAIN], [], [], [], [], [], [],
    ]);
    await expect(createMailboxAlias(db, 'c1', 'mb1', { local_part: 'clash' }))
      .rejects.toMatchObject({ code: 'DUPLICATE_ENTRY' });
    expect(insertValues).not.toHaveBeenCalled();
    // compensating re-push without the new alias
    expect(accountAliases.setAccountAliases).toHaveBeenCalledTimes(2);
  });

  it('stores the row unprovisioned when the mailbox has no principal yet', async () => {
    const unprovisioned = { ...MAILBOX, stalwartPrincipalId: null };
    const { db, insertValues } = createMockDb([
      [unprovisioned], [EMAIL_DOMAIN], [PARENT_DOMAIN], [], [], [], [], [{ ...ALIAS }],
    ]);
    await createMailboxAlias(db, 'c1', 'mb1', { local_part: 'info' });
    expect(accountAliases.setAccountAliases).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalled();
  });
});

describe('updateMailboxAlias', () => {
  it('disable pushes the flipped map and destroys the identity', async () => {
    // selects: pre-lock row, in-lock re-read, mailbox, emailDomain,
    // parentDomain, desired-map rows, updated row
    const { db } = createMockDb([
      [ALIAS], [ALIAS], [MAILBOX], [EMAIL_DOMAIN], [PARENT_DOMAIN], [ALIAS], [{ ...ALIAS, enabled: 0 }],
    ]);
    const result = await updateMailboxAlias(db, 'c1', 'al1', { enabled: false });
    expect(result.enabled).toBe(0);
    expect(accountAliases.setAccountAliases).toHaveBeenCalledWith(expect.objectContaining({
      aliases: [{ localPart: 'info', stalwartDomainId: 'sd-1', enabled: false }],
    }));
    expect(accountAliases.destroyIdentitiesForAddress).toHaveBeenCalledWith(expect.objectContaining({
      address: 'info@example.com',
    }));
  });

  it('enable pushes the map and ensures the identity', async () => {
    const disabled = { ...ALIAS, enabled: 0 };
    const { db } = createMockDb([
      [disabled], [disabled], [MAILBOX], [EMAIL_DOMAIN], [PARENT_DOMAIN], [disabled], [ALIAS],
    ]);
    const result = await updateMailboxAlias(db, 'c1', 'al1', { enabled: true });
    expect(result.enabled).toBe(1);
    expect(accountAliases.setAccountAliases).toHaveBeenCalledWith(expect.objectContaining({
      aliases: [{ localPart: 'info', stalwartDomainId: 'sd-1', enabled: true }],
    }));
    expect(accountAliases.ensureIdentityForAddress).toHaveBeenCalled();
  });

  it('no-ops when enabled already matches (decided on the in-lock re-read)', async () => {
    const { db } = createMockDb([[ALIAS], [ALIAS]]);
    const result = await updateMailboxAlias(db, 'c1', 'al1', { enabled: true });
    expect(result).toEqual(ALIAS);
    expect(accountAliases.setAccountAliases).not.toHaveBeenCalled();
  });

  it('502s visibly when the Stalwart push fails', async () => {
    vi.mocked(accountAliases.setAccountAliases).mockRejectedValueOnce(new Error('boom'));
    const { db } = createMockDb([
      [ALIAS], [ALIAS], [MAILBOX], [EMAIL_DOMAIN], [PARENT_DOMAIN], [ALIAS],
    ]);
    await expect(updateMailboxAlias(db, 'c1', 'al1', { enabled: false }))
      .rejects.toMatchObject({ code: 'MAIL_SERVER_ERROR' });
  });

  it('404s for a foreign tenant', async () => {
    const { db } = createMockDb([[]]);
    await expect(updateMailboxAlias(db, 'other', 'al1', { enabled: false }))
      .rejects.toMatchObject({ code: 'MAILBOX_ALIAS_NOT_FOUND' });
  });
});

describe('deleteMailboxAlias', () => {
  it('pushes the map without the alias, destroys the identity, deletes the row', async () => {
    // selects: alias row, mailbox, emailDomain, desired-map rows
    const { db, deleteWhere } = createMockDb([
      [ALIAS], [MAILBOX], [EMAIL_DOMAIN], [ALIAS],
    ]);
    await deleteMailboxAlias(db, 'c1', 'al1');
    expect(accountAliases.setAccountAliases).toHaveBeenCalledWith(expect.objectContaining({
      aliases: [], // desired map minus the deleted alias
    }));
    expect(accountAliases.destroyIdentitiesForAddress).toHaveBeenCalled();
    expect(deleteWhere).toHaveBeenCalled();
  });

  it('deletes the row even when the Stalwart push fails (reconcile sweeps)', async () => {
    vi.mocked(accountAliases.setAccountAliases).mockRejectedValueOnce(new Error('down'));
    const { db, deleteWhere } = createMockDb([
      [ALIAS], [MAILBOX], [EMAIL_DOMAIN], [ALIAS],
    ]);
    await deleteMailboxAlias(db, 'c1', 'al1');
    expect(deleteWhere).toHaveBeenCalled();
  });
});

describe('listMailboxAliases', () => {
  it('lists tenant aliases with optional filters', async () => {
    const { db } = createMockDb([[ALIAS]]);
    const result = await listMailboxAliases(db, 'c1', { mailboxId: 'mb1' });
    expect(result).toEqual([ALIAS]);
  });
});
