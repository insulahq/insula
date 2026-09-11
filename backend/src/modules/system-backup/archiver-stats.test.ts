/**
 * Operator report 2026-09-11: the Database Backup Health card showed a green
 * "WAL streaming" chip while Backups → System reported WAL streaming as not
 * enabled. Both surfaces were describing the same cluster.
 *
 * Ground truth on that production cluster:
 *   - audit log: ONE action ever — `system_scheduled_backups_enable`, recorded
 *     with `walStreamingActive: false`. Streaming was never turned on.
 *   - `system_wal_archive_state.archive_timeout`: NULL.
 *   - Cluster CR: barman-cloud plugin ATTACHED (isWALArchiver: false).
 *   - barman-cloud sidecar: a segment uploaded to the SYSTEM target every
 *     5 minutes, i.e. WAL archiving genuinely running.
 *
 * The plugin ENTRY's presence — not `isWALArchiver`, not the state row — is
 * what makes CNPG archive, and scheduled base backups attach it because a base
 * backup needs the WAL spanning its window. So "archiving is active" and
 * "the operator enabled streaming" are different questions, and the UI must be
 * able to say ACTIVE-but-not-requested.
 */

import { describe, it, expect } from 'vitest';
import {
  isPlatformDbCluster,
  readArchiverStats,
  effectiveArchiveTimeout,
  isArchivingCurrentlyFailing,
} from './archiver-stats.js';
import type { Database } from '../../db/index.js';

describe('effectiveArchiveTimeout', () => {
  it("reports CNPG's default when the plugin is attached and nobody chose a value", () => {
    // The state production was in: archiving every 5 minutes with no explicit
    // setting. Reporting null there would have hidden that WAL was moving at
    // all, which is how the old panel came to claim archiving was off.
    expect(effectiveArchiveTimeout(true, null)).toBe('5min');
    expect(effectiveArchiveTimeout(true, undefined)).toBe('5min');
  });

  it("reports the operator's value when they chose one", () => {
    expect(effectiveArchiveTimeout(true, '60s')).toBe('60s');
  });

  it('reports nothing when the plugin entry is gone — nothing is being archived', () => {
    expect(effectiveArchiveTimeout(false, null)).toBeNull();
    expect(effectiveArchiveTimeout(false, '60s')).toBeNull();
  });
});

describe('readArchiverStats', () => {
  const fakeDb = (rows: unknown[]): Database => ({
    execute: async () => ({ rows }),
  } as unknown as Database);

  it('reads the real last-archive instant and counters', async () => {
    const stats = await readArchiverStats(fakeDb([{
      archived_count: '4477',
      last_archived_wal: '0000000100000021000000BB',
      last_archived_time: new Date('2026-09-11T20:14:31.046Z'),
      failed_count: 0,
      last_failed_wal: null,
      last_failed_time: null,
      stats_reset: '2026-08-27T12:39:06.098Z',
    }]));
    expect(stats?.lastArchivedWal).toBe('0000000100000021000000BB');
    expect(stats?.lastArchivedWalTime).toBe('2026-09-11T20:14:31.046Z');
    expect(stats?.archivedCount).toBe(4477);
    expect(stats?.failedCount).toBe(0);
    expect(stats?.lastFailedArchiveTime).toBeNull();
  });

  it('surfaces archive failures', async () => {
    const stats = await readArchiverStats(fakeDb([{
      archived_count: 10,
      last_archived_wal: '000000010000000000000009',
      last_archived_time: '2026-09-11T10:00:00.000Z',
      failed_count: 3,
      last_failed_wal: '00000001000000000000000A',
      last_failed_time: '2026-09-11T11:00:00.000Z',
      stats_reset: '2026-08-27T12:39:06.098Z',
    }]));
    expect(stats?.failedCount).toBe(3);
    expect(stats?.lastFailedWal).toBe('00000001000000000000000A');
    expect(stats?.lastFailedArchiveTime).toBe('2026-09-11T11:00:00.000Z');
  });

  it('returns null rather than throwing when the view is unreadable', async () => {
    const throwing = { execute: async () => { throw new Error('permission denied'); } } as unknown as Database;
    expect(await readArchiverStats(throwing)).toBeNull();
  });

  it('returns null on an empty result instead of inventing zeros', async () => {
    expect(await readArchiverStats(fakeDb([]))).toBeNull();
  });

  it('only claims to speak for the platform DB cluster', () => {
    expect(isPlatformDbCluster('platform', 'system-db')).toBe(true);
    expect(isPlatformDbCluster('platform', 'other-db')).toBe(false);
    expect(isPlatformDbCluster('tenant-x', 'system-db')).toBe(false);
  });
});

describe('isArchivingCurrentlyFailing', () => {
  /** The DEV cluster's real counters, 2026-09-11 21:57. */
  const DEV_HEALTHY = {
    lastArchivedWal: '00000002000000250000005E',
    lastArchivedWalTime: '2026-09-11T21:57:09.470Z',
    lastFailedWal: '000000020000002100000058',
    lastFailedArchiveTime: '2026-09-08T08:51:26.195Z',
    archivedCount: 4472,
    failedCount: 64,
    statsResetAt: '2026-08-27T12:39:06.098Z',
  };

  it('is FALSE when 4472 successes have overtaken a three-day-old failure', () => {
    // Shipped wrong once: the chip read a red "WAL failing" on a cluster
    // archiving every five minutes, because pg_stat_archiver keeps the last
    // failure forever.
    expect(isArchivingCurrentlyFailing(DEV_HEALTHY)).toBe(false);
  });

  it('is TRUE when the last failure is newer than the last success', () => {
    expect(isArchivingCurrentlyFailing({
      ...DEV_HEALTHY,
      lastFailedArchiveTime: '2026-09-11T22:00:00.000Z',
    })).toBe(true);
  });

  it('is TRUE when nothing has ever been archived but a failure exists', () => {
    expect(isArchivingCurrentlyFailing({
      ...DEV_HEALTHY,
      lastArchivedWal: null,
      lastArchivedWalTime: null,
    })).toBe(true);
  });

  it('is FALSE with no failure recorded at all', () => {
    expect(isArchivingCurrentlyFailing({
      ...DEV_HEALTHY, lastFailedWal: null, lastFailedArchiveTime: null, failedCount: 0,
    })).toBe(false);
    expect(isArchivingCurrentlyFailing(null)).toBe(false);
  });
});
