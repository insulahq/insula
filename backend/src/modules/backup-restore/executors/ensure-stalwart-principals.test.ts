import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mocks BEFORE importing the module under test — the module's
// top-level `import` of stalwart-jmap/client resolves once and we need
// the mock in place at that resolution time.
vi.mock('../../stalwart-jmap/client.js', () => ({
  findMailboxByEmail: vi.fn(),
  accountSet: vi.fn(),
  updatePrincipal: vi.fn(),
  getJmapSession: vi.fn(),
  findDomainByName: vi.fn(),
  createDomain: vi.fn(),
}));

import {
  findMailboxByEmail,
  accountSet,
  updatePrincipal,
  getJmapSession,
  findDomainByName,
  createDomain,
} from '../../stalwart-jmap/client.js';
import { ensureStalwartPrincipals } from './ensure-stalwart-principals.js';

const findMock = findMailboxByEmail as unknown as ReturnType<typeof vi.fn>;
const acctSetMock = accountSet as unknown as ReturnType<typeof vi.fn>;
const updPrincMock = updatePrincipal as unknown as ReturnType<typeof vi.fn>;
const sessionMock = getJmapSession as unknown as ReturnType<typeof vi.fn>;
const domFindMock = findDomainByName as unknown as ReturnType<typeof vi.fn>;
const domCreateMock = createDomain as unknown as ReturnType<typeof vi.fn>;

/** Build an x:Account/set success envelope for the 'new-mailbox' create. */
function acctCreated(id: string) {
  return { created: { 'new-mailbox': { id, type: 'individual' } }, notCreated: undefined };
}

function makeApp(dbRows: Array<{
  id: string;
  fullAddress: string;
  stalwartPrincipalId: string | null;
  displayName: string | null;
  quotaMb: number;
}>) {
  const selected: typeof dbRows = [];
  const updateCalls: Array<{ id: string; stalwartPrincipalId: string }> = [];
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    db: {
      // `where` returns a thenable that ALSO exposes `.limit` so both the
      // mailboxes prefetch (`await …where()`) and the domain back-fill
      // (`…where().limit(1)`) resolve against the same mock.
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const p = Promise.resolve(dbRows) as Promise<typeof dbRows> & {
              limit?: (n: number) => Promise<typeof dbRows>;
            };
            p.limit = () => Promise.resolve(dbRows);
            return p;
          }),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((patch: { stalwartPrincipalId: string }) => ({
          where: vi.fn(() => {
            updateCalls.push({ id: 'captured-by-eq', ...patch });
            return Promise.resolve();
          }),
        })),
      })),
    },
    _selected: selected,
    _updateCalls: updateCalls,
  } as never;
}

describe('ensureStalwartPrincipals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMock.mockResolvedValue({
      primaryAccounts: { 'urn:ietf:params:jmap:principals': 'acct-principals' },
    });
    // Default: the mailbox's domain principal already exists in Stalwart, so
    // the domain-ensure step is a no-op for the mailbox-focused tests below.
    domFindMock.mockResolvedValue({ id: 'dom-existing', type: 'domain', name: 'example.com' });
  });

  it('reports existing for principals already in Stalwart', async () => {
    findMock.mockResolvedValue({ id: 'stw-1', type: 'individual', name: 'a@example.com', emails: ['a@example.com'] });
    const app = makeApp([]);
    const result = await ensureStalwartPrincipals({ app, addresses: ['a@example.com'] });
    expect(result.outcomes).toEqual([{ status: 'existing', address: 'a@example.com' }]);
    expect(result.recreated).toBe(0);
    expect(acctSetMock).not.toHaveBeenCalled();
  });

  it('recreates principal via x:Account/set (bare local part + domainId) + quota patch', async () => {
    findMock.mockResolvedValue(null);
    acctSetMock.mockResolvedValue(acctCreated('stw-recreated'));
    const app = makeApp([{
      id: 'mb-1',
      fullAddress: 'b@example.com',
      stalwartPrincipalId: null,
      displayName: 'Bob',
      quotaMb: 1024,
    }]);
    const result = await ensureStalwartPrincipals({ app, addresses: ['b@example.com'] });
    expect(result.recreated).toBe(1);
    expect(result.outcomes[0]).toEqual({
      status: 'recreated',
      address: 'b@example.com',
      stalwartPrincipalId: 'stw-recreated',
    });
    // Create payload: BARE local part (not the full address) + the domain's id.
    expect(acctSetMock).toHaveBeenCalledOnce();
    const setArgs = acctSetMock.mock.calls[0]![0] as {
      request: { create: { 'new-mailbox': { '@type': string; name: string; domainId: string } } };
    };
    expect(setArgs.request.create['new-mailbox']).toMatchObject({
      '@type': 'User', name: 'b', domainId: 'dom-existing',
    });
    // Quota applied AFTER create via updatePrincipal: 1024 MB → bytes.
    expect(updPrincMock).toHaveBeenCalledOnce();
    expect(updPrincMock.mock.calls[0]![0]).toMatchObject({
      id: 'stw-recreated', patch: { 'quotas/maxDiskQuota': 1073741824 },
    });
  });

  it('omits the quota patch when DB row has quotaMb=0 (unlimited)', async () => {
    findMock.mockResolvedValue(null);
    acctSetMock.mockResolvedValue(acctCreated('stw-recreated'));
    const app = makeApp([{
      id: 'mb-2',
      fullAddress: 'c@example.com',
      stalwartPrincipalId: null,
      displayName: null,
      quotaMb: 0,
    }]);
    const result = await ensureStalwartPrincipals({ app, addresses: ['c@example.com'] });
    expect(result.recreated).toBe(1);
    expect(updPrincMock).not.toHaveBeenCalled();
  });

  it('returns failed with MAILBOX_ROW_MISSING when both Stalwart AND DB are missing', async () => {
    findMock.mockResolvedValue(null);
    const app = makeApp([]); // no DB rows
    const result = await ensureStalwartPrincipals({ app, addresses: ['nope@example.com'] });
    expect(result.recreated).toBe(0);
    expect(result.outcomes[0]?.status).toBe('failed');
    if (result.outcomes[0]?.status === 'failed') {
      expect(result.outcomes[0].reason).toContain('MAILBOX_ROW_MISSING');
      expect(result.outcomes[0].reason).toContain('config-tables');
    }
    expect(acctSetMock).not.toHaveBeenCalled();
  });

  it('creates the Stalwart DOMAIN principal when missing, then binds the mailbox to its id (DR re-create)', async () => {
    // Domain principal absent in Stalwart (deleted-tenant re-create) → create it.
    domFindMock.mockResolvedValue(null);
    domCreateMock.mockResolvedValue({ id: 'dom-new', type: 'domain', name: 'reborn.test' });
    // Mailbox principal also absent but DB row present → recreate it too.
    findMock.mockResolvedValue(null);
    acctSetMock.mockResolvedValue(acctCreated('stw-new'));
    const app = makeApp([{
      id: 'mb-d',
      fullAddress: 'user@reborn.test',
      stalwartPrincipalId: null,
      displayName: null,
      quotaMb: 0,
    }]);

    const result = await ensureStalwartPrincipals({ app, addresses: ['user@reborn.test'] });

    // Domain created with the bare domain name BEFORE the mailbox…
    expect(domCreateMock).toHaveBeenCalledOnce();
    expect(domCreateMock.mock.calls[0]![0]).toMatchObject({ input: { type: 'domain', name: 'reborn.test' } });
    // …and the mailbox is bound to the FRESHLY-created domain's id (not a stale one).
    const setArgs = acctSetMock.mock.calls[0]![0] as {
      request: { create: { 'new-mailbox': { name: string; domainId: string } } };
    };
    expect(setArgs.request.create['new-mailbox']).toMatchObject({ name: 'user', domainId: 'dom-new' });
    expect(result.recreated).toBe(1);
    expect(result.outcomes[0]?.status).toBe('recreated');
  });

  it('does NOT create a domain when it already exists in Stalwart', async () => {
    domFindMock.mockResolvedValue({ id: 'dom-existing', type: 'domain', name: 'example.com' });
    findMock.mockResolvedValue({ id: 'stw-1', type: 'individual', name: 'a@example.com', emails: ['a@example.com'] });
    const app = makeApp([]);
    await ensureStalwartPrincipals({ app, addresses: ['a@example.com'] });
    expect(domCreateMock).not.toHaveBeenCalled();
  });

  it('throws STALWART_UNAVAILABLE if JMAP session fails', async () => {
    sessionMock.mockRejectedValue(new Error('network down'));
    const app = makeApp([]);
    try {
      await ensureStalwartPrincipals({ app, addresses: ['a@example.com'] });
      throw new Error('expected throw');
    } catch (err) {
      const e = err as { code?: string; message?: string };
      expect(e.code).toBe('STALWART_UNAVAILABLE');
      expect(e.message).toMatch(/network down/);
    }
  });

  it('handles mixed batch: existing + recreate + failed', async () => {
    findMock.mockImplementation(async ({ email }: { email: string }) => {
      if (email === 'exists@example.com') {
        return { id: 'stw-exists', type: 'individual', name: email, emails: [email] };
      }
      return null;
    });
    acctSetMock.mockResolvedValue(acctCreated('stw-new'));
    const app = makeApp([{
      id: 'mb-r',
      fullAddress: 'recreate@example.com',
      stalwartPrincipalId: null,
      displayName: null,
      quotaMb: 512,
    }]);
    const result = await ensureStalwartPrincipals({
      app,
      addresses: ['exists@example.com', 'recreate@example.com', 'missing@example.com'],
    });
    expect(result.recreated).toBe(1);
    expect(result.outcomes.map((o) => o.status))
      .toEqual(['existing', 'recreated', 'failed']);
  });
});
