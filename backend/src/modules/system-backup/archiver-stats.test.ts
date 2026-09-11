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
import { isPlatformDbCluster, readArchiverStats, classifyWalArchiving as classify } from './archiver-stats.js';
import type { Database } from '../../db/index.js';

describe('WAL archiving source classification', () => {
  it('reports ACTIVE via scheduled backups when streaming was never enabled (the production case)', () => {
    const r = classify(true, null, '0 0 3 * * *');
    expect(r.active).toBe(true);
    expect(r.source).toBe('scheduled_backups');
    // RPO is CNPG's default, not something the operator chose.
    expect(r.effectiveArchiveTimeout).toBe('5min');
  });

  it('names the target binding when neither toggle is on (the DEV case)', () => {
    // DEV 2026-09-11: NO system_wal_archive_state row at all, yet the plugin was
    // attached by the shim reconciler because a SYSTEM target is bound — and
    // 4468 segments had been archived. Calling that "scheduled backups" would
    // have been a second wrong story.
    const r = classify(true, null, null);
    expect(r.active).toBe(true);
    expect(r.source).toBe('target_binding');
    expect(r.effectiveArchiveTimeout).toBe('5min');
  });

  it('reports ACTIVE via streaming when the operator set an archive_timeout', () => {
    const r = classify(true, '60s', '0 0 3 * * *');
    expect(r.source).toBe('streaming');
    expect(r.effectiveArchiveTimeout).toBe('60s');
  });

  it('reports inactive only when the plugin entry is gone', () => {
    const r = classify(false, null, null);
    expect(r.active).toBe(false);
    expect(r.source).toBe('none');
    expect(r.effectiveArchiveTimeout).toBeNull();
  });

  it('does not call a cluster inactive just because archive_timeout is null', () => {
    // The bug: `!!archiveTimeout` was the whole answer on the settings tab, so
    // a cluster archiving every 5 minutes read "not enabled".
    expect(classify(true, null, null).active).toBe(true);
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
