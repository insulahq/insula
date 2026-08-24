import { describe, it, expect, vi } from 'vitest';
import { createAlias, listAliases, updateAlias, deleteAlias } from './service.js';

const DOMAIN = {
  id: 'ed1',
  tenantId: 'c1',
  domainId: 'd1',
  enabled: 1,
  // M13: dkimSelector / dkimPrivateKeyEncrypted / dkimPublicKey dropped (migration 0075).
  catchAllAddress: null,
  mxProvisioned: 0,
  spfProvisioned: 0,
  dkimProvisioned: 0,
  dmarcProvisioned: 0,
  spamThresholdJunk: '5.0',
  spamThresholdReject: '10.0',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const PARENT_DOMAIN = {
  id: 'd1',
  tenantId: 'c1',
  domainName: 'example.com',
  dnsMode: 'primary',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const ALIAS = {
  id: 'a1',
  emailDomainId: 'ed1',
  tenantId: 'c1',
  sourceAddress: 'info@example.com',
  destinationAddresses: ['user@example.com'],
  enabled: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/**
 * Build a mock DB that returns different results per sequential .where() call.
 * Also supports insert, update, and delete chains.
 */
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
    select: selectFn,
    insert: insertFn,
    update: updateFn,
    delete: deleteFn,
  } as unknown as Parameters<typeof createAlias>[0];
}

describe('createAlias', () => {
  it('should create alias with valid source and destinations', async () => {
    // select calls: 1) emailDomain, 2) parentDomain, 3) existing alias, 4) existing mailbox, 5) created row
    const db = createMockDb([[DOMAIN], [PARENT_DOMAIN], [], [], [ALIAS]]);
    const result = await createAlias(db, 'c1', 'ed1', {
      source_address: 'info@example.com',
      destination_addresses: ['user@example.com'],
    });
    expect(result).toEqual(ALIAS);
  });

  it('should reject alias where source domain does not match email domain', async () => {
    const db = createMockDb([[DOMAIN], [PARENT_DOMAIN]]);
    await expect(
      createAlias(db, 'c1', 'ed1', {
        source_address: 'info@other.com',
        destination_addresses: ['user@example.com'],
      }),
    ).rejects.toMatchObject({ code: 'DOMAIN_MISMATCH', status: 400 });
  });

  it('should reject duplicate source address (alias)', async () => {
    const db = createMockDb([[DOMAIN], [PARENT_DOMAIN], [ALIAS]]);
    await expect(
      createAlias(db, 'c1', 'ed1', {
        source_address: 'info@example.com',
        destination_addresses: ['other@example.com'],
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_ENTRY', status: 409 });
  });

  it('should reject duplicate source address (mailbox)', async () => {
    const mailbox = { id: 'm1', fullAddress: 'info@example.com' };
    const db = createMockDb([[DOMAIN], [PARENT_DOMAIN], [], [mailbox]]);
    await expect(
      createAlias(db, 'c1', 'ed1', {
        source_address: 'info@example.com',
        destination_addresses: ['other@example.com'],
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_ENTRY', status: 409 });
  });
});

describe('listAliases', () => {
  it('should list aliases filtered by domain', async () => {
    const whereFn = vi.fn().mockResolvedValue([ALIAS]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as Parameters<typeof listAliases>[0];

    const result = await listAliases(db, 'c1', 'ed1');
    expect(result).toEqual([ALIAS]);
  });

  it('should list all aliases for tenant when no domain specified', async () => {
    const whereFn = vi.fn().mockResolvedValue([ALIAS]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as Parameters<typeof listAliases>[0];

    const result = await listAliases(db, 'c1');
    expect(result).toEqual([ALIAS]);
  });
});

describe('updateAlias', () => {
  it('should update alias destinations', async () => {
    const updatedAlias = { ...ALIAS, destinationAddresses: ['new@example.com'] };
    // Selects: alias row → email_domains (unprovisioned alias re-provision
    // attempt — ALIAS fixture has no stalwartListId) → updated row.
    const db = createMockDb([[ALIAS], [{ id: 'ed1', stalwartDomainId: null }], [updatedAlias]]);
    const result = await updateAlias(db, 'c1', 'a1', {
      destination_addresses: ['new@example.com'],
    });
    expect(result).toEqual(updatedAlias);
  });

  it('should throw when alias not found', async () => {
    const db = createMockDb([[]]);
    await expect(
      updateAlias(db, 'c1', 'missing', { enabled: false }),
    ).rejects.toMatchObject({ code: 'EMAIL_ALIAS_NOT_FOUND', status: 404 });
  });
});

describe('deleteAlias', () => {
  it('should delete alias', async () => {
    const db = createMockDb([[ALIAS]]);
    await deleteAlias(db, 'c1', 'a1');
    expect((db as any).delete).toHaveBeenCalled();
  });

  it('should throw when alias not found', async () => {
    const db = createMockDb([[]]);
    await expect(deleteAlias(db, 'c1', 'missing')).rejects.toMatchObject({
      code: 'EMAIL_ALIAS_NOT_FOUND',
      status: 404,
    });
  });
});

// ── Stalwart-backed aliases (R28, 2026-08-24) ───────────────────────────────

vi.mock('../stalwart-jmap/client.js', () => ({
  getCachedPrincipalsAccountId: vi.fn().mockResolvedValue('acct-1'),
}));
vi.mock('../stalwart-jmap/mailing-lists.js', () => ({
  createMailingList: vi.fn().mockResolvedValue('list-1'),
  updateMailingListRecipients: vi.fn().mockResolvedValue(undefined),
  destroyMailingList: vi.fn().mockResolvedValue(undefined),
  listMailingLists: vi.fn().mockResolvedValue([]),
  setDomainCatchAll: vi.fn().mockResolvedValue(undefined),
}));

const lists = await import('../stalwart-jmap/mailing-lists.js');
const { normalizeAliasDestinations } = await import('./service.js');

const PROVISIONED_DOMAIN = { ...DOMAIN, stalwartDomainId: 'sd-1' };

describe('normalizeAliasDestinations', () => {
  it('trims, lowercases, dedupes', () => {
    expect(normalizeAliasDestinations([' A@x.test ', 'a@x.test', 'b@y.test'], 'src@x.test'))
      .toEqual(['a@x.test', 'b@y.test']);
  });
  it('rejects the alias delivering to itself (loop)', () => {
    expect(() => normalizeAliasDestinations(['SRC@x.test'], 'src@x.test'))
      .toThrowError(/own address/);
  });
  it('rejects an empty destination set', () => {
    expect(() => normalizeAliasDestinations(['  '], 'src@x.test')).toThrowError(/at least one/);
  });
});

describe('createAlias — Stalwart provisioning', () => {
  it('provisions a MailingList and stores its id', async () => {
    const created = { ...ALIAS, stalwartListId: 'list-1' };
    const db = createMockDb([[PROVISIONED_DOMAIN], [PARENT_DOMAIN], [], [], [created]]);
    const result = await createAlias(db as never, 'c1', 'ed1', {
      source_address: 'info@example.com',
      destination_addresses: ['User@Example.com'],
    });
    expect(lists.createMailingList).toHaveBeenCalledWith(expect.objectContaining({
      localPart: 'info',
      stalwartDomainId: 'sd-1',
      destinations: ['user@example.com'],
    }));
    expect(result.stalwartListId).toBe('list-1');
  });

  it('fails VISIBLY (502) when the mail server rejects the list — no DB row', async () => {
    (lists.createMailingList as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const db = createMockDb([[PROVISIONED_DOMAIN], [PARENT_DOMAIN], [], []]);
    await expect(createAlias(db as never, 'c1', 'ed1', {
      source_address: 'info@example.com',
      destination_addresses: ['user@example.com'],
    })).rejects.toMatchObject({ code: 'MAIL_SERVER_ERROR', status: 502 });
    expect((db as unknown as { insert: ReturnType<typeof vi.fn> }).insert).not.toHaveBeenCalled();
  });

  it('stores the row unprovisioned when the domain has no Stalwart id (boot reconcile converges)', async () => {
    const created = { ...ALIAS, stalwartListId: null };
    const db = createMockDb([[{ ...DOMAIN, stalwartDomainId: null }], [PARENT_DOMAIN], [], [], [created]]);
    const result = await createAlias(db as never, 'c1', 'ed1', {
      source_address: 'info@example.com',
      destination_addresses: ['user@example.com'],
    });
    expect(result.stalwartListId).toBeNull();
  });
});

describe('updateAlias — Stalwart pushes', () => {
  it('destination change pushes recipients before the DB write', async () => {
    const row = { ...ALIAS, stalwartListId: 'list-1' };
    const db = createMockDb([[row], [{ ...row, destinationAddresses: ['x@y.test'] }]]);
    await updateAlias(db as never, 'c1', 'a1', { destination_addresses: ['X@y.test'] });
    expect(lists.updateMailingListRecipients).toHaveBeenCalledWith(expect.objectContaining({
      listId: 'list-1',
      destinations: ['x@y.test'],
    }));
  });

  it('disable destroys the list and clears the stored id', async () => {
    const row = { ...ALIAS, stalwartListId: 'list-1' };
    const db = createMockDb([[row], [{ ...row, enabled: 0, stalwartListId: null }]]);
    await updateAlias(db as never, 'c1', 'a1', { enabled: false });
    expect(lists.destroyMailingList).toHaveBeenCalledWith(expect.objectContaining({ listId: 'list-1' }));
  });

  it('re-enable recreates the list via the email domain', async () => {
    const row = { ...ALIAS, enabled: 0, stalwartListId: null };
    const db = createMockDb([[row], [PROVISIONED_DOMAIN], [{ ...row, enabled: 1, stalwartListId: 'list-1' }]]);
    await updateAlias(db as never, 'c1', 'a1', { enabled: true });
    expect(lists.createMailingList).toHaveBeenCalledWith(expect.objectContaining({
      localPart: 'info',
      stalwartDomainId: 'sd-1',
    }));
  });

  it('push failure surfaces 502 and skips the DB write', async () => {
    (lists.updateMailingListRecipients as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('down'));
    const row = { ...ALIAS, stalwartListId: 'list-1' };
    const db = createMockDb([[row]]);
    await expect(updateAlias(db as never, 'c1', 'a1', { destination_addresses: ['x@y.test'] }))
      .rejects.toMatchObject({ code: 'MAIL_SERVER_ERROR', status: 502 });
    expect((db as unknown as { update: ReturnType<typeof vi.fn> }).update).not.toHaveBeenCalled();
  });
});

describe('deleteAlias — Stalwart cleanup', () => {
  it('destroys the backing list best-effort', async () => {
    const row = { ...ALIAS, stalwartListId: 'list-1' };
    const db = createMockDb([[row]]);
    await deleteAlias(db as never, 'c1', 'a1');
    expect(lists.destroyMailingList).toHaveBeenCalledWith(expect.objectContaining({ listId: 'list-1' }));
  });
});
