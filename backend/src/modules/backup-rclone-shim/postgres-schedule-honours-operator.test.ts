/**
 * The Postgres base-backup cadence must be the operator's, not a constant.
 *
 * Found while investigating an inert retention field. The admin
 * panel's Postgres card has a "Base backup cadence" control; saving it calls
 * `enableWalArchive`, which writes the value to `system_wal_archive_state` AND
 * onto the ScheduledBackup. This reconciler then patched the SAME CR back to a
 * hard-coded `0 0 3 * * *` on its next tick — so the control persisted the
 * operator's choice and the cluster ignored it.
 *
 * Verified on DEV before the fix: a ScheduledBackup set to `0 17 4 * * *`
 * was back to `0 0 3 * * *` within six minutes.
 */
import { describe, it, expect, vi } from 'vitest';

import { DEFAULT_BACKUP_SCHEDULE, resolveOperatorBackupSchedule } from './postgres-objectstore.js';

/**
 * A db whose `system_wal_archive_state` row is whatever the test says.
 *
 * NB: this calls the REAL resolver. An earlier draft of this file
 * reimplemented the resolver's logic in the test and asserted against that —
 * which would have passed just as happily with the production function
 * deleted. A test that mirrors the implementation tests nothing.
 */
const dbWithSchedule = (schedule: string | null | undefined, opts: { throws?: boolean } = {}) => ({
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => (opts.throws
          ? Promise.reject(new Error('db down'))
          : Promise.resolve(schedule === undefined ? [] : [{ schedule }])),
      }),
    }),
  }),
}) as never;

describe('the base-backup cadence the shim asserts', () => {
  it('is the operator value when they set one', async () => {
    expect(await resolveOperatorBackupSchedule(dbWithSchedule('0 30 5 * * *'))).toBe('0 30 5 * * *');
  });

  it('falls back to the platform default when unset', async () => {
    expect(await resolveOperatorBackupSchedule(dbWithSchedule(null))).toBe(DEFAULT_BACKUP_SCHEDULE);
    expect(await resolveOperatorBackupSchedule(dbWithSchedule(undefined))).toBe(DEFAULT_BACKUP_SCHEDULE);
    expect(await resolveOperatorBackupSchedule(dbWithSchedule('   '))).toBe(DEFAULT_BACKUP_SCHEDULE);
  });

  it('falls back to the default rather than failing the reconcile', async () => {
    // Asserting the default keeps backups running, which is the safe side of
    // this decision; throwing here would abandon the whole ObjectStore
    // reconcile over a transient read.
    expect(await resolveOperatorBackupSchedule(dbWithSchedule('0 30 5 * * *', { throws: true }))).toBe(DEFAULT_BACKUP_SCHEDULE);
  });

  it('keeps the documented default at 03:00 UTC in CNPG six-field form', () => {
    // The manual tells operators their database is backed up nightly at 03:00.
    expect(DEFAULT_BACKUP_SCHEDULE).toBe('0 0 3 * * *');
  });
});
