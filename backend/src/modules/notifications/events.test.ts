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


/**
 * These four events moved off the legacy notifyUsers path on 2026-09-15. They
 * were the last in-app-only tenant events on the platform — IMAPSync, DKIM
 * rotation, email-enabled and the mailbox limit — so none of them had EVER
 * reached a tenant by email. The assertions below check the categorised
 * dispatch; recipient fan-out is the dispatcher's job now, which is exactly
 * what gives these a template, an email leg and a delivery audit.
 */
function lastDispatch(): { categoryId: string; variables: Record<string, string> } {
  const call = emitEventMock.mock.calls.at(-1)?.[1] as {
    categoryId: string; variables: Record<string, string>;
  };
  return call;
}

describe('notification events', () => {
  beforeEach(() => {
    createNotificationMock.mockClear();
    emitEventMock.mockClear();
    sendNotificationEmailMock.mockClear();
    recipientsMock.mockClear();
    recipientsMock.mockResolvedValue(['u1', 'u2']);
  });

  describe('notifyTenantDkimRotated', () => {
    it('sends an info notification tagged with email_domain', async () => {
      await notifyTenantDkimRotated({} as never, 'c1', {
        emailDomainId: 'ed1',
        domainName: 'example.com',
        selector: 'default',
      });
      const d = lastDispatch();
      expect(d.categoryId).toBe('tenant.mail_event');
      expect(d.variables.subsystem).toMatch(/DKIM/i);
      expect(d.variables.objectLabel).toBe('example.com');
    });
  });

  describe('notifyTenantImapsyncTerminal', () => {
    it('fires a success notification on completed status', async () => {
      await notifyTenantImapsyncTerminal({} as never, 'c1', {
        jobId: 'j1',
        status: 'completed',
        messagesTransferred: 42,
      });
      const d = lastDispatch();
      expect(d.categoryId).toBe('tenant.mail_event');
      expect(d.variables.subsystem).toMatch(/IMAPSync/i);
      expect(d.variables.detail).toContain('42');
      expect(d.variables.objectLabel).toContain('j1');
    });

    it('fires an error notification on failed status', async () => {
      await notifyTenantImapsyncTerminal({} as never, 'c1', {
        jobId: 'j1',
        status: 'failed',
        errorMessage: 'auth failure',
      });
      const d = lastDispatch();
      expect(d.variables.severityLabel).toBe('failed');
      expect(d.variables.detail).toContain('auth failure');
    });

    it('does not fire for non-terminal status', async () => {
      await notifyTenantImapsyncTerminal({} as never, 'c1', {
        jobId: 'j1',
        status: 'running' as never,
      });
      expect(emitEventMock).not.toHaveBeenCalled();
    });
  });

  describe('notifyTenantEmailBootstrapped', () => {
    it('sends a success notification with the domain name', async () => {
      await notifyTenantEmailBootstrapped({} as never, 'c1', {
        emailDomainId: 'ed1',
        domainName: 'example.com',
      });
      const d = lastDispatch();
      expect(d.categoryId).toBe('tenant.mail_event');
      expect(d.variables.subsystem).toMatch(/email/i);
      expect(d.variables.objectLabel).toBe('example.com');
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
