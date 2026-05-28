import { describe, it, expect, vi, beforeEach } from 'vitest';

const createNotificationMock = vi.fn().mockResolvedValue({ id: 'n1', userId: 'u1', type: 'warning', title: 't', message: 'm' });
const sendNotificationEmailMock = vi.fn().mockResolvedValue(undefined);

vi.mock('./service.js', async () => {
  return {
    createNotification: createNotificationMock,
    notifyUser: async (
      _db: unknown,
      userId: string,
      opts: {
        type: 'info' | 'warning' | 'error' | 'success';
        title: string;
        message: string;
        resourceType?: string | null;
        resourceId?: string | null;
      },
    ) => {
      await createNotificationMock({ userId, ...opts });
    },
    notifyUsers: async (
      _db: unknown,
      userIds: readonly string[],
      opts: {
        type: 'info' | 'warning' | 'error' | 'success';
        title: string;
        message: string;
        resourceType?: string | null;
        resourceId?: string | null;
      },
    ) => {
      for (const uid of userIds) {
        await createNotificationMock({ userId: uid, ...opts });
      }
    },
  };
});

vi.mock('./email-sender.js', () => ({
  sendNotificationEmail: sendNotificationEmailMock,
}));

// Mock recipients helper so the fan-out path is deterministic.
const recipientsMock = vi.fn().mockResolvedValue(['u1', 'u2']);
vi.mock('./recipients.js', () => ({
  getTenantNotificationRecipients: recipientsMock,
}));

// Phase 1 dispatcher mock — every new helper goes through emitEvent.
const emitEventMock = vi.fn().mockResolvedValue({ eventId: 'e1', deliveryCount: 0, perChannelStatuses: [] });
vi.mock('./dispatcher/dispatch.js', () => ({ emitEvent: emitEventMock }));

const {
  notifyTenantMailboxLimitReached,
  notifyTenantDkimRotated,
  notifyTenantImapsyncTerminal,
  notifyTenantEmailBootstrapped,
  notifyTenantSubscriptionChanged,
  notifyTenantSubscriptionExpiry,
  notifyTenantSubAccountAdded,
  notifyTenantPasswordChanged,
  notifyTenantSuspiciousActivity,
  notifyAdminCertExpiring,
  notifyAdminCertRenewalFailed,
  notifyAdminBackupFailed,
  notifyAdminBackupTargetUnreachable,
  notifyAdminNodeDown,
  notifyAdminSecurityHardeningDrift,
} = await import('./events.js');

describe('notification events', () => {
  beforeEach(() => {
    createNotificationMock.mockClear();
    sendNotificationEmailMock.mockClear();
    recipientsMock.mockClear();
    recipientsMock.mockResolvedValue(['u1', 'u2']);
  });

  describe('notifyTenantMailboxLimitReached', () => {
    it('fans out to all tenant_admin users with an error-level notification', async () => {
      await notifyTenantMailboxLimitReached({} as never, 'c1', {
        limit: 10,
        current: 10,
        source: 'plan',
      });
      expect(recipientsMock).toHaveBeenCalledWith({}, 'c1');
      expect(createNotificationMock).toHaveBeenCalledTimes(2);
      const firstCall = createNotificationMock.mock.calls[0][0];
      expect(firstCall.userId).toBe('u1');
      expect(firstCall.type).toBe('error');
      expect(firstCall.title).toMatch(/Mailbox limit/i);
      expect(firstCall.message).toContain('10');
      expect(firstCall.resourceType).toBe('tenant');
      expect(firstCall.resourceId).toBe('c1');
    });

    it('silently skips when the tenant has no admins', async () => {
      recipientsMock.mockResolvedValue([]);
      await notifyTenantMailboxLimitReached({} as never, 'c1', {
        limit: 10,
        current: 10,
        source: 'plan',
      });
      expect(createNotificationMock).not.toHaveBeenCalled();
    });
  });

  describe('notifyTenantDkimRotated', () => {
    it('sends an info notification tagged with email_domain', async () => {
      await notifyTenantDkimRotated({} as never, 'c1', {
        emailDomainId: 'ed1',
        domainName: 'example.com',
        selector: 'default',
      });
      expect(createNotificationMock).toHaveBeenCalledTimes(2);
      const call = createNotificationMock.mock.calls[0][0];
      expect(call.type).toBe('info');
      expect(call.title).toMatch(/DKIM/i);
      expect(call.message).toContain('example.com');
      expect(call.resourceType).toBe('email_domain');
      expect(call.resourceId).toBe('ed1');
    });
  });

  describe('notifyTenantImapsyncTerminal', () => {
    it('fires a success notification on completed status', async () => {
      await notifyTenantImapsyncTerminal({} as never, 'c1', {
        jobId: 'j1',
        status: 'completed',
        messagesTransferred: 42,
      });
      const call = createNotificationMock.mock.calls[0][0];
      expect(call.type).toBe('success');
      expect(call.title).toMatch(/IMAPSync/i);
      expect(call.message).toContain('42');
      expect(call.resourceType).toBe('imapsync_job');
      expect(call.resourceId).toBe('j1');
    });

    it('fires an error notification on failed status', async () => {
      await notifyTenantImapsyncTerminal({} as never, 'c1', {
        jobId: 'j1',
        status: 'failed',
        errorMessage: 'auth failure',
      });
      const call = createNotificationMock.mock.calls[0][0];
      expect(call.type).toBe('error');
      expect(call.message).toContain('auth failure');
    });

    it('does not fire for non-terminal status', async () => {
      await notifyTenantImapsyncTerminal({} as never, 'c1', {
        jobId: 'j1',
        status: 'running' as never,
      });
      expect(createNotificationMock).not.toHaveBeenCalled();
    });
  });

  describe('notifyTenantEmailBootstrapped', () => {
    it('sends a success notification with the domain name', async () => {
      await notifyTenantEmailBootstrapped({} as never, 'c1', {
        emailDomainId: 'ed1',
        domainName: 'example.com',
      });
      const call = createNotificationMock.mock.calls[0][0];
      expect(call.type).toBe('success');
      expect(call.title).toMatch(/enabled|email/i);
      expect(call.message).toContain('example.com');
      expect(call.resourceType).toBe('email_domain');
      expect(call.resourceId).toBe('ed1');
    });
  });

  // ─── Phase 1 categorised dispatchers ─────────────────────────────────────

  describe('Phase 1 categorised event helpers', () => {
    beforeEach(() => emitEventMock.mockClear());

    it('notifyTenantSubscriptionChanged emits subscription.changed', async () => {
      await notifyTenantSubscriptionChanged({} as never, 't1', { tenantName: 'X' });
      expect(emitEventMock).toHaveBeenCalledWith({}, expect.objectContaining({
        categoryId: 'subscription.changed',
        scope: { kind: 'tenant', tenantId: 't1' },
        tenantId: 't1',
      }));
    });

    it('notifyTenantSubscriptionExpiry emits subscription.expiry_warning', async () => {
      await notifyTenantSubscriptionExpiry({} as never, 't1', { expiresAt: '2026-12-31' });
      expect(emitEventMock).toHaveBeenCalledWith({}, expect.objectContaining({
        categoryId: 'subscription.expiry_warning',
      }));
    });

    it('notifyTenantSubAccountAdded emits account.sub_account_added', async () => {
      await notifyTenantSubAccountAdded({} as never, 't1', { subAccountEmail: 'x@y.com' });
      expect(emitEventMock).toHaveBeenCalledWith({}, expect.objectContaining({
        categoryId: 'account.sub_account_added',
      }));
    });

    it('notifyTenantPasswordChanged emits security.password_changed at user scope', async () => {
      await notifyTenantPasswordChanged({} as never, 'u1');
      expect(emitEventMock).toHaveBeenCalledWith({}, expect.objectContaining({
        categoryId: 'security.password_changed',
        scope: { kind: 'user', userId: 'u1' },
      }));
    });

    it('notifyTenantSuspiciousActivity emits security.suspicious_activity', async () => {
      await notifyTenantSuspiciousActivity({} as never, 'u1', { newIp: '203.0.113.7' });
      expect(emitEventMock).toHaveBeenCalledWith({}, expect.objectContaining({
        categoryId: 'security.suspicious_activity',
      }));
    });

    it('notifyAdminCertExpiring emits admin.cert_expiring', async () => {
      await notifyAdminCertExpiring({} as never, { certSubject: 'CN=foo', expiresAt: '2027-01-01' });
      expect(emitEventMock).toHaveBeenCalledWith({}, expect.objectContaining({
        categoryId: 'admin.cert_expiring',
        scope: { kind: 'admin' },
      }));
    });

    it('admin helpers emit their respective categories', async () => {
      await notifyAdminCertRenewalFailed({} as never, { certSubject: 'CN=x' });
      await notifyAdminBackupFailed({} as never, { backupName: 'b1' });
      await notifyAdminBackupTargetUnreachable({} as never, { targetName: 'ovh' });
      await notifyAdminNodeDown({} as never, { nodeName: 'staging1' });
      await notifyAdminSecurityHardeningDrift({} as never, { nodeName: 'staging1' });
      const cats = emitEventMock.mock.calls.map((c) => (c[1] as { categoryId: string }).categoryId);
      expect(cats).toEqual([
        'admin.cert_renewal_failed',
        'admin.backup_failed',
        'admin.backup_target_unreachable',
        'admin.node_down',
        'admin.security_hardening_drift',
      ]);
    });

    it('swallows dispatcher errors (legacy contract: never throw)', async () => {
      emitEventMock.mockRejectedValueOnce(new Error('boom'));
      await expect(
        notifyAdminNodeDown({} as never, { nodeName: 'staging1' }),
      ).resolves.toBeUndefined();
    });
  });
});
