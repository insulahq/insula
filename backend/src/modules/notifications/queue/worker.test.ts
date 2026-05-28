import { describe, it, expect, vi, beforeEach } from 'vitest';

const getTemplateMock = vi.fn();
vi.mock('../templates/service.js', () => ({ getTemplate: getTemplateMock }));

const renderTemplateAsyncMock = vi.fn();
vi.mock('../templates/renderer.js', () => ({ renderTemplateAsync: renderTemplateAsyncMock }));

const sendNotificationEmailMock = vi.fn();
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
  relay?: { id: string; isDefault: number } | null;
}) {
  const updateCalls: Array<Record<string, unknown>> = [];
  const selectImpl = vi.fn();

  // First select call returns delivery, second returns user, third returns relay.
  // Use a sequence-aware mock.
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
    if (selectCount === 2) {
      return selectChain(opts.user ? [opts.user] : []);
    }
    return selectChain(opts.relay ? [opts.relay] : []);
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

beforeEach(() => {
  getTemplateMock.mockReset();
  renderTemplateAsyncMock.mockReset();
  sendNotificationEmailMock.mockReset();
  enqueueDeliveryMock.mockReset();
});

describe('processDelivery', () => {
  it('returns skipped when delivery row not found', async () => {
    const { db } = buildDb({});
    const r = await processDelivery('d1', { db, encryptionKey: 'KEY' });
    expect(r.status).toBe('skipped');
    expect(r.error).toBe('delivery_not_found');
  });

  it('returns skipped when delivery already in terminal status', async () => {
    const { db } = buildDb({
      delivery: { id: 'd1', status: 'sent', channel: 'email', attempt: 1, maxAttempts: 6, templateId: 't', userId: 'u', categoryId: 'c', locale: 'en', eventVariables: null },
    });
    const r = await processDelivery('d1', { db, encryptionKey: 'KEY' });
    expect(r.status).toBe('skipped');
    expect(r.error).toBe('terminal_status:sent');
  });

  it('happy path: marks sending → sent', async () => {
    const { db, updateCalls } = buildDb({
      delivery: { id: 'd1', status: 'queued', channel: 'email', attempt: 0, maxAttempts: 6, templateId: 't1', userId: 'u1', categoryId: 'c', locale: 'en', eventVariables: { name: 'a' } },
      user: { email: 'u1@example.com' },
      relay: { id: 'r1', isDefault: 1 },
    });
    getTemplateMock.mockResolvedValue({ id: 't1', subjectTemplate: 's', bodyTemplate: 'b', bodyFormat: 'plaintext', variablesSchema: null, channel: 'email', locale: 'en', version: 1 });
    renderTemplateAsyncMock.mockResolvedValue({ subject: 's', body: 'b' });
    sendNotificationEmailMock.mockResolvedValue(undefined);

    const r = await processDelivery('d1', { db, encryptionKey: 'KEY' });
    expect(r.status).toBe('sent');
    // First update: status='sending'. Second: status='sent', sentAt, attempt=1.
    expect(updateCalls[0]).toMatchObject({ status: 'sending' });
    expect(updateCalls[1]).toMatchObject({ status: 'sent', attempt: 1 });
    expect(updateCalls[1].sentAt).toBeInstanceOf(Date);
    expect(sendNotificationEmailMock).toHaveBeenCalled();
  });

  it('first failure: marks failed + re-enqueues with backoff', async () => {
    const { db, updateCalls } = buildDb({
      delivery: { id: 'd1', status: 'queued', channel: 'email', attempt: 0, maxAttempts: 6, templateId: 't1', userId: 'u1', categoryId: 'c', locale: 'en', eventVariables: { name: 'a' } },
      user: { email: 'u1@example.com' },
      relay: { id: 'r1', isDefault: 1 },
    });
    getTemplateMock.mockResolvedValue({ id: 't1', subjectTemplate: 's', bodyTemplate: 'b', bodyFormat: 'plaintext', variablesSchema: null, channel: 'email', locale: 'en', version: 1 });
    renderTemplateAsyncMock.mockResolvedValue({ subject: 's', body: 'b' });
    sendNotificationEmailMock.mockRejectedValue(new Error('SMTP boom'));

    const r = await processDelivery('d1', { db, encryptionKey: 'KEY' });
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
      relay: { id: 'r1', isDefault: 1 },
    });
    getTemplateMock.mockResolvedValue({ id: 't1', subjectTemplate: 's', bodyTemplate: 'b', bodyFormat: 'plaintext', variablesSchema: null, channel: 'email', locale: 'en', version: 1 });
    renderTemplateAsyncMock.mockResolvedValue({ subject: 's', body: 'b' });
    sendNotificationEmailMock.mockRejectedValue(new Error('SMTP boom again'));

    const r = await processDelivery('d1', { db, encryptionKey: 'KEY' });
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
    const r = await processDelivery('d1', { db, encryptionKey: 'KEY' });
    expect(r.status).toBe('failed');
    expect(r.error).toBe('template_not_found');
  });

  it('encryption key missing → failed + enqueued', async () => {
    const { db } = buildDb({
      delivery: { id: 'd1', status: 'queued', channel: 'email', attempt: 0, maxAttempts: 6, templateId: 't1', userId: 'u1', categoryId: 'c', locale: 'en', eventVariables: null },
      user: { email: 'u1@example.com' },
      relay: { id: 'r1', isDefault: 1 },
    });
    getTemplateMock.mockResolvedValue({ id: 't1', subjectTemplate: 's', bodyTemplate: 'b', bodyFormat: 'plaintext', variablesSchema: null, channel: 'email', locale: 'en', version: 1 });
    renderTemplateAsyncMock.mockResolvedValue({ subject: 's', body: 'b' });
    delete process.env.PLATFORM_ENCRYPTION_KEY;
    const r = await processDelivery('d1', { db });
    expect(r.status).toBe('failed');
    expect(r.error).toBe('platform_encryption_key_missing');
  });
});
