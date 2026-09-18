/**
 * Unit tests for the DR-CronJob bridge (dr-cronjobs.ts).
 *
 * The production gap this closes: shim-only clusters never ran the
 * nightly secrets-bundle / cluster-state / audit CronJobs (legacy
 * activate was the only unsuspend path), and Longhorn recurring
 * backups failed invisibly with no BackupTarget.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../notifications/events.js', () => ({
  notifyAdminBackupTargetUnreachable: vi.fn(async () => {}),
}));
vi.mock('./service.js', () => ({
  SHIM_NAMESPACE: 'platform',
  loadBackupTargetKey: vi.fn(async () => ({ rawKey: Buffer.alloc(32, 7) })),
}));

import { reconcileDrCronJobs, BRIDGED_DR_CRONJOBS } from './dr-cronjobs.js';
import { notifyAdminBackupTargetUnreachable } from '../notifications/events.js';
import { loadBackupTargetKey } from './service.js';
import type { Database } from '../../db/index.js';

// One select per pass: the system assignment join (the legacy
// active-row check died with the target-activate retirement).
function fakeDb(systemRows: unknown[]): Database {
  const results = [systemRows];
  let i = 0;
  const makeChain = (rows: unknown[]): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'innerJoin', 'orderBy', 'limit']) {
      chain[m] = vi.fn(() => chain);
    }
    chain.then = (resolve: (r: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
    return chain;
  };
  return { select: vi.fn(() => makeChain(results[i++] ?? [])) } as unknown as Database;
}

interface FakeK8sOpts {
  readonly cronJobSuspend?: boolean | 'absent';
  readonly longhornTargetUrl?: string | 'absent';
  readonly longhornBackupJobs?: boolean;
}

function fakeClients(opts: FakeK8sOpts = {}) {
  const suspend = opts.cronJobSuspend ?? true;
  const core = {
    replaceNamespacedSecret: vi.fn(async () => ({})),
    createNamespacedSecret: vi.fn(async () => ({})),
  };
  const batch = {
    readNamespacedCronJob: vi.fn(async () => {
      if (suspend === 'absent') throw { code: 404 };
      return { spec: { suspend } };
    }),
    patchNamespacedCronJob: vi.fn(async () => ({})),
  };
  const custom = {
    getNamespacedCustomObject: vi.fn(async () => {
      if (opts.longhornTargetUrl === 'absent') throw { code: 404 };
      return { spec: { backupTargetURL: opts.longhornTargetUrl ?? 's3://somewhere@auto/x' } };
    }),
    listNamespacedCustomObject: vi.fn(async () => ({
      items: opts.longhornBackupJobs
        ? [{ spec: { task: 'backup' } }, { spec: { task: 'snapshot' } }]
        : [{ spec: { task: 'snapshot' } }],
    })),
  };
  return { core, batch, custom };
}

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

beforeEach(() => {
  vi.mocked(notifyAdminBackupTargetUnreachable).mockClear();
  vi.mocked(loadBackupTargetKey).mockClear();
});

describe('reconcileDrCronJobs', () => {
  it('system class bound → writes shim-shaped backup-credentials and leaves suspend to the cadence reconciler', async () => {
    // Ownership changed 2026-09-18. This bridge used to unsuspend the bridged
    // CronJobs whenever the SYSTEM class was bound; now the cadence reconciler
    // owns /spec/suspend for any job that has a schedule row, because it must
    // be able to SUSPEND one whose operator cadence differs from the manifest
    // (the platform fires those itself). If both wrote the field, the job
    // would end up firing natively AND via platform firing — two backups per
    // period. The credentials Secret is still this bridge's job alone.
    const db = fakeDb([{ enabled: 1 }]);
    const clients = fakeClients({ cronJobSuspend: true });
    const r = await reconcileDrCronJobs(db, clients as never, log());
    expect(r.state).toBe('bridged');
    expect(r.secretApplied).toBe(true);
    expect(r.unsuspended).toBe(0);
    expect(clients.batch.patchNamespacedCronJob).not.toHaveBeenCalled();
    const secretBody = clients.core.replaceNamespacedSecret.mock.calls[0][0] as {
      body: { stringData: Record<string, string> };
    };
    expect(secretBody.body.stringData.TARGET_KIND).toBe('s3');
    expect(secretBody.body.stringData.S3_BUCKET).toBe('system');
    expect(secretBody.body.stringData.S3_PATH_PREFIX).toBe('dr');
    expect(secretBody.body.stringData.S3_FORCE_PATH_STYLE).toBe('true');
    expect(secretBody.body.stringData.AWS_ENDPOINTS).toContain('backup-rclone-shim');
  });

  it('idempotent: already-unsuspended CronJobs get no writes', async () => {
    const db = fakeDb([{ enabled: 1 }]);
    const clients = fakeClients({ cronJobSuspend: false });
    const r = await reconcileDrCronJobs(db, clients as never, log());
    expect(r.state).toBe('bridged');
    expect(r.unsuspended).toBe(0);
    expect(clients.batch.patchNamespacedCronJob).not.toHaveBeenCalled();
  });

  it('system class unbound → suspends the bridged CronJobs, no Secret write', async () => {
    const db = fakeDb([]);
    const clients = fakeClients({ cronJobSuspend: false });
    const r = await reconcileDrCronJobs(db, clients as never, log());
    expect(r.state).toBe('unbound');
    expect(r.suspended).toBe(BRIDGED_DR_CRONJOBS.length);
    expect(clients.core.replaceNamespacedSecret).not.toHaveBeenCalled();
  });

  it('CronJobs not yet applied by Flux (404) → tolerated, no throw', async () => {
    const db = fakeDb([{ enabled: 1 }]);
    const clients = fakeClients({ cronJobSuspend: 'absent' });
    const r = await reconcileDrCronJobs(db, clients as never, log());
    expect(r.state).toBe('bridged');
    expect(r.unsuspended).toBe(0);
  });

  it('missing BACKUP_TARGET_KEY → error state, jobs stay suspended', async () => {
    vi.mocked(loadBackupTargetKey).mockRejectedValueOnce(new Error('Secret backup-target-key not found'));
    const db = fakeDb([{ enabled: 1 }]);
    const clients = fakeClients();
    const r = await reconcileDrCronJobs(db, clients as never, log());
    expect(r.state).toBe('error');
    expect(clients.batch.patchNamespacedCronJob).not.toHaveBeenCalled();
  });

  it('Longhorn recurring backup jobs with NO BackupTarget → daily admin notification', async () => {
    const db = fakeDb([]);
    const clients = fakeClients({ longhornTargetUrl: '', longhornBackupJobs: true });
    await reconcileDrCronJobs(db, clients as never, log());
    expect(notifyAdminBackupTargetUnreachable).toHaveBeenCalledTimes(1);
    const [, payload, dedupe] = vi.mocked(notifyAdminBackupTargetUnreachable).mock.calls[0];
    expect(payload.targetName).toContain('Longhorn');
    expect(dedupe).toMatch(/^longhorn-no-backup-target:\d{4}-\d{2}-\d{2}$/);
  });

  it('Longhorn with a configured target → no notification', async () => {
    const db = fakeDb([]);
    const clients = fakeClients({ longhornTargetUrl: 's3://bucket@auto/prefix', longhornBackupJobs: true });
    await reconcileDrCronJobs(db, clients as never, log());
    expect(notifyAdminBackupTargetUnreachable).not.toHaveBeenCalled();
  });

  it('Longhorn with snapshot-only recurring jobs → no notification (nothing tries to upload)', async () => {
    const db = fakeDb([]);
    const clients = fakeClients({ longhornTargetUrl: '', longhornBackupJobs: false });
    await reconcileDrCronJobs(db, clients as never, log());
    expect(notifyAdminBackupTargetUnreachable).not.toHaveBeenCalled();
  });
});
