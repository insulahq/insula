/**
 * Service-level tests for the notification providers module. We mock
 * the db row chains end-to-end to keep these unit-test fast.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const encryptMock = vi.fn((plain: string, _key: string) => `enc:${plain}`);
const decryptMock = vi.fn((cipher: string, _key: string) => cipher.replace(/^enc:/, ''));
vi.mock('../../oidc/crypto.js', () => ({
  encrypt: (a: string, b: string) => encryptMock(a, b),
  decrypt: (a: string, b: string) => decryptMock(a, b),
}));

const createTransportMock = vi.fn();
const sendMailMock = vi.fn();
vi.mock('nodemailer', () => ({
  default: { createTransport: (...args: unknown[]) => createTransportMock(...args) },
}));

const {
  listProviders,
  getProvider,
  createProvider,
  updateProvider,
  deleteProvider,
  getDefaultProviderRow,
  getProviderForCategoryEmail,
  testProvider,
} = await import('./service.js');

type Row = {
  id: string;
  name: string;
  providerType: string;
  scope: string;
  tenantId: string | null;
  channel: string;
  isDefault: boolean;
  enabled: boolean;
  smtpHost: string | null;
  smtpPort: number;
  smtpSecure: boolean;
  authUsername: string | null;
  authPasswordEncrypted: string | null;
  fromAddress: string;
  fromName: string | null;
  region: string | null;
  emailHeaderHtml: string;
  emailFooterHtml: string;
  lastTestedAt: Date | null;
  lastTestStatus: string | null;
  lastTestError: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdByUserId: string | null;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'p1',
    name: 'Test',
    providerType: 'smtp',
    scope: 'platform',
    tenantId: null,
    channel: 'email',
    isDefault: false,
    enabled: true,
    smtpHost: 'mail.example',
    smtpPort: 587,
    smtpSecure: false,
    authUsername: 'user',
    authPasswordEncrypted: 'enc:secret',
    fromAddress: 'noreply@example.test',
    fromName: 'Insula',
    region: null,
    emailHeaderHtml: '',
    emailFooterHtml: '',
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestError: null,
    createdAt: new Date('2026-05-28T00:00:00Z'),
    updatedAt: new Date('2026-05-28T00:00:00Z'),
    createdByUserId: 'admin',
    ...overrides,
  };
}

interface DbBuild {
  rows?: Row[];
  emptyOnSecondSelect?: boolean;
  defaultLookupRow?: Row | null;
}

function buildDb(opts: DbBuild = {}) {
  const updateCalls: Array<Record<string, unknown>> = [];
  const insertCalls: Array<Record<string, unknown>> = [];
  const deleteCalls: number[] = [];
  let selectCount = 0;
  const select = vi.fn().mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(opts.rows?.slice(0, 1) ?? []),
        orderBy: () => Promise.resolve(opts.rows ?? []),
      }),
    }),
  }));
  const insert = vi.fn().mockImplementation(() => ({
    values: (v: Record<string, unknown>) => {
      insertCalls.push(v);
      return Promise.resolve(undefined);
    },
  }));
  const update = vi.fn().mockImplementation(() => ({
    set: (v: Record<string, unknown>) => {
      updateCalls.push(v);
      return { where: () => Promise.resolve(undefined) };
    },
  }));
  const del = vi.fn().mockImplementation(() => ({
    where: () => {
      deleteCalls.push(1);
      return Promise.resolve(undefined);
    },
  }));
  // Use no-typed cast — we just need a shape that matches drizzle.
  void selectCount;
  return {
    db: { select, insert, update, delete: del } as unknown as Parameters<typeof listProviders>[0],
    updateCalls,
    insertCalls,
    deleteCalls,
  };
}

beforeEach(() => {
  encryptMock.mockClear();
  decryptMock.mockClear();
  createTransportMock.mockReset();
  sendMailMock.mockReset();
});

describe('notificationProvidersService', () => {
  it('listProviders maps rows to responses (no plaintext password)', async () => {
    const { db } = buildDb({ rows: [row({ id: 'p1', isDefault: true })] });
    const r = await listProviders(db);
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('p1');
    expect((r[0] as unknown as { authPassword?: string }).authPassword).toBeUndefined();
    expect(r[0].authPasswordSet).toBe(true);
  });

  it('getProvider throws NOTIFICATION_PROVIDER_NOT_FOUND when missing', async () => {
    const { db } = buildDb({ rows: [] });
    await expect(getProvider(db, 'missing')).rejects.toMatchObject({ code: 'NOTIFICATION_PROVIDER_NOT_FOUND' });
  });

  it('createProvider encrypts the password before INSERT', async () => {
    const { db, insertCalls } = buildDb({ rows: [row()] });
    await createProvider(db, {
      name: 'Brevo',
      providerType: 'brevo',
      smtpHost: 'smtp-relay.brevo.com',
      smtpPort: 587,
      smtpSecure: false,
      fromAddress: 'noreply@example.test',
      authUsername: 'apikey',
      authPassword: 'super-secret',
      enabled: true,
      isDefault: false,
    }, { userId: 'admin', encryptionKey: 'KEY' });
    expect(encryptMock).toHaveBeenCalledWith('super-secret', 'KEY');
    expect(insertCalls[0]).toMatchObject({ authPasswordEncrypted: 'enc:super-secret' });
  });

  it('deleteProvider refuses to remove the default provider', async () => {
    const { db } = buildDb({ rows: [row({ isDefault: true })] });
    await expect(deleteProvider(db, 'p1')).rejects.toMatchObject({ code: 'OPERATION_NOT_ALLOWED' });
  });

  it('getDefaultProviderRow returns the default email row when present', async () => {
    const { db } = buildDb({ rows: [row({ isDefault: true })] });
    const r = await getDefaultProviderRow(db, 'email');
    expect(r?.id).toBe('p1');
  });

  it('getDefaultProviderRow returns null when no default configured', async () => {
    const { db } = buildDb({ rows: [] });
    const r = await getDefaultProviderRow(db, 'email');
    expect(r).toBeNull();
  });

  it('testProvider success: records last_test_status=success', async () => {
    const { db, updateCalls } = buildDb({ rows: [row()] });
    createTransportMock.mockReturnValue({ sendMail: sendMailMock });
    sendMailMock.mockResolvedValue(undefined);
    const r = await testProvider(db, 'p1', { recipientEmail: 'ops@example.test' }, { encryptionKey: 'KEY' });
    expect(r.status).toBe('success');
    expect(updateCalls[0]).toMatchObject({ lastTestStatus: 'success', lastTestError: null });
    expect(decryptMock).toHaveBeenCalledWith('enc:secret', 'KEY');
  });

  it('testProvider failure: records last_test_status=failed + error message', async () => {
    const { db, updateCalls } = buildDb({ rows: [row()] });
    createTransportMock.mockReturnValue({ sendMail: sendMailMock });
    sendMailMock.mockRejectedValue(new Error('connection refused'));
    const r = await testProvider(db, 'p1', { recipientEmail: 'ops@example.test' }, { encryptionKey: 'KEY' });
    expect(r.status).toBe('failed');
    expect(r.error).toBe('connection refused');
    expect(updateCalls[0]).toMatchObject({ lastTestStatus: 'failed', lastTestError: 'connection refused' });
  });

  it('updateProvider re-encrypts the password only when supplied', async () => {
    const { db, updateCalls } = buildDb({ rows: [row()] });
    await updateProvider(db, 'p1', { name: 'Renamed' }, { encryptionKey: 'KEY' });
    expect(encryptMock).not.toHaveBeenCalled();
    expect(updateCalls[0]).toMatchObject({ name: 'Renamed' });
  });

  it('updateProvider encrypts the new password when supplied', async () => {
    const { db, updateCalls } = buildDb({ rows: [row()] });
    await updateProvider(db, 'p1', { authPassword: 'rotated' }, { encryptionKey: 'KEY' });
    expect(encryptMock).toHaveBeenCalledWith('rotated', 'KEY');
    expect(updateCalls[0]).toMatchObject({ authPasswordEncrypted: 'enc:rotated' });
  });

  describe('email header / footer', () => {
    it('returns both blocks on the response', async () => {
      const { db } = buildDb({ rows: [row({ emailHeaderHtml: '<p>H</p>', emailFooterHtml: '<p>F</p>' })] });
      const r = await getProvider(db, 'p1');
      expect(r.emailHeaderHtml).toBe('<p>H</p>');
      expect(r.emailFooterHtml).toBe('<p>F</p>');
    });

    it('createProvider stores the blocks, defaulting to empty', async () => {
      const base = {
        name: 'Relay', providerType: 'smtp' as const, smtpHost: 'smtp.example.test', smtpPort: 587,
        smtpSecure: false, fromAddress: 'noreply@example.test', enabled: true, isDefault: false,
      };
      const a = buildDb({ rows: [row()] });
      await createProvider(a.db, base, { userId: 'admin', encryptionKey: 'KEY' });
      expect(a.insertCalls[0]).toMatchObject({ emailHeaderHtml: '', emailFooterHtml: '' });

      const b = buildDb({ rows: [row()] });
      await createProvider(b.db, { ...base, emailHeaderHtml: '<p>H</p>', emailFooterHtml: '<p>F</p>' }, { userId: 'admin', encryptionKey: 'KEY' });
      expect(b.insertCalls[0]).toMatchObject({ emailHeaderHtml: '<p>H</p>', emailFooterHtml: '<p>F</p>' });
    });

    it('updateProvider patches only the blocks it is given, and can clear one', async () => {
      const { db, updateCalls } = buildDb({ rows: [row({ emailHeaderHtml: '<p>H</p>' })] });
      await updateProvider(db, 'p1', { emailHeaderHtml: '', emailFooterHtml: '<p>F</p>' }, { encryptionKey: 'KEY' });
      expect(updateCalls[0]).toEqual({ emailHeaderHtml: '', emailFooterHtml: '<p>F</p>' });
    });

    it('updateProvider refuses a header/footer on an ntfy provider', async () => {
      const { db, updateCalls } = buildDb({ rows: [row({ providerType: 'ntfy', channel: 'ntfy' })] });
      await expect(updateProvider(db, 'p1', { emailFooterHtml: '<p>F</p>' }, { encryptionKey: 'KEY' }))
        .rejects.toMatchObject({ code: 'INVALID_FIELD_VALUE', status: 400 });
      expect(updateCalls).toHaveLength(0);
      // Clearing (a no-op for ntfy) is accepted so a generic form can always send ''.
      await updateProvider(db, 'p1', { emailFooterHtml: '' }, { encryptionKey: 'KEY' });
    });

    it('testProvider without a header/footer sends the historical text-only message', async () => {
      const { db } = buildDb({ rows: [row()] });
      createTransportMock.mockReturnValue({ sendMail: sendMailMock });
      sendMailMock.mockResolvedValue(undefined);
      await testProvider(db, 'p1', { recipientEmail: 'ops@example.test' }, { encryptionKey: 'KEY' });
      expect(sendMailMock).toHaveBeenCalledWith({
        from: '"Insula" <noreply@example.test>',
        to: 'ops@example.test',
        subject: '[Platform] Notification provider test',
        text: 'This is an automated test from the notification provider "Test". If you received this, the provider\'s SMTP credentials are working.\n',
      });
    });

    it('testProvider with a header/footer adds an HTML part wrapped in them', async () => {
      const { db } = buildDb({ rows: [row({ emailHeaderHtml: '<p>HEADER-MARK</p>', emailFooterHtml: '<p>FOOTER-MARK</p>' })] });
      createTransportMock.mockReturnValue({ sendMail: sendMailMock });
      sendMailMock.mockResolvedValue(undefined);
      await testProvider(db, 'p1', { recipientEmail: 'ops@example.test' }, { encryptionKey: 'KEY' });
      const sent = sendMailMock.mock.calls[0][0] as { html: string; text: string };
      expect(sent.html.indexOf('HEADER-MARK')).toBeLessThan(sent.html.indexOf('automated test'));
      expect(sent.html.indexOf('automated test')).toBeLessThan(sent.html.indexOf('FOOTER-MARK'));
      expect(sent.text).toMatch(/^HEADER-MARK\n\nThis is an automated test[\s\S]*\n\nFOOTER-MARK\n$/);
    });
  });

  describe('getProviderForCategoryEmail (Phase 5)', () => {
    // Build a db whose select chain returns sequenced rows. Each
    // .limit() call dequeues the next array.
    function buildSequencedDb(sequence: unknown[][]) {
      let i = 0;
      const select = vi.fn().mockImplementation(() => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(sequence[i++] ?? []),
          }),
        }),
      }));
      return { select } as unknown as Parameters<typeof getProviderForCategoryEmail>[0];
    }

    it('returns the override row when the category sets email_provider_id and override is enabled', async () => {
      const override = { ...row({ id: 'p-override' }), enabled: true };
      const db = buildSequencedDb([
        [{ emailProviderId: 'p-override' }], // categories lookup
        [override],                          // providers lookup for override
      ]);
      const r = await getProviderForCategoryEmail(db, 'security.password_changed');
      expect(r?.id).toBe('p-override');
    });

    it('returns null when override exists but is disabled (no silent fallback) — security review fix', async () => {
      // Phase 5 security correction: disabling an override is the
      // operator's signal to stop using that provider. We must NOT
      // fall through to the default. Worker translates null into a
      // failed delivery so the operator sees something is wrong.
      const db = buildSequencedDb([
        [{ emailProviderId: 'p-override' }], // categories lookup
        [],                                  // override disabled → filtered out
      ]);
      const r = await getProviderForCategoryEmail(db, 'security.password_changed');
      expect(r).toBeNull();
    });

    it('falls back to default when the category has no override (email_provider_id NULL)', async () => {
      const defaultProvider = { ...row({ id: 'p-default' }), isDefault: true };
      const db = buildSequencedDb([
        [{ emailProviderId: null }],         // categories lookup, no override
        [defaultProvider],                   // default lookup
      ]);
      const r = await getProviderForCategoryEmail(db, 'tenant.welcome');
      expect(r?.id).toBe('p-default');
    });

    it('returns null when both override and default are missing', async () => {
      const db = buildSequencedDb([
        [{ emailProviderId: null }],         // no override
        [],                                  // no default
      ]);
      const r = await getProviderForCategoryEmail(db, 'tenant.welcome');
      expect(r).toBeNull();
    });

    it('returns null when category does not exist', async () => {
      const db = buildSequencedDb([
        [],                                  // no category row
        [],                                  // default lookup also empty
      ]);
      const r = await getProviderForCategoryEmail(db, 'unknown.category');
      expect(r).toBeNull();
    });
  });
});
