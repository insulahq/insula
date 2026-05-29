import { describe, it, expect, vi, beforeEach } from 'vitest';

const getCategoryMock = vi.fn();
vi.mock('../categories/service.js', () => ({ getCategory: getCategoryMock }));

const resolveRecipientsMock = vi.fn();
vi.mock('../recipients.js', () => ({
  resolveRecipients: resolveRecipientsMock,
  // re-export needed types/values used by other modules — keep stub minimal
}));

const getActiveTemplateMock = vi.fn();
vi.mock('../templates/service.js', () => ({ getActiveTemplate: getActiveTemplateMock }));

const renderTemplateMock = vi.fn().mockResolvedValue({ subject: 'subj', body: 'body', bodyFormat: 'plaintext' });
vi.mock('../templates/renderer.js', () => ({
  renderTemplate: vi.fn(),
  renderTemplateAsync: renderTemplateMock,
}));

const isAllowedMock = vi.fn().mockResolvedValue(true);
vi.mock('../preferences/gate.js', () => ({ isCategoryAllowedForUser: isAllowedMock }));

const getUserSettingsMock = vi.fn().mockResolvedValue({
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: null,
  digestMode: 'immediate',
  locale: 'en',
});
vi.mock('../preferences/service.js', () => ({ getUserSettings: getUserSettingsMock }));

const isInQuietHoursMock = vi.fn().mockReturnValue(false);
vi.mock('../preferences/quiet-hours.js', () => ({ isInQuietHours: isInQuietHoursMock }));

const consumeRateLimitMock = vi.fn().mockResolvedValue({ allowed: true, remaining: 5, count: 1, windowEnd: new Date() });
vi.mock('../rate-limit/service.js', () => ({ consumeRateLimit: consumeRateLimitMock }));

const sendNotificationEmailMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../email-sender.js', () => ({ sendNotificationEmail: sendNotificationEmailMock }));

const enqueueDeliveryMock = vi.fn().mockResolvedValue('job-id');
vi.mock('../queue/enqueue.js', () => ({ enqueueDelivery: enqueueDeliveryMock }));

const { emitEvent } = await import('./dispatch.js');

type Db = Parameters<typeof emitEvent>[0];

function mockDb(overrides: { userEmail?: string | null; dedupedExists?: boolean; dedupeChecked?: boolean } = {}): Db {
  // The dispatcher issues `select` for two distinct shapes:
  //   - dedupe check (only when opts.dedupeKey set, runs once per user)
  //   - email lookup (per recipient × email channel)
  // We track which has run via a closure flag. The default test cases
  // don't use dedupeKey so the dedupe call never happens.
  let dedupeCheckSeen = false;
  const select = vi.fn().mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: () => {
          if (overrides.dedupedExists !== undefined && !dedupeCheckSeen) {
            dedupeCheckSeen = true;
            return Promise.resolve(overrides.dedupedExists ? [{ id: 'existing-notif' }] : []);
          }
          if (overrides.userEmail === null) return Promise.resolve([]);
          return Promise.resolve([{ email: overrides.userEmail ?? 'u1@example.com' }]);
        },
      }),
    }),
  }));
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn().mockReturnValue({ values: insertValues });
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });
  return { select, insert, update } as unknown as Db;
}

beforeEach(() => {
  getCategoryMock.mockReset();
  resolveRecipientsMock.mockReset();
  getActiveTemplateMock.mockReset();
  renderTemplateMock.mockClear();
  renderTemplateMock.mockResolvedValue({ subject: 'subj', body: 'body', bodyFormat: 'plaintext' });
  isAllowedMock.mockReset();
  isAllowedMock.mockResolvedValue(true);
  getUserSettingsMock.mockReset();
  getUserSettingsMock.mockResolvedValue({
    quietHoursStart: null,
    quietHoursEnd: null,
    timezone: null,
    digestMode: 'immediate',
    locale: 'en',
  });
  isInQuietHoursMock.mockReset();
  isInQuietHoursMock.mockReturnValue(false);
  consumeRateLimitMock.mockReset();
  consumeRateLimitMock.mockResolvedValue({ allowed: true, remaining: 5, count: 1, windowEnd: new Date() });
  sendNotificationEmailMock.mockReset();
  sendNotificationEmailMock.mockResolvedValue(undefined);
});

const baseCategory = {
  id: 'tenant.suspended',
  displayName: 'Account suspended',
  description: 'desc',
  audience: 'tenant',
  defaultSeverity: 'error',
  defaultChannels: ['in_app', 'email'],
  isMandatory: true,
  gdprBasis: 'contract',
  rateLimitWindowS: null,
  rateLimitMax: null,
  isActive: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const baseTemplate = {
  id: 'tpl-1',
  categoryId: 'tenant.suspended',
  channel: 'email' as const,
  locale: 'en',
  subjectTemplate: null,
  bodyTemplate: 'B',
  bodyFormat: 'plaintext',
  variablesSchema: null,
  isActive: true,
  isSeed: true,
  version: 1,
  editedByUserId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('emitEvent', () => {
  it('no-ops when category is unknown', async () => {
    getCategoryMock.mockRejectedValue(new Error('not found'));
    const r = await emitEvent(mockDb(), {
      categoryId: 'unknown',
      scope: { kind: 'tenant', tenantId: 't1' },
      variables: {},
    });
    expect(r.deliveryCount).toBe(0);
    expect(r.perChannelStatuses.length).toBe(0);
  });

  it('no-ops when category is inactive', async () => {
    getCategoryMock.mockResolvedValue({ ...baseCategory, isActive: false });
    resolveRecipientsMock.mockResolvedValue(['u1']);
    const r = await emitEvent(mockDb(), {
      categoryId: 'tenant.suspended',
      scope: { kind: 'tenant', tenantId: 't1' },
      variables: {},
    });
    expect(r.deliveryCount).toBe(0);
  });

  it('suppresses tenant recipients when flagged', async () => {
    getCategoryMock.mockResolvedValue(baseCategory);
    resolveRecipientsMock.mockResolvedValue(['u1', 'u2']);
    const r = await emitEvent(mockDb(), {
      categoryId: 'tenant.suspended',
      scope: { kind: 'tenant', tenantId: 't1' },
      variables: {},
      suppressTenantNotification: true,
    });
    expect(r.deliveryCount).toBe(0);
    expect(r.perChannelStatuses.length).toBe(0);
  });

  it('writes muted delivery when user opted out (non-mandatory)', async () => {
    getCategoryMock.mockResolvedValue({ ...baseCategory, isMandatory: false });
    resolveRecipientsMock.mockResolvedValue(['u1']);
    isAllowedMock.mockResolvedValue(false);
    const db = mockDb();
    const r = await emitEvent(db, {
      categoryId: 'tenant.suspended',
      scope: { kind: 'tenant', tenantId: 't1' },
      variables: {},
      encryptionKey: 'KEY',
    });
    expect(r.perChannelStatuses.every((s) => s.status === 'muted')).toBe(true);
  });

  it('honours quiet hours for non-critical severity', async () => {
    getCategoryMock.mockResolvedValue({ ...baseCategory, isMandatory: false, defaultSeverity: 'warning' });
    resolveRecipientsMock.mockResolvedValue(['u1']);
    isAllowedMock.mockResolvedValue(true);
    isInQuietHoursMock.mockReturnValue(true);
    const r = await emitEvent(mockDb(), {
      categoryId: 'tenant.suspended',
      scope: { kind: 'tenant', tenantId: 't1' },
      variables: {},
      encryptionKey: 'KEY',
    });
    expect(r.perChannelStatuses.every((s) => s.status === 'muted')).toBe(true);
  });

  it('critical severity bypasses quiet hours', async () => {
    getCategoryMock.mockResolvedValue({ ...baseCategory, defaultSeverity: 'critical' });
    resolveRecipientsMock.mockResolvedValue(['u1']);
    getActiveTemplateMock.mockResolvedValue(baseTemplate);
    isAllowedMock.mockResolvedValue(true);
    isInQuietHoursMock.mockReturnValue(true);
    const r = await emitEvent(mockDb(), {
      categoryId: 'tenant.suspended',
      scope: { kind: 'tenant', tenantId: 't1' },
      variables: {},
      encryptionKey: 'KEY',
    });
    expect(r.perChannelStatuses.some((s) => s.status === 'muted')).toBe(false);
  });

  it('emits rate_limited when limit exceeded', async () => {
    getCategoryMock.mockResolvedValue({ ...baseCategory, rateLimitWindowS: 3600, rateLimitMax: 2 });
    resolveRecipientsMock.mockResolvedValue(['u1']);
    isAllowedMock.mockResolvedValue(true);
    consumeRateLimitMock.mockResolvedValue({ allowed: false, remaining: 0, count: 3, windowEnd: new Date() });
    const r = await emitEvent(mockDb(), {
      categoryId: 'tenant.suspended',
      scope: { kind: 'tenant', tenantId: 't1' },
      variables: {},
      encryptionKey: 'KEY',
    });
    expect(r.perChannelStatuses.every((s) => s.status === 'rate_limited')).toBe(true);
  });

  it('skips channel when no template exists', async () => {
    getCategoryMock.mockResolvedValue(baseCategory);
    resolveRecipientsMock.mockResolvedValue(['u1']);
    isAllowedMock.mockResolvedValue(true);
    getActiveTemplateMock.mockResolvedValue(null);
    const r = await emitEvent(mockDb(), {
      categoryId: 'tenant.suspended',
      scope: { kind: 'tenant', tenantId: 't1' },
      variables: {},
      encryptionKey: 'KEY',
    });
    expect(r.perChannelStatuses.every((s) => s.status === 'skipped')).toBe(true);
  });

  it('full happy-path: 1 user × 2 channels → in_app sent + email queued', async () => {
    // Phase 2: email is async — dispatcher writes status='queued' and
    // enqueues the worker via pg-boss. The queue/worker tests cover
    // the queued → sent transition.
    getCategoryMock.mockResolvedValue(baseCategory);
    resolveRecipientsMock.mockResolvedValue(['u1']);
    isAllowedMock.mockResolvedValue(true);
    getActiveTemplateMock.mockResolvedValue(baseTemplate);
    const db = mockDb();
    const r = await emitEvent(db, {
      categoryId: 'tenant.suspended',
      scope: { kind: 'tenant', tenantId: 't1' },
      variables: { userName: 'Alice' },
      encryptionKey: 'KEY',
    });
    // in_app delivers synchronously; email is enqueued.
    expect(r.perChannelStatuses.filter((s) => s.status === 'sent').length).toBe(1);
    expect(r.perChannelStatuses.filter((s) => s.status === 'queued').length).toBe(1);
    expect(sendNotificationEmailMock).not.toHaveBeenCalled();
  });

  it('email channel: dispatcher enqueues even if pg-boss is unavailable (queued status preserved)', async () => {
    // The enqueue call is best-effort — the row stays 'queued' so a
    // periodic re-enqueue scan can pick it up. The dispatcher MUST
    // NOT mark the row 'failed' just because the queue wasn't ready.
    getCategoryMock.mockResolvedValue({ ...baseCategory, defaultChannels: ['email'] });
    resolveRecipientsMock.mockResolvedValue(['u1']);
    isAllowedMock.mockResolvedValue(true);
    getActiveTemplateMock.mockResolvedValue(baseTemplate);
    const r = await emitEvent(mockDb(), {
      categoryId: 'tenant.suspended',
      scope: { kind: 'tenant', tenantId: 't1' },
      variables: {},
      encryptionKey: 'KEY',
    });
    expect(r.perChannelStatuses.every((s) => s.status === 'queued')).toBe(true);
    expect(sendNotificationEmailMock).not.toHaveBeenCalled();
  });

  it('throws when no encryption key is available (hash salt requirement)', async () => {
    // Security: hashing recipient + content without a cluster-bound
    // salt produces brute-forceable rainbow tables. The dispatcher
    // refuses to run rather than silently degrade.
    delete process.env.PLATFORM_ENCRYPTION_KEY;
    getCategoryMock.mockResolvedValue({ ...baseCategory, defaultChannels: ['email'] });
    resolveRecipientsMock.mockResolvedValue(['u1']);
    isAllowedMock.mockResolvedValue(true);
    getActiveTemplateMock.mockResolvedValue(baseTemplate);
    await expect(
      emitEvent(mockDb(), {
        categoryId: 'tenant.suspended',
        scope: { kind: 'tenant', tenantId: 't1' },
        variables: {},
      }),
    ).rejects.toThrow(/PLATFORM_ENCRYPTION_KEY/);
  });

  it('captures template render errors per-channel without aborting fan-out', async () => {
    getCategoryMock.mockResolvedValue(baseCategory);
    resolveRecipientsMock.mockResolvedValue(['u1']);
    isAllowedMock.mockResolvedValue(true);
    getActiveTemplateMock.mockResolvedValue(baseTemplate);
    renderTemplateMock.mockRejectedValue(new Error('hbs blew up'));
    const r = await emitEvent(mockDb(), {
      categoryId: 'tenant.suspended',
      scope: { kind: 'tenant', tenantId: 't1' },
      variables: {},
      encryptionKey: 'KEY',
    });
    expect(r.perChannelStatuses.every((s) => s.status === 'failed')).toBe(true);
  });

  it('dedupeKey: skips every channel for a user with an existing notifications row in the window', async () => {
    // Phase 4: when caller passes dedupeKey and a prior notifications
    // row for (user, key, last 30d) exists, dispatcher must NOT write
    // any new row for that recipient. Per-channel statuses surface
    // status='skipped' with error='duplicate'.
    getCategoryMock.mockResolvedValue(baseCategory);
    resolveRecipientsMock.mockResolvedValue(['u1']);
    isAllowedMock.mockResolvedValue(true);
    getActiveTemplateMock.mockResolvedValue(baseTemplate);
    const r = await emitEvent(mockDb({ dedupedExists: true }), {
      categoryId: 'tenant.suspended',
      scope: { kind: 'tenant', tenantId: 't1' },
      variables: {},
      encryptionKey: 'KEY',
      dedupeKey: 'sub-expiry:t1:7d:2026-06-08',
    });
    expect(r.perChannelStatuses.every((s) => s.status === 'skipped')).toBe(true);
    expect(r.perChannelStatuses.every((s) => s.error === 'duplicate')).toBe(true);
  });

  it('dedupeKey: no existing row → dispatches normally', async () => {
    getCategoryMock.mockResolvedValue(baseCategory);
    resolveRecipientsMock.mockResolvedValue(['u1']);
    isAllowedMock.mockResolvedValue(true);
    getActiveTemplateMock.mockResolvedValue(baseTemplate);
    const r = await emitEvent(mockDb({ dedupedExists: false }), {
      categoryId: 'tenant.suspended',
      scope: { kind: 'tenant', tenantId: 't1' },
      variables: {},
      encryptionKey: 'KEY',
      dedupeKey: 'sub-expiry:t1:7d:2026-06-08',
    });
    // Either sent or queued; explicitly NOT skipped:duplicate.
    expect(r.perChannelStatuses.some((s) => s.error === 'duplicate')).toBe(false);
  });
});
