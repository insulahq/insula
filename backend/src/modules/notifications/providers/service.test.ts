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
    fromName: 'Phoenix',
    region: null,
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
});
