import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client.js')>();
  return {
    ...actual,
    rawStalwartCall: vi.fn(),
  };
});

const { rawStalwartCall } = await import('./client.js');
const {
  setAccountAliases,
  getAccountAliases,
  sameAliasSet,
  ensureIdentityForAddress,
  destroyIdentitiesForAddress,
  reconcileIdentitiesForAccount,
} = await import('./account-aliases.js');

const raw = vi.mocked(rawStalwartCall);

beforeEach(() => {
  raw.mockReset();
});

describe('sameAliasSet', () => {
  const desired = [
    { localPart: 'info', stalwartDomainId: 'd1', enabled: true },
    { localPart: 'sales', stalwartDomainId: 'd1', enabled: false },
  ];

  it('matches irrespective of order and case', () => {
    expect(sameAliasSet(desired, [
      { name: 'SALES', domainId: 'd1', enabled: false },
      { name: 'info', domainId: 'd1', enabled: true },
    ])).toBe(true);
  });

  it('detects an enabled-flag flip', () => {
    expect(sameAliasSet(desired, [
      { name: 'info', domainId: 'd1', enabled: true },
      { name: 'sales', domainId: 'd1', enabled: true },
    ])).toBe(false);
  });

  it('detects a missing / extra entry', () => {
    expect(sameAliasSet(desired, [{ name: 'info', domainId: 'd1', enabled: true }])).toBe(false);
    expect(sameAliasSet([], [{ name: 'ghost', domainId: 'd1', enabled: true }])).toBe(false);
    expect(sameAliasSet([], [])).toBe(true);
  });
});

describe('setAccountAliases', () => {
  it('sends the whole positional map with lowercased names', async () => {
    raw.mockResolvedValueOnce({ updated: { 'p1': null } });
    await setAccountAliases({
      accountId: 'acct',
      principalId: 'p1',
      aliases: [{ localPart: 'Info', stalwartDomainId: 'd1', enabled: true }],
    });
    expect(raw).toHaveBeenCalledWith(expect.objectContaining({
      method: 'x:Account/set',
      args: {
        accountId: 'acct',
        update: {
          p1: { aliases: { '0': { enabled: true, name: 'info', domainId: 'd1', description: null } } },
        },
      },
    }));
  });

  it('throws a coded JmapError on rejection', async () => {
    raw.mockResolvedValueOnce({
      notUpdated: { p1: { type: 'primaryKeyViolation', description: 'taken' } },
    });
    await expect(setAccountAliases({
      accountId: 'acct',
      principalId: 'p1',
      aliases: [],
    })).rejects.toMatchObject({ code: 'primaryKeyViolation' });
  });
});

describe('getAccountAliases', () => {
  it('normalizes the id-keyed map to entries', async () => {
    raw.mockResolvedValueOnce({
      list: [{ id: 'p1', aliases: { a: { enabled: true, name: 'Info', domainId: 'd1' }, b: { name: 'x' } } }],
    });
    const entries = await getAccountAliases({ accountId: 'acct', principalId: 'p1' });
    // entry `b` lacks domainId and is dropped
    expect(entries).toEqual([{ enabled: true, name: 'info', domainId: 'd1' }]);
  });
});

describe('identity helpers', () => {
  it('ensureIdentityForAddress is a no-op when the identity exists', async () => {
    raw.mockResolvedValueOnce({ list: [{ id: 'i1', email: 'INFO@x.test' }] });
    await ensureIdentityForAddress({ principalId: 'p1', address: 'info@x.test' });
    expect(raw).toHaveBeenCalledTimes(1); // only the get
  });

  it('ensureIdentityForAddress creates when missing', async () => {
    raw.mockResolvedValueOnce({ list: [] });
    raw.mockResolvedValueOnce({ created: { i1: { id: 'new' } } });
    await ensureIdentityForAddress({ principalId: 'p1', address: 'info@x.test' });
    expect(raw).toHaveBeenLastCalledWith(expect.objectContaining({
      method: 'Identity/set',
      args: expect.objectContaining({
        accountId: 'p1',
        create: { i1: { email: 'info@x.test', name: 'info@x.test' } },
      }),
    }));
  });

  it('destroyIdentitiesForAddress destroys every match and tolerates none', async () => {
    raw.mockResolvedValueOnce({ list: [
      { id: 'i1', email: 'info@x.test' },
      { id: 'i2', email: 'info@x.test' },
      { id: 'i3', email: 'other@x.test' },
    ] });
    raw.mockResolvedValueOnce({ destroyed: ['i1', 'i2'] });
    await destroyIdentitiesForAddress({ principalId: 'p1', address: 'info@x.test' });
    expect(raw).toHaveBeenLastCalledWith(expect.objectContaining({
      args: expect.objectContaining({ destroy: ['i1', 'i2'] }),
    }));

    raw.mockReset();
    raw.mockResolvedValueOnce({ list: [] });
    await destroyIdentitiesForAddress({ principalId: 'p1', address: 'gone@x.test' });
    expect(raw).toHaveBeenCalledTimes(1); // no destroy call
  });

  it('reconcileIdentitiesForAccount batches creates + destroys in one set', async () => {
    raw.mockResolvedValueOnce({ list: [
      { id: 'i1', email: 'keep@x.test' },
      { id: 'i2', email: 'drop@x.test' },
    ] });
    raw.mockResolvedValueOnce({ created: { i0: { id: 'n1' } }, destroyed: ['i2'] });
    const res = await reconcileIdentitiesForAccount({
      principalId: 'p1',
      wantAddresses: ['keep@x.test', 'add@x.test'],
      dropAddresses: ['drop@x.test'],
    });
    expect(res).toEqual({ created: 1, destroyed: 1 });
    expect(raw).toHaveBeenLastCalledWith(expect.objectContaining({
      args: expect.objectContaining({
        create: { i0: { email: 'add@x.test', name: 'add@x.test' } },
        destroy: ['i2'],
      }),
    }));
  });

  it('reconcileIdentitiesForAccount no-ops when converged', async () => {
    raw.mockResolvedValueOnce({ list: [{ id: 'i1', email: 'keep@x.test' }] });
    const res = await reconcileIdentitiesForAccount({
      principalId: 'p1',
      wantAddresses: ['keep@x.test'],
      dropAddresses: [],
    });
    expect(res).toEqual({ created: 0, destroyed: 0 });
    expect(raw).toHaveBeenCalledTimes(1);
  });
});
