/**
 * Unit tests for the CNPG backup-failure notification scheduler.
 *
 * Mocks the readBackupHealth service + the notifications recipients
 * + the notifyUsers fan-out so we test the scheduler logic in isolation
 * (no real K8s API, no real DB, no real notification deliveries).
 */
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
    readBackupHealth: vi.fn(),
  };
});

import { notifyUsers } from '../notifications/service.js';
import { resolveRecipients } from '../notifications/recipients.js';
import { readBackupHealth, type ClusterBackupHealth } from './service.js';

const notifyUsersMock = notifyUsers as unknown as ReturnType<typeof vi.fn>;
const resolveRecipientsMock = resolveRecipients as unknown as ReturnType<typeof vi.fn>;
const readHealthMock = readBackupHealth as unknown as ReturnType<typeof vi.fn>;

const NOOP_LOG = { warn: vi.fn(), info: vi.fn() };

function mockDb(notifiedKeys: string[]) {
  const whereFn = vi.fn().mockResolvedValue(
    notifiedKeys.map((id) => ({ resourceId: id })),
  );
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  return { select: selectFn } as never;
}

const HEALTHY: ClusterBackupHealth = {
  clusterName: 'system-db',
  namespace: 'platform',
  state: 'healthy',
  lastSuccessfulBackup: {
    name: 'system-db-daily-1',
    namespace: 'platform',
    clusterName: 'system-db',
    method: 'barmanObjectStore',
    phase: 'completed',
    startedAt: '2026-05-06T10:00:00Z',
    stoppedAt: '2026-05-06T10:01:00Z',
    error: null,
  },
  mostRecentFailure: null,
  lastSuccessSecondsAgo: 3600,
  scheduledBackups: ['system-db-daily'],
  clusterHasBackupSpec: true,
};

const FAILING: ClusterBackupHealth = {
  clusterName: 'system-db',
  namespace: 'platform',
  state: 'failing',
  lastSuccessfulBackup: HEALTHY.lastSuccessfulBackup,
  mostRecentFailure: {
    name: 'system-db-daily-2',
    namespace: 'platform',
    clusterName: 'system-db',
    method: 'barmanObjectStore',
    phase: 'failed',
    startedAt: '2026-05-07T03:15:00Z',
    stoppedAt: '2026-05-07T03:15:30Z',
    error: 'cannot proceed with the backup as the cluster has no backup section',
  },
  lastSuccessSecondsAgo: 17 * 3600,
  scheduledBackups: ['system-db-daily'],
  clusterHasBackupSpec: true,
};

describe('cnpg-backup-health scheduler runTick', () => {
  beforeEach(() => {
    notifyUsersMock.mockClear();
    notifyBackupFailedMock.mockClear();
    notifyOperationalMock.mockClear();
    resolveRecipientsMock.mockReset();
    readHealthMock.mockReset();
    NOOP_LOG.warn.mockClear();
    NOOP_LOG.info.mockClear();
  });

  it('healthy snapshot → no notifications', async () => {
    readHealthMock.mockResolvedValue([HEALTHY]);
    resolveRecipientsMock.mockResolvedValue(['admin-1']);

    await runTick(mockDb([]), {} as never, NOOP_LOG);

    expect(notifyBackupFailedMock).not.toHaveBeenCalled();
  });

  it('newly-failed Backup CR → one admin notification', async () => {
    readHealthMock.mockResolvedValue([FAILING]);
    resolveRecipientsMock.mockResolvedValue(['admin-1', 'admin-2']);

    await runTick(mockDb([]), {} as never, NOOP_LOG);

    // ONE categorised dispatch; recipient fan-out belongs to the dispatcher,
    // which is what gives a failed DATABASE BACKUP a template, an email leg
    // and a delivery audit it did not have on the in-app-only path.
    expect(notifyBackupFailedMock).toHaveBeenCalledOnce();
    const [, payload, dedupeKey] = notifyBackupFailedMock.mock.calls[0]! as unknown[];
    const p = payload as Record<string, string>;
    // Identity: which backup, on which cluster.
    expect(p.backupName).toContain('platform/system-db-daily-2');
    expect(p.backupName).toContain('platform/system-db');
    expect(p.errorMessage).toContain('no backup section');
    // dedupe key = `<namespace>/<backup-name>`
    expect(dedupeKey).toBe('cnpg-backup-failed:platform/system-db-daily-2');
  });

  it('already-notified failure → dedup, no second notification', async () => {
    readHealthMock.mockResolvedValue([FAILING]);
    // Pre-load the dedup table so this Backup CR is already known
    await runTick(mockDb(['platform/system-db-daily-2']), {} as never, NOOP_LOG);

    expect(notifyBackupFailedMock).not.toHaveBeenCalled();
    expect(resolveRecipientsMock).not.toHaveBeenCalled();
  });

  it('multiple clusters failing → one notification per Backup CR', async () => {
    const AUX_FAILING: ClusterBackupHealth = {
      ...FAILING,
      clusterName: 'postgres-aux',
      namespace: 'platform',
      mostRecentFailure: {
        ...FAILING.mostRecentFailure!,
        name: 'postgres-aux-system-backup-3',
        namespace: 'platform',
        clusterName: 'postgres-aux',
      },
    };
    readHealthMock.mockResolvedValue([FAILING, AUX_FAILING]);
    resolveRecipientsMock.mockResolvedValue(['admin-1']);

    await runTick(mockDb([]), {} as never, NOOP_LOG);

    expect(notifyBackupFailedMock).toHaveBeenCalledTimes(2);
    // Dedupe key carries the identity now; there is no resourceId column on
    // the categorised payload because the category supplies the routing.
    const keys = (notifyBackupFailedMock.mock.calls as unknown[][]).map((c) => c[2]).sort();
    expect(keys).toEqual([
      'cnpg-backup-failed:platform/postgres-aux-system-backup-3',
      'cnpg-backup-failed:platform/system-db-daily-2',
    ]);
  });

  it('readBackupHealth throws → tick logs warning and returns', async () => {
    readHealthMock.mockRejectedValue(new Error('apiserver unavailable'));

    await runTick(mockDb([]), {} as never, NOOP_LOG);

    expect(NOOP_LOG.warn).toHaveBeenCalled();
    expect(notifyBackupFailedMock).not.toHaveBeenCalled();
  });

  it('no admin recipients → log warning, do not throw', async () => {
    readHealthMock.mockResolvedValue([FAILING]);
    resolveRecipientsMock.mockResolvedValue([]);

    await runTick(mockDb([]), {} as never, NOOP_LOG);

    expect(NOOP_LOG.warn).toHaveBeenCalled();
    expect(notifyBackupFailedMock).not.toHaveBeenCalled();
  });
});
