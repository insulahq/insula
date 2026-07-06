import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mocks BEFORE importing the module under test — the module's
// top-level `import` of stalwart-jmap/client resolves once and we need
// the mock in place at that resolution time.
vi.mock('../../stalwart-jmap/client.js', () => ({
  findMailboxByEmail: vi.fn(),
  createMailbox: vi.fn(),
  getJmapSession: vi.fn(),
  findDomainByName: vi.fn(),
  createDomain: vi.fn(),
}));

import {
  findMailboxByEmail,
  createMailbox,
  getJmapSession,
  findDomainByName,
  createDomain,
} from '../../stalwart-jmap/client.js';
import { ensureStalwartPrincipals } from './ensure-stalwart-principals.js';

const findMock = findMailboxByEmail as unknown as ReturnType<typeof vi.fn>;
const createMock = createMailbox as unknown as ReturnType<typeof vi.fn>;
const sessionMock = getJmapSession as unknown as ReturnType<typeof vi.fn>;
const domFindMock = findDomainByName as unknown as ReturnType<typeof vi.fn>;
const domCreateMock = createDomain as unknown as ReturnType<typeof vi.fn>;

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
    expect(createMock).not.toHaveBeenCalled();
  });

  it('recreates principal when missing in Stalwart but DB row present', async () => {
    findMock.mockResolvedValue(null);
    createMock.mockResolvedValue({ id: 'stw-recreated', type: 'individual', name: 'b@example.com', emails: ['b@example.com'] });
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
    expect(createMock).toHaveBeenCalledOnce();
    const callArgs = createMock.mock.calls[0]![0] as { input: { quota?: { storage: number } } };
    // Quota: 1024 MB → 1024 * 1024 * 1024 bytes.
    expect(callArgs.input.quota?.storage).toBe(1073741824);
  });

  it('omits quota when DB row has quotaMb=0 (unlimited)', async () => {
    findMock.mockResolvedValue(null);
    createMock.mockResolvedValue({ id: 'stw-recreated', type: 'individual', name: 'c@example.com', emails: ['c@example.com'] });
    const app = makeApp([{
      id: 'mb-2',
      fullAddress: 'c@example.com',
      stalwartPrincipalId: null,
      displayName: null,
      quotaMb: 0,
    }]);
    const result = await ensureStalwartPrincipals({ app, addresses: ['c@example.com'] });
    expect(result.recreated).toBe(1);
    const callArgs = createMock.mock.calls[0]![0] as { input: { quota?: unknown } };
    expect(callArgs.input.quota).toBeUndefined();
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
    expect(createMock).not.toHaveBeenCalled();
  });

  it('creates the Stalwart DOMAIN principal when missing before the mailbox (DR re-create)', async () => {
    // Domain principal absent in Stalwart (deleted-tenant re-create) → create it.
    domFindMock.mockResolvedValue(null);
    domCreateMock.mockResolvedValue({ id: 'dom-new', type: 'domain', name: 'reborn.test' });
    // Mailbox principal also absent but DB row present → recreate it too.
    findMock.mockResolvedValue(null);
    createMock.mockResolvedValue({ id: 'stw-new', type: 'individual', name: 'user@reborn.test', emails: ['user@reborn.test'] });
    const app = makeApp([{
      id: 'mb-d',
      fullAddress: 'user@reborn.test',
      stalwartPrincipalId: null,
      displayName: null,
      quotaMb: 0,
    }]);

    const result = await ensureStalwartPrincipals({ app, addresses: ['user@reborn.test'] });

    // Domain created with the bare domain name (not the address) BEFORE the
    // mailbox, so createMailbox can validate the local part against it.
    expect(domCreateMock).toHaveBeenCalledOnce();
    expect(domCreateMock.mock.calls[0]![0]).toMatchObject({ input: { type: 'domain', name: 'reborn.test' } });
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
    createMock.mockResolvedValue({ id: 'stw-new', type: 'individual', name: 'recreate@example.com', emails: ['recreate@example.com'] });
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
