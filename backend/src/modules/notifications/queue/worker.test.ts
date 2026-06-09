import { describe, it, expect, vi, beforeEach } from 'vitest';

const getTemplateMock = vi.fn();
vi.mock('../templates/service.js', () => ({ getTemplate: getTemplateMock }));

const renderTemplateAsyncMock = vi.fn();
vi.mock('../templates/renderer.js', () => ({ renderTemplateAsync: renderTemplateAsyncMock }));

const getProviderForCategoryEmailMock = vi.fn();
vi.mock('../providers/service.js', () => ({
  getProviderForCategoryEmail: getProviderForCategoryEmailMock,
}));
// Backward-compat alias so existing test cases that referenced the
// old mock name keep working without churn.
const getDefaultProviderRowMock = getProviderForCategoryEmailMock;

const sendNotificationEmailMock = vi.fn();
const workerSendMock = vi.fn();
vi.mock('../email-sender.js', () => ({ sendNotificationEmail: sendNotificationEmailMock }));

const enqueueDeliveryMock = vi.fn();
vi.mock('./enqueue.js', () => ({ enqueueDelivery: enqueueDeliveryMock }));

const getBossMock = vi.fn();
vi.mock('./bootstrap.js', () => ({
  getBoss: getBossMock,
  setBossForTesting: () => {},
  stopBoss: async () => {},
}));

const { processDelivery } = await import('./worker.js');

type DeliveryFields = Partial<{
  id: string;
  userId: string | null;
  categoryId: string;
  channel: 'in_app' | 'email';
  templateId: string | null;
  locale: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  eventVariables: Record<string, unknown> | null;
}>;

function buildDb(opts: {
  delivery?: DeliveryFields;
  user?: { email: string | null } | null;
}) {
  const updateCalls: Array<Record<string, unknown>> = [];
  const selectImpl = vi.fn();

  // Worker now queries: 1) delivery row, 2) user email. The provider
  // lookup goes through getDefaultProviderRow (separately mocked).
  let selectCount = 0;
  const selectChain = (rows: unknown[]) => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(rows),
      }),
    }),
  });
  selectImpl.mockImplementation(() => {
    selectCount++;
    if (selectCount === 1) {
      return selectChain(opts.delivery ? [opts.delivery] : []);
    }
    return selectChain(opts.user ? [opts.user] : []);
  });

  const updateSet = (vals: Record<string, unknown>) => {
    updateCalls.push(vals);
    return { where: () => Promise.resolve(undefined) };
  };
  const update = () => ({ set: updateSet });

  return {
    db: { select: selectImpl, update } as unknown as Parameters<typeof processDelivery>[1]['db'],
    updateCalls,
  };
}

function defaultProvider() {
  return {
    id: 'p1', name: 'Test', providerType: 'smtp', scope: 'platform', tenantId: null,
    channel: 'email', isDefault: true, enabled: true,
    smtpHost: 'mail.example.test', smtpPort: 587, smtpSecure: false,
    authUsername: 'user', authPasswordEncrypted: null,
    fromAddress: 'noreply@example.test', fromName: null, region: null,
    lastTestedAt: null, lastTestStatus: null, lastTestError: null,
    createdAt: new Date(), updatedAt: new Date(), createdByUserId: null,
  };
}

beforeEach(() => {
  getTemplateMock.mockReset();
  renderTemplateAsyncMock.mockReset();
  sendNotificationEmailMock.mockReset();
  workerSendMock.mockReset();
  enqueueDeliveryMock.mockReset();
  getDefaultProviderRowMock.mockReset();
  // Default: a working provider is always available unless a test overrides.
  getDefaultProviderRowMock.mockResolvedValue(defaultProvider());
});

describe('processDelivery', () => {
  it('returns skipped when delivery row not found', async () => {
    const { db } = buildDb({});
    const r = await processDelivery('d1', { db, encryptionKey: 'KEY', send: workerSendMock });
    expect(r.status).toBe('skipped');
    expect(r.error).toBe('delivery_not_found');
  });

  it('returns skipped when delivery already in terminal status', async () => {
    const { db } = buildDb({
      delivery: { id: 'd1', status: 'sent', channel: 'email', attempt: 1, maxAttempts: 6, templateId: 't', userId: 'u', categoryId: 'c', locale: 'en', eventVariables: null },
    });
    const r = await processDelivery('d1', { db, encryptionKey: 'KEY', send: workerSendMock });
    expect(r.status).toBe('skipped');
    expect(r.error).toBe('terminal_status:sent');
  });

  it('happy path: marks sending → sent', async () => {
    const { db, updateCalls } = buildDb({
      delivery: { id: 'd1', status: 'queued', channel: 'email', attempt: 0, maxAttempts: 6, templateId: 't1', userId: 'u1', categoryId: 'c', locale: 'en', eventVariables: { name: 'a' } },
      user: { email: 'u1@example.com' },

    });
    getTemplateMock.mockResolvedValue({ id: 't1', subjectTemplate: 's', bodyTemplate: 'b', bodyFormat: 'plaintext', variablesSchema: null, channel: 'email', locale: 'en', version: 1 });
    renderTemplateAsyncMock.mockResolvedValue({ subject: 's', body: 'b' });
    workerSendMock.mockResolvedValue(undefined);

    const r = await processDelivery('d1', { db, encryptionKey: 'KEY', send: workerSendMock });
    expect(r.status).toBe('sent');
    // First update: status='sending'. Second: status='sent', sentAt, attempt=1.
    expect(updateCalls[0]).toMatchObject({ status: 'sending' });
    expect(updateCalls[1]).toMatchObject({ status: 'sent', attempt: 1 });
    expect(updateCalls[1].sentAt).toBeInstanceOf(Date);
    expect(workerSendMock).toHaveBeenCalled();
  });

  it('first failure: marks failed + re-enqueues with backoff', async () => {
    const { db, updateCalls } = buildDb({
      delivery: { id: 'd1', status: 'queued', channel: 'email', attempt: 0, maxAttempts: 6, templateId: 't1', userId: 'u1', categoryId: 'c', locale: 'en', eventVariables: { name: 'a' } },
      user: { email: 'u1@example.com' },

    });
    getTemplateMock.mockResolvedValue({ id: 't1', subjectTemplate: 's', bodyTemplate: 'b', bodyFormat: 'plaintext', variablesSchema: null, channel: 'email', locale: 'en', version: 1 });
    renderTemplateAsyncMock.mockResolvedValue({ subject: 's', body: 'b' });
    workerSendMock.mockRejectedValue(new Error('SMTP boom'));

    const r = await processDelivery('d1', { db, encryptionKey: 'KEY', send: workerSendMock });
    expect(r.status).toBe('failed');
    expect(r.error).toBe('SMTP boom');
    // Second update is the failure decision.
    const failUpdate = updateCalls[1];
    expect(failUpdate.status).toBe('failed');
    expect(failUpdate.attempt).toBe(1);
    expect(failUpdate.lastError).toBe('SMTP boom');
    expect(failUpdate.nextAttemptAt).toBeInstanceOf(Date);
    expect(enqueueDeliveryMock).toHaveBeenCalledTimes(1);
    const [id, opts] = enqueueDeliveryMock.mock.calls[0];
    expect(id).toBe('d1');
    expect(opts.startAfter).toBeInstanceOf(Date);
  });

  it('sixth failure: marks dlq, no re-enqueue', async () => {
    const { db, updateCalls } = buildDb({
      delivery: { id: 'd1', status: 'queued', channel: 'email', attempt: 5, maxAttempts: 6, templateId: 't1', userId: 'u1', categoryId: 'c', locale: 'en', eventVariables: { name: 'a' } },
      user: { email: 'u1@example.com' },

    });
    getTemplateMock.mockResolvedValue({ id: 't1', subjectTemplate: 's', bodyTemplate: 'b', bodyFormat: 'plaintext', variablesSchema: null, channel: 'email', locale: 'en', version: 1 });
    renderTemplateAsyncMock.mockResolvedValue({ subject: 's', body: 'b' });
    workerSendMock.mockRejectedValue(new Error('SMTP boom again'));

    const r = await processDelivery('d1', { db, encryptionKey: 'KEY', send: workerSendMock });
    expect(r.status).toBe('dlq');
    const failUpdate = updateCalls[1];
    expect(failUpdate.status).toBe('dlq');
    expect(failUpdate.attempt).toBe(6);
    expect(failUpdate.failedAt).toBeInstanceOf(Date);
    expect(failUpdate.nextAttemptAt).toBeNull();
    expect(enqueueDeliveryMock).not.toHaveBeenCalled();
  });

  it('template missing → failed + enqueued', async () => {
    const { db } = buildDb({
      delivery: { id: 'd1', status: 'queued', channel: 'email', attempt: 0, maxAttempts: 6, templateId: 't1', userId: 'u1', categoryId: 'c', locale: 'en', eventVariables: null },
    });
    getTemplateMock.mockResolvedValue(null);
    const r = await processDelivery('d1', { db, encryptionKey: 'KEY', send: workerSendMock });
    expect(r.status).toBe('failed');
    expect(r.error).toBe('template_not_found');
  });

  it('encryption key missing → failed + enqueued', async () => {
    const { db } = buildDb({
      delivery: { id: 'd1', status: 'queued', channel: 'email', attempt: 0, maxAttempts: 6, templateId: 't1', userId: 'u1', categoryId: 'c', locale: 'en', eventVariables: null },
      user: { email: 'u1@example.com' },

    });
    getTemplateMock.mockResolvedValue({ id: 't1', subjectTemplate: 's', bodyTemplate: 'b', bodyFormat: 'plaintext', variablesSchema: null, channel: 'email', locale: 'en', version: 1 });
    renderTemplateAsyncMock.mockResolvedValue({ subject: 's', body: 'b' });
    delete process.env.PLATFORM_ENCRYPTION_KEY;
    const r = await processDelivery('d1', { db });
    expect(r.status).toBe('failed');
    expect(r.error).toBe('platform_encryption_key_missing');
  });

  it('no default notification provider → failed + enqueued', async () => {
    // Phase 3B: dispatcher used to look up smtp_relay_configs; now
    // we use notification_providers. If the operator hasn't configured
    // one, the worker surfaces a clear error rather than crashing.
    const { db } = buildDb({
      delivery: { id: 'd1', status: 'queued', channel: 'email', attempt: 0, maxAttempts: 6, templateId: 't1', userId: 'u1', categoryId: 'c', locale: 'en', eventVariables: null },
      user: { email: 'u1@example.com' },
    });
    getTemplateMock.mockResolvedValue({ id: 't1', subjectTemplate: 's', bodyTemplate: 'b', bodyFormat: 'plaintext', variablesSchema: null, channel: 'email', locale: 'en', version: 1 });
    renderTemplateAsyncMock.mockResolvedValue({ subject: 's', body: 'b' });
    getDefaultProviderRowMock.mockResolvedValueOnce(null);
    const r = await processDelivery('d1', { db, encryptionKey: 'KEY', send: workerSendMock });
    expect(r.status).toBe('failed');
    expect(r.error).toBe('no_default_notification_provider');
    expect(workerSendMock).not.toHaveBeenCalled();
  });

  describe('stalwart-internal Provider path (Phase 6 prep)', () => {
    // The Provider row has NO password. The worker must read the
    // master account credentials from mail-secrets and inject them as
    // SMTP auth + envelope sender, while keeping the recipient-visible
    // From: header as the operator-chosen address.
    it('reads master creds at send time and overrides envelope sender', async () => {
      const stalwartProvider = {
        ...defaultProvider(),
        providerType: 'stalwart-internal',
        smtpHost: 'stalwart-mail.mail.svc.cluster.local',
        smtpPort: 465,
        smtpSecure: true,
        // NULL — operator never entered a password.
        authUsername: null,
        authPasswordEncrypted: null,
        fromAddress: 'notifications@apex.test',
        fromName: 'Insula Notifications',
      };
      getDefaultProviderRowMock.mockResolvedValue(stalwartProvider);
      const { db } = buildDb({
        delivery: { id: 'd1', status: 'queued', channel: 'email', attempt: 0, maxAttempts: 6, templateId: 't1', userId: 'u1', categoryId: 'c', locale: 'en', eventVariables: null },
        user: { email: 'u1@example.com' },
      });
      getTemplateMock.mockResolvedValue({ id: 't1', subjectTemplate: 's', bodyTemplate: 'b', bodyFormat: 'plaintext', variablesSchema: null, channel: 'email', locale: 'en', version: 1 });
      renderTemplateAsyncMock.mockResolvedValue({ subject: 's', body: 'b' });
      const readCreds = vi.fn().mockResolvedValue({ user: 'master@mail.apex.test', password: 'master-pw' });
      workerSendMock.mockResolvedValue(undefined);

      const r = await processDelivery('d1', {
        db, encryptionKey: 'KEY', send: workerSendMock, readStalwartMasterCreds: readCreds,
      });

      expect(r.status).toBe('sent');
      expect(workerSendMock).toHaveBeenCalledTimes(1);
      const sendArg = workerSendMock.mock.calls[0][0] as {
        authUsername: string | null; authPassword: string | null;
        fromAddress: string; envelopeFrom: string | null;
      };
      // SMTP authenticates as master.
      expect(sendArg.authUsername).toBe('master@mail.apex.test');
      expect(sendArg.authPassword).toBe('master-pw');
      // SMTP envelope = master (so Stalwart accepts MAIL FROM).
      expect(sendArg.envelopeFrom).toBe('master@mail.apex.test');
      // Recipient-visible From: header = operator-chosen address.
      expect(sendArg.fromAddress).toBe('notifications@apex.test');
    });

    it('marks delivery failed when mail-secrets is unreachable', async () => {
      const stalwartProvider = { ...defaultProvider(), providerType: 'stalwart-internal', authPasswordEncrypted: null };
      getDefaultProviderRowMock.mockResolvedValue(stalwartProvider);
      const { db } = buildDb({
        delivery: { id: 'd1', status: 'queued', channel: 'email', attempt: 0, maxAttempts: 6, templateId: 't1', userId: 'u1', categoryId: 'c', locale: 'en', eventVariables: null },
        user: { email: 'u1@example.com' },
      });
      getTemplateMock.mockResolvedValue({ id: 't1', subjectTemplate: 's', bodyTemplate: 'b', bodyFormat: 'plaintext', variablesSchema: null, channel: 'email', locale: 'en', version: 1 });
      renderTemplateAsyncMock.mockResolvedValue({ subject: 's', body: 'b' });
      const readCreds = vi.fn().mockResolvedValue(null);
      const r = await processDelivery('d1', {
        db, encryptionKey: 'KEY', send: workerSendMock, readStalwartMasterCreds: readCreds,
      });
      expect(r.status).toBe('failed');
      expect(r.error).toBe('stalwart_master_credentials_unavailable');
      expect(workerSendMock).not.toHaveBeenCalled();
    });
  });
});
