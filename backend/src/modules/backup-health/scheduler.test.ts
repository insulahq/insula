import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runTick } from './scheduler.js';

// These fan-outs are dispatched now, not written per-admin. The legacy mock
// below stays only so the module graph resolves; the assertions read the
// categorised call, which is what carries the template, the email leg and the
// delivery audit the in-app-only path never had.
const notifyBackupFailedMock = vi.fn(async () => undefined);
const notifyOperationalMock = vi.fn(async () => undefined);
vi.mock('../notifications/events.js', () => ({
  notifyAdminBackupFailed: (...a: unknown[]) => notifyBackupFailedMock(...(a as [])),
  notifyAdminOperationalEvent: (...a: unknown[]) => notifyOperationalMock(...(a as [])),
}));
vi.mock('../notifications/service.js', () => ({
  notifyUsers: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../notifications/recipients.js', () => ({
  resolveRecipients: vi.fn(),
}));
vi.mock('./service.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    listHealthWatchedJobs: vi.fn(),
  };
});

import { notifyUsers } from '../notifications/service.js';
import { resolveRecipients } from '../notifications/recipients.js';
import { listHealthWatchedJobs } from './service.js';

const notifyUsersMock = notifyUsers as unknown as ReturnType<typeof vi.fn>;
const resolveRecipientsMock = resolveRecipients as unknown as ReturnType<typeof vi.fn>;
const listJobsMock = listHealthWatchedJobs as unknown as ReturnType<typeof vi.fn>;

const FAILED_DR_JOB = {
  uid: 'uid-1',
  name: 'platform-pg-backup-1',
  namespace: 'platform',
  groupKey: 'platform-pg-backup',
  displayName: 'platform-pg-backup',
  category: 'dr' as const,
  severity: 'critical' as const,
  tenantId: null,
  state: 'failed' as const,
  startedAt: new Date('2026-04-27T00:00:00Z'),
  completedAt: null,
  failureReason: 'oops',
};

const FAILED_TENANT_JOB = {
  uid: 'uid-2',
  name: 'tenant-snap-1',
  namespace: 'tenant-abc',
  groupKey: 'tenant-snap',
  displayName: 'Tenant snapshot',
  category: 'tenant' as const,
  severity: 'warning' as const,
  tenantId: 'tenant-abc',
  state: 'failed' as const,
  startedAt: new Date('2026-04-27T00:00:00Z'),
  completedAt: null,
  failureReason: null,
};

function mockDb(notifiedUids: string[]) {
  const whereFn = vi.fn().mockResolvedValue(
    notifiedUids.map((uid) => ({ resourceId: uid })),
  );
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  return { select: selectFn } as never;
}

const NOOP_LOG = { warn: vi.fn() };

describe('runTick', () => {
  beforeEach(() => {
    notifyUsersMock.mockClear();
    notifyBackupFailedMock.mockClear();
    notifyOperationalMock.mockClear();
    resolveRecipientsMock.mockReset();
    listJobsMock.mockReset();
    NOOP_LOG.warn.mockClear();
  });

  it('dispatches admin recipients for DR-category failures (no tenant-id)', async () => {
    listJobsMock.mockResolvedValue([FAILED_DR_JOB]);
    resolveRecipientsMock.mockResolvedValue(['admin-1']);

    await runTick(mockDb([]), {} as never, NOOP_LOG);

    expect(resolveRecipientsMock).toHaveBeenCalledWith(expect.anything(), {
      kind: 'admin',
    });
    // ONE categorised dispatch; the dispatcher owns recipient fan-out.
    expect(notifyBackupFailedMock).toHaveBeenCalledOnce();
    const [, payload] = notifyBackupFailedMock.mock.calls[0]! as unknown[];
    const p = payload as Record<string, string>;
    expect(p.backupName).toBeTruthy();
    expect(p.errorMessage).toBeTruthy();
  });

  it('dispatches tenant_admin recipients for tenant-category failures (with tenant-id)', async () => {
    listJobsMock.mockResolvedValue([FAILED_TENANT_JOB]);
    resolveRecipientsMock.mockResolvedValue(['tenant-admin-1']);

    await runTick(mockDb([]), {} as never, NOOP_LOG);

    expect(resolveRecipientsMock).toHaveBeenCalledWith(expect.anything(), {
      kind: 'tenant',
      tenantId: 'tenant-abc',
    });
    expect(notifyBackupFailedMock).toHaveBeenCalledOnce();
  });

  it('skips already-notified UIDs (dedup via resourceId lookup)', async () => {
    listJobsMock.mockResolvedValue([FAILED_DR_JOB, FAILED_TENANT_JOB]);
    resolveRecipientsMock.mockResolvedValue(['someone']);
    await runTick(mockDb(['uid-1']), {} as never, NOOP_LOG);
    expect(notifyBackupFailedMock).toHaveBeenCalledTimes(1);
    const [, , dedupeKey] = notifyBackupFailedMock.mock.calls[0]! as unknown[];
    expect(String(dedupeKey)).toContain('uid-2');
  });

  it('logs and skips when no recipients are resolvable (avoids ghost rows)', async () => {
    listJobsMock.mockResolvedValue([FAILED_DR_JOB]);
    resolveRecipientsMock.mockResolvedValue([]);
    await runTick(mockDb([]), {} as never, NOOP_LOG);
    expect(notifyBackupFailedMock).not.toHaveBeenCalled();
    expect(NOOP_LOG.warn).toHaveBeenCalledOnce();
  });

  it('caps failure-reason length at 500 chars to keep notifications scannable', async () => {
    const longReason = 'x'.repeat(2000);
    listJobsMock.mockResolvedValue([{ ...FAILED_DR_JOB, failureReason: longReason }]);
    resolveRecipientsMock.mockResolvedValue(['admin']);
    await runTick(mockDb([]), {} as never, NOOP_LOG);
    const [, payload] = notifyBackupFailedMock.mock.calls[0]! as unknown[];
    expect((payload as Record<string, string>).errorMessage).toContain('xxx');
    expect((payload as Record<string, string>).errorMessage.length).toBeLessThan(700);
  });

  it('returns silently when no jobs are returned', async () => {
    listJobsMock.mockResolvedValue([]);
    await runTick(mockDb([]), {} as never, NOOP_LOG);
    expect(notifyBackupFailedMock).not.toHaveBeenCalled();
  });
});
