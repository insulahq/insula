import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendNotificationEmailMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../email-sender.js', () => ({ sendNotificationEmail: sendNotificationEmailMock }));

const getActiveTemplateMock = vi.fn();
vi.mock('../templates/service.js', () => ({ getActiveTemplate: getActiveTemplateMock }));

const renderTemplateAsyncMock = vi.fn().mockResolvedValue({ subject: 's', body: 'b', bodyFormat: 'plaintext' });
vi.mock('../templates/renderer.js', () => ({
  renderTemplate: vi.fn(),
  renderTemplateAsync: renderTemplateAsyncMock,
}));

const { emailChannel } = await import('./email.js');

beforeEach(() => {
  sendNotificationEmailMock.mockClear();
  sendNotificationEmailMock.mockResolvedValue(undefined);
  getActiveTemplateMock.mockReset();
  renderTemplateAsyncMock.mockClear();
  renderTemplateAsyncMock.mockResolvedValue({ subject: 's', body: 'b', bodyFormat: 'plaintext' });
});

describe('emailChannel.deliver', () => {
  it('returns skipped when no encryption key configured', async () => {
    delete process.env.PLATFORM_ENCRYPTION_KEY;
    const r = await emailChannel.deliver({
      db: {} as never,
      notification: {
        id: 'n1', userId: 'u1', type: 'info', title: 't', message: 'm',
        resourceType: null, resourceId: null,
      },
    });
    expect(r.status).toBe('skipped');
  });

  it('falls back to legacy path when notification has no category', async () => {
    const r = await emailChannel.deliver({
      db: {} as never,
      notification: {
        id: 'n1', userId: 'u1', type: 'info', title: 't', message: 'm',
        resourceType: null, resourceId: null,
      },
      encryptionKey: 'K',
    });
    expect(r.status).toBe('delivered');
    expect(getActiveTemplateMock).not.toHaveBeenCalled();
    expect(sendNotificationEmailMock).toHaveBeenCalled();
    const args = sendNotificationEmailMock.mock.calls[0];
    expect(args[3]).toBeUndefined(); // no prerendered arg
  });

  it('renders category template when categoryId set', async () => {
    getActiveTemplateMock.mockResolvedValue({
      id: 'tpl-1',
      categoryId: 'tenant.suspended',
      channel: 'email',
      locale: 'en',
      subjectTemplate: 'S',
      bodyTemplate: 'B',
      bodyFormat: 'plaintext',
      variablesSchema: null,
      isActive: true,
      isSeed: true,
      version: 1,
      editedByUserId: null,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    const r = await emailChannel.deliver({
      db: {} as never,
      notification: {
        id: 'n1', userId: 'u1', type: 'info', title: 't', message: 'm',
        resourceType: null, resourceId: null,
        // Category id sneaks through via the wider record shape
        categoryId: 'tenant.suspended',
      } as never,
      encryptionKey: 'K',
    });
    expect(r.status).toBe('delivered');
    expect(getActiveTemplateMock).toHaveBeenCalledWith({}, 'tenant.suspended', 'email', 'en');
    expect(renderTemplateAsyncMock).toHaveBeenCalled();
    // Prerendered subject/body passed as 4th arg
    expect(sendNotificationEmailMock.mock.calls[0][3]).toMatchObject({ subject: 's', html: 'b' });
  });

  it('returns failed when email-sender throws', async () => {
    sendNotificationEmailMock.mockRejectedValue(new Error('SMTP down'));
    const r = await emailChannel.deliver({
      db: {} as never,
      notification: {
        id: 'n1', userId: 'u1', type: 'info', title: 't', message: 'm',
        resourceType: null, resourceId: null,
      },
      encryptionKey: 'K',
    });
    expect(r.status).toBe('failed');
  });

  it('isAvailable reflects env key presence', () => {
    delete process.env.PLATFORM_ENCRYPTION_KEY;
    expect(emailChannel.isAvailable()).toBe(false);
    process.env.PLATFORM_ENCRYPTION_KEY = 'K';
    expect(emailChannel.isAvailable()).toBe(true);
  });
});
