/**
 * Pick up archives whose process is gone.
 *
 * An archive runs detached, in the API process, under a liveness lock
 * (`archiveLockJob`, service.ts) that the process renews while it works. A
 * deploy, a crash or a lost node ends the process mid-archive; the lock then
 * lapses, and the operation row goes on saying "snapshotting" with nobody
 * behind it. This leg of the quiesce watchdog finds those and starts them
 * again — every step of an archive can be run twice (`runArchive`).
 *
 * "Gone" is read from the lock, nothing else:
 *
 *   - the lock's row is there and lapsed a minute or more ago. A process that
 *     ends its archive deletes the row; one that dies leaves it to lapse. The
 *     minute is for a holder that was late renewing, not dead.
 *   - no row at all says nothing — an archive started by a release without
 *     the lock, or one given up as hung (which releases the lock while the
 *     work may still be going on). Those are left to the watchdog's age rule,
 *     as before.
 *
 * Resuming takes the lock, so two watchdogs — or a watchdog and a holder that
 * was only slow — cannot both run the archive.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { SCHEDULER_LEASE_KEY_PREFIX } from '../../shared/scheduler-lease.js';
import { forgetDeadRunLocks, runLockName } from '../../shared/exclusive-run.js';
import { archiveLockJob, resumeArchive } from './service.js';

/** How long a lock must have been lapsed before its holder is taken for dead. */
export const DEAD_HOLDER_GRACE_MS = 60_000;

/**
 * How long a lapsed run lock is kept before it is removed. Far beyond the six
 * hours an interrupted archive's lock is read for.
 */
const DEAD_LOCK_KEPT_MS = 24 * 60 * 60 * 1000;

export interface ResumeResult {
  /** Archives started again. */
  readonly resumed: number;
  /** Archives found without a live process that were not started: resumed too often, or no archive can be taken now. */
  readonly leftAlone: number;
}

/** Archives in flight whose liveness lock lapsed at least `graceMs` ago. */
export async function findInterruptedArchives(db: Database, graceMs: number = DEAD_HOLDER_GRACE_MS): Promise<string[]> {
  // The lock's key in platform_settings, built by the helpers that name the
  // lock, with a placeholder where the operation's id goes.
  const [head, tail] = `${SCHEDULER_LEASE_KEY_PREFIX}${runLockName(archiveLockJob('\u0000'))}`.split('\u0000');
  const res = await db.execute(sql`
    SELECT op.id
      FROM storage_operations op
      JOIN tenants t ON t.id = op.tenant_id AND t.active_storage_op_id = op.id
      JOIN platform_settings l ON l.setting_key = ${head} || op.id || ${tail}
     WHERE op.op_type = 'archive'
       AND op.state NOT IN ('idle', 'failed')
       AND pg_input_is_valid(l.setting_value, 'jsonb')
       AND pg_input_is_valid(l.setting_value::jsonb ->> 'until', 'timestamptz')
       AND (l.setting_value::jsonb ->> 'until')::timestamptz < now() - (${graceMs} || ' milliseconds')::interval
     ORDER BY op.created_at
  `) as unknown as { rows?: Array<{ id: string }> };
  return (res.rows ?? []).map((r) => r.id);
}

export async function resumeInterruptedArchives(
  db: Database,
  k8s: K8sClients,
  config: Record<string, unknown>,
  log: (line: string) => void = (line) => { console.warn(`[archive-resume] ${line}`); },
): Promise<ResumeResult> {
  // The locks of processes long dead — a tenant's, an archive's — are nobody's
  // to release. This tick is where interrupted work is looked for, so it is
  // also where what is left of it is cleared away.
  await forgetDeadRunLocks(db, DEAD_LOCK_KEPT_MS).catch((err: unknown) => {
    log(`could not remove the locks of dead processes: ${err instanceof Error ? err.message : String(err)}`);
  });
  const interrupted = await findInterruptedArchives(db);
  if (interrupted.length === 0) return { resumed: 0, leftAlone: 0 };

  let resumed = 0;
  let leftAlone = 0;
  const { buildArchiveServiceCtx } = await import('./snapshot-ctx.js');
  for (const opId of interrupted) {
    try {
      // Needs what the archive needed: a backup target that takes tenant
      // snapshots. Without one it is left for the age rule to fail.
      const ctx = await buildArchiveServiceCtx(db, k8s, config);
      if (await resumeArchive(ctx, opId)) {
        resumed += 1;
        log(`archive ${opId} had no live process behind it — picked up again`);
      } else {
        leftAlone += 1;
        log(`archive ${opId} has no live process behind it and was not picked up again (ended meanwhile, or resumed too often)`);
      }
    } catch (err) {
      leftAlone += 1;
      log(`archive ${opId} could not be picked up again: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { resumed, leftAlone };
}
