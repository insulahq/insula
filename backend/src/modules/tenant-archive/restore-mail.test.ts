import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Restore builds each mail domain again from its row (new DKIM key included),
 * then the mailboxes, importing their mail from the archive bundle — as a
 * restore job of the tenant, so it shows in the restore history.
 */

const { enable, dispatch, resolveStore, ensurePrincipals } = vi.hoisted(() => ({
  enable: vi.fn(async () => ({})),
  dispatch: vi.fn(async () => undefined),
  resolveStore: vi.fn(async () => ({ kind: 'shim' })),
  ensurePrincipals: vi.fn(async (_args: { addresses: readonly string[] }) => ({ outcomes: [] as Array<{ status: string; address: string; reason?: string }>, recreated: 0 })),
}));
vi.mock('../backup-restore/executors/ensure-stalwart-principals.js', () => ({ ensureStalwartPrincipals: ensurePrincipals }));
vi.mock('../email-domains/service.js', () => ({ enableEmailForDomain: enable }));
vi.mock('../backup-restore/shared.js', () => ({ dispatchExecutor: dispatch, resolveStoreForBundle: resolveStore }));

const { restoreTenantMail } = await import('./restore-mail.js');
const schema = await import('../../db/schema.js');

function fakeDb(emailDomainRows: unknown[], mailboxRows: unknown[], dnsRows: Array<{ id: string; domainId: string; recordType: string; recordName: string | null; recordValue: string | null }> = []) {
  const writes: Array<{ op: string; values: unknown }> = [];
  const db = {
    writes,
    select: () => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === schema.emailDomains) return emailDomainRows;
          if (table === schema.domains) return [{ id: 'd1', domainName: 'example.test' }, { id: 'd2', domainName: 'example.org' }];
          if (table === schema.mailboxes) return mailboxRows;
          if (table === schema.dnsRecords) return dnsRows;
          return [{ id: 'item', type: 'mailboxes-by-address' }];
        },
      }),
    }),
    update: () => ({ set: (values: unknown) => ({ where: async () => { writes.push({ op: 'update', values }); } }) }),
    insert: () => ({ values: async (values: unknown) => { writes.push({ op: 'insert', values }); } }),
    delete: () => ({ where: async (pred: unknown) => { writes.push({ op: 'delete', values: pred }); } }),
  };
  return db;
}

beforeEach(() => vi.clearAllMocks());

describe('restoreTenantMail', () => {
  it('re-provisions each removed mail domain as a restore — no "email ready" notice, the tenant need not read active yet', async () => {
    const db = fakeDb([
      { id: 'ed1', domainId: 'd1', stalwartDomainId: null, webmailEnabled: 0, catchAllAddress: null },
      { id: 'ed2', domainId: 'd2', stalwartDomainId: 'still-there', webmailEnabled: 0, catchAllAddress: null },
    ], []);
    const r = await restoreTenantMail(db as never, 't1', 'bkp-1', 'key');
    expect(enable).toHaveBeenCalledTimes(1);
    expect(enable).toHaveBeenCalledWith(db, 't1', 'd1', { webmail_enabled: false }, 'key', { restoringArchivedTenant: true });
    expect(r).toMatchObject({ domains: 1, mailboxes: 0, failures: [] });
  });

  it('clears the archive\'s copies of the mail records before the rebuild writes them again — no doubled SPF, no old DKIM key', async () => {
    const order: string[] = [];
    enable.mockImplementationOnce(async () => { order.push('enable'); return {}; });
    const db = fakeDb(
      [{ id: 'ed1', domainId: 'd1', stalwartDomainId: null, webmailEnabled: 0, catchAllAddress: null }],
      [],
      [
        { id: 'r-mx', domainId: 'd1', recordType: 'MX', recordName: 'example.test', recordValue: 'mail.example.test' },
        { id: 'r-spf', domainId: 'd1', recordType: 'TXT', recordName: 'example.test', recordValue: 'v=spf1 mx ~all' },
        { id: 'r-dkim', domainId: 'd1', recordType: 'TXT', recordName: 'sel._domainkey.example.test', recordValue: 'v=DKIM1; p=OLD' },
        { id: 'r-www', domainId: 'd1', recordType: 'A', recordName: 'www', recordValue: '192.0.2.10' },
        { id: 'r-verify', domainId: 'd1', recordType: 'TXT', recordName: 'example.test', recordValue: 'site-verification=abc' },
      ],
    );
    const origDelete = db.delete;
    db.delete = () => { order.push('delete'); return origDelete(); };
    await restoreTenantMail(db as never, 't1', 'bkp-1', 'key');
    expect(order).toEqual(['delete', 'delete', 'delete', 'enable']);
  });

  it('activates the mailbox rows BEFORE the import — a suspended account refuses the master login — and records a restore job', async () => {
    const db = fakeDb([], [{ id: 'm1' }, { id: 'm2' }]);
    const r = await restoreTenantMail(db as never, 't1', 'bkp-1', 'key');
    const firstUpdate = db.writes.find((w) => w.op === 'update');
    expect(firstUpdate?.values).toEqual({ status: 'active' });
    expect(db.writes.indexOf(firstUpdate!)).toBeLessThan(db.writes.findIndex((w) => w.op === 'insert'));
    expect(db.writes.filter((w) => w.op === 'insert').map((w) => w.values)).toEqual([
      expect.objectContaining({ tenantId: 't1', status: 'executing' }),
      expect.objectContaining({ bundleId: 'bkp-1', type: 'mailboxes-by-address', selector: { kind: 'all', mode: 'merge-skip-duplicates' } }),
    ]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ mailboxes: 2, failures: [] });
  });

  it('gives an account back to every mailbox the bundle does not hold — the platform\'s postmaster@ intake', async () => {
    const db = fakeDb([], [
      { id: 'm1', fullAddress: 'keeper@example.test', stalwartPrincipalId: 'p' },
      { id: 'm2', fullAddress: 'postmaster@example.test', stalwartPrincipalId: null },
    ]);
    ensurePrincipals.mockResolvedValueOnce({ outcomes: [{ status: 'recreated', address: 'postmaster@example.test' }], recreated: 1 });
    const r = await restoreTenantMail(db as never, 't1', 'bkp-1', 'key');
    expect(ensurePrincipals).toHaveBeenCalledWith(expect.objectContaining({ addresses: ['postmaster@example.test'] }));
    expect(r.failures).toEqual([]);
  });

  it('a mailbox whose account cannot be given back is reported', async () => {
    const db = fakeDb([], [{ id: 'm2', fullAddress: 'postmaster@example.test', stalwartPrincipalId: null }]);
    ensurePrincipals.mockResolvedValueOnce({ outcomes: [{ status: 'failed', address: 'postmaster@example.test', reason: 'domain missing' }], recreated: 0 });
    const r = await restoreTenantMail(db as never, 't1', 'bkp-1', 'key');
    expect(r.failures).toEqual(['mailbox postmaster@example.test: domain missing']);
  });

  it('a failed import is reported and recorded on the job; the restore goes on', async () => {
    dispatch.mockRejectedValueOnce(new Error('restic said no'));
    const db = fakeDb([], [{ id: 'm1' }]);
    const r = await restoreTenantMail(db as never, 't1', 'bkp-1', 'key');
    expect(r.failures).toEqual(['mail import: restic said no']);
    expect(db.writes.filter((w) => w.op === 'update').map((w) => w.values)).toContainEqual(expect.objectContaining({ status: 'failed', lastError: 'restic said no' }));
  });

  it('one mail domain that cannot be built is reported; the others still are', async () => {
    enable.mockRejectedValueOnce(new Error('mail server down'));
    const db = fakeDb([
      { id: 'ed1', domainId: 'd1', stalwartDomainId: null, webmailEnabled: 1, catchAllAddress: null },
      { id: 'ed2', domainId: 'd2', stalwartDomainId: null, webmailEnabled: 0, catchAllAddress: 'all@example.test' },
    ], []);
    const r = await restoreTenantMail(db as never, 't1', 'bkp-1', 'key');
    expect(r).toMatchObject({ domains: 1, failures: ['mail domain d1: mail server down'] });
    expect(enable).toHaveBeenLastCalledWith(expect.anything(), 't1', 'd2', { webmail_enabled: false, catch_all_address: 'all@example.test' }, 'key', { restoringArchivedTenant: true });
  });
});
