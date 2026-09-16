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

const { emitEvent, hasRecipient } = await import('./dispatch.js');

type Db = Parameters<typeof emitEvent>[0];

function mockDb(overrides: {
  userEmail?: string | null;
  dedupedExists?: boolean;
  dedupeChecked?: boolean;
  notificationsEnabled?: boolean;
} = {}): Db {
  // The dispatcher issues `select` for three distinct shapes, and this mock
  // branches on the PROJECTION rather than on call order:
  //   { notificationsEnabled } — the master kill switch
  //   { id }                   — dedupe check (only when opts.dedupeKey is set)
  //   { email }                — email lookup (per recipient × email channel)
  //
  // It used to key off a closure flag counting calls, which meant adding any
  // query ahead of the dedupe check silently handed the dedupe its row — the
  // kill-switch read did exactly that and turned a normal dispatch into a
  // "duplicate". Order-independent branching is the only version that survives
  // the next query being added.
  const select = vi.fn().mockImplementation((proj?: Record<string, unknown>) => {
    const keys = new Set(Object.keys(proj ?? {}));
    const rows = (): Promise<unknown[]> => {
      if (keys.has('notificationsEnabled')) {
        return Promise.resolve([{ notificationsEnabled: overrides.notificationsEnabled ?? true }]);
      }
      if (keys.has('id')) {
        return Promise.resolve(overrides.dedupedExists ? [{ id: 'existing-notif' }] : []);
      }
      if (overrides.userEmail === null) return Promise.resolve([]);
      return Promise.resolve([{ email: overrides.userEmail ?? 'u1@example.com' }]);
    };
    return {
      from: () => ({
        where: () => ({ limit: rows, then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => rows().then(res, rej) }),
      }),
    };
  });
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

  it('delivers nothing at all when the master switch is OFF', async () => {
    // The lever the operator lacked on 2026-09-16, when the only way to stop a
    // storm was editing notification_categories over psql, per category.
    getCategoryMock.mockResolvedValue(baseCategory);
    resolveRecipientsMock.mockResolvedValue(['u1', 'u2']);
    getActiveTemplateMock.mockResolvedValue(baseTemplate);
    const r = await emitEvent(mockDb({ notificationsEnabled: false }), {
      categoryId: 'tenant.suspended',
      scope: { kind: 'tenant', tenantId: 't1' },
      variables: {},
    });
    expect(r.deliveryCount).toBe(0);
    expect(r.perChannelStatuses.length).toBe(0);
    // Dropped BEFORE any channel work — no email, no queue job.
    expect(sendNotificationEmailMock).not.toHaveBeenCalled();
    expect(enqueueDeliveryMock).not.toHaveBeenCalled();
  });

  it('still delivers a MANDATORY category when the master switch is ON', async () => {
    // The positive control. Without it, "delivered nothing" above would pass
    // just as happily against a dispatcher that delivers nothing ever.
    getCategoryMock.mockResolvedValue(baseCategory);
    resolveRecipientsMock.mockResolvedValue(['u1']);
    getActiveTemplateMock.mockResolvedValue(baseTemplate);
    const r = await emitEvent(mockDb({ notificationsEnabled: true }), {
      categoryId: 'tenant.suspended',
      scope: { kind: 'tenant', tenantId: 't1' },
      variables: {},
      encryptionKey: 'KEY',
    });
    expect(r.deliveryCount).toBeGreaterThan(0);
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

  it('honours quiet hours for a category whose CLASS can wait', async () => {
    // subscription.renewed is class=record: a receipt genuinely can wait until
    // morning. (This test used to use tenant.suspended, which is class=security
    // and now correctly passes through — see the next case.)
    // The mocked category carries its own id, and the class lookup keys off
    // THAT — not off the categoryId passed to emitEvent. Setting only the
    // latter left both quiet-hours cases resolving to tenant.suspended.
    getCategoryMock.mockResolvedValue({
      ...baseCategory, id: 'subscription.renewed', isMandatory: false, defaultSeverity: 'info',
    });
    resolveRecipientsMock.mockResolvedValue(['u1']);
    isAllowedMock.mockResolvedValue(true);
    isInQuietHoursMock.mockReturnValue(true);
    const r = await emitEvent(mockDb(), {
      categoryId: 'subscription.renewed',
      scope: { kind: 'tenant', tenantId: 't1' },
      variables: {},
      encryptionKey: 'KEY',
    });
    expect(r.perChannelStatuses.every((s) => s.status === 'muted')).toBe(true);
  });

  it('lets a warning-severity SECURITY category through quiet hours', async () => {
    // The bug this fixes: the bypass was gated on severity alone, so
    // tenant.suspended (severity=warning, class=security) was held until
    // morning. A suspension notice that waits overnight is a support ticket.
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
    expect(r.perChannelStatuses.some((s) => s.status === 'muted')).toBe(false);
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

  it('DELIVERS through the envelope fallback when the template cannot render', async () => {
    // Behaviour change 2026-09-14. This used to persist status='skipped' and
    // stop: a render failure is deterministic, so retrying could not help and
    // dropping seemed like the honest outcome. It was not — `skipped` raises
    // no alert and is not in the retry scan, so one variable-name mismatch
    // silently cost `subscription.renewed` 16 emails and nobody found out
    // until a customer complained.
    //
    // A notification system whose failure mode is silence has no failure mode.
    // The message now goes out with whatever facts survived, and the row says
    // what was lost.
    getCategoryMock.mockResolvedValue(baseCategory);
    resolveRecipientsMock.mockResolvedValue(['u1']);
    isAllowedMock.mockResolvedValue(true);
    getActiveTemplateMock.mockResolvedValue(baseTemplate);
    renderTemplateMock.mockRejectedValue(new Error('hbs blew up'));
    const db = mockDb();
    const r = await emitEvent(db, {
      categoryId: 'tenant.suspended',
      scope: { kind: 'tenant', tenantId: 't1' },
      variables: {},
      encryptionKey: 'KEY',
    });

    // Nothing is skipped for a render failure any more.
    expect(r.perChannelStatuses.some((s) => s.status === 'skipped')).toBe(false);

    const inserted = (db.insert as ReturnType<typeof vi.fn>)().values.mock.calls.map((c: unknown[]) => c[0]);
    // The row survives as a real delivery...
    expect(inserted.some((v: Record<string, unknown>) => v.status === 'sent' || v.status === 'queued')).toBe(true);
    // ...and records WHY it is thin, so the Delivery Log can surface it.
    expect(inserted.some((v: Record<string, unknown>) =>
      String(v.lastError ?? '').startsWith('render_fallback:'))).toBe(true);
  });

  it('persists a skipped delivery row when no template exists', async () => {
    getCategoryMock.mockResolvedValue(baseCategory);
    resolveRecipientsMock.mockResolvedValue(['u1']);
    isAllowedMock.mockResolvedValue(true);
    getActiveTemplateMock.mockResolvedValue(null);
    const db = mockDb();
    await emitEvent(db, {
      categoryId: 'tenant.suspended',
      scope: { kind: 'tenant', tenantId: 't1' },
      variables: {},
      encryptionKey: 'KEY',
    });
    const inserted = (db.insert as ReturnType<typeof vi.fn>)().values.mock.calls.map((c: unknown[]) => c[0]);
    expect(inserted.some((v: Record<string, unknown>) =>
      v.status === 'skipped' && v.lastError === 'template_not_found')).toBe(true);
  });

  it('injects strict-mode-safe COMMON_VARS defaults; caller variables win; undefined → null', async () => {
    // Regression for the 2026-06-12 silent email loss: every emailMjml
    // seed template references {{platformName}}, which no dispatcher
    // call-site supplied — strict-mode Handlebars threw on the absent
    // key and the email vanished without a delivery row.
    getCategoryMock.mockResolvedValue(baseCategory);
    resolveRecipientsMock.mockResolvedValue(['u1']);
    isAllowedMock.mockResolvedValue(true);
    getActiveTemplateMock.mockResolvedValue(baseTemplate);
    await emitEvent(mockDb({ userEmail: 'alice@example.com' }), {
      categoryId: 'tenant.suspended',
      scope: { kind: 'tenant', tenantId: 't1' },
      variables: { tenantName: 'Acme', custom: undefined },
      encryptionKey: 'KEY',
    });
    expect(renderTemplateMock).toHaveBeenCalled();
    const vars = renderTemplateMock.mock.calls[0][1] as Record<string, unknown>;
    expect(vars.platformName).toBe('Hosting Platform'); // default injected
    expect(vars.userName).toBe('alice');                // email local part
    expect(vars.tenantName).toBe('Acme');               // caller wins
    expect(vars.custom).toBeNull();                     // undefined normalised (JSONB-safe)
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

describe('hasRecipient — the invariant that must NOT be a table CHECK', () => {
  it('accepts a platform user', () => {
    expect(hasRecipient({ userId: 'u1', channel: 'email' })).toBe(true);
  });

  it('accepts an account-less address (a mailbox owner)', () => {
    expect(hasRecipient({ userId: null, recipientAddress: 'user@example.test', channel: 'email' })).toBe(true);
  });

  it('accepts ntfy with neither — it is a topic broadcast, not an addressed delivery', () => {
    expect(hasRecipient({ userId: null, recipientAddress: null, channel: 'ntfy' })).toBe(true);
  });

  it('refuses a row with no recipient at all', () => {
    expect(hasRecipient({ userId: null, recipientAddress: null, channel: 'email' })).toBe(false);
  });

  // Why this is enforced in code and not in the schema: user_id is
  // ON DELETE SET NULL so the delivery audit row survives a GDPR erasure. A
  // historical row therefore legitimately has neither identifier, and a table
  // CHECK cannot distinguish that from a new row written with neither — it
  // just aborts. Proved on DEV: the constraint failed against 164 of 458 rows,
  // crash-looped the API, and left the migration half applied because the
  // ADD COLUMN before it had already committed.
  it('documents why an erased historical row is not a write-time violation', () => {
    const historical = { userId: null, recipientAddress: null, channel: 'email' };
    expect(hasRecipient(historical)).toBe(false); // would be refused if written TODAY
    // ...but it is never written today; it BECAME this by erasure, long after
    // the write. That asymmetry is exactly what a CHECK constraint cannot see.
  });
});
