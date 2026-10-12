/**
 * Backup-health scheduler.
 *
 * Runs every BACKUP_HEALTH_TICK_MS in the in-cluster process. Each
 * tick: list health-watched Jobs and report every failed one.
 *
 * One notification per failed Job, however many ticks see it: each report
 * carries the dedupe key `backup-job-failed:<Job UID>`, and the dispatcher
 * delivers a key once per recipient. That is the only dedupe — a failed Job
 * is reported again on every tick while it exists, and dropped there. (A
 * lookup that was meant to skip Jobs already reported used to run first; it
 * read a column the dispatcher never writes and never matched a row.)
 *
 * Idempotent: a pod restart mid-tick leaves the recipients not yet told to
 * the next tick.
 */

import * as k8s from '@kubernetes/client-node';
import { notifyAdminBackupFailed } from '../notifications/events.js';
import { resolveRecipients } from '../notifications/recipients.js';
import { listHealthWatchedJobs } from './service.js';
import type { BackupJobMeta } from './service.js';
import type { Database } from '../../db/index.js';
import { safeTick } from '../../shared/safe-tick.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';

/** Default tick interval — 5 minutes balances freshness vs apiserver load. */
export const BACKUP_HEALTH_TICK_MS = 5 * 60 * 1000;

export interface BackupHealthSchedulerDeps {
  readonly db: Database;
  readonly batch: k8s.BatchV1Api;
  readonly tickMs?: number;
  readonly logger?: { warn: (msg: string, err?: unknown) => void };
}

export function startBackupHealthScheduler(
  deps: BackupHealthSchedulerDeps,
): () => void {
  const tickMs = deps.tickMs ?? BACKUP_HEALTH_TICK_MS;
  const log = deps.logger ?? {
    // eslint-disable-next-line no-console
    warn: (msg, err) => console.warn(`[backup-health] ${msg}`, err ?? ''),
  };

  // One replica watches: the failure notification is deduplicated by a lookup,
  // not a constraint, so replicas ticking together each send it.
  const tick = (): void => safeTick(
    'backup-health',
    () => withSchedulerLease(deps.db, 'backup-job-health', tickMs * 1.5, () => runTick(deps.db, deps.batch, log)),
    log,
  );
  tick();

  const timer = setInterval(tick, tickMs);

  return () => clearInterval(timer);
}

export async function runTick(
  db: Database,
  batch: k8s.BatchV1Api,
  log: { warn: (msg: string, err?: unknown) => void },
): Promise<void> {
  let jobs: ReadonlyArray<BackupJobMeta>;
  try {
    jobs = await listHealthWatchedJobs(batch);
  } catch (err) {
    log.warn('listHealthWatchedJobs failed', err);
    return;
  }

  for (const failure of jobs.filter((j) => j.state === 'failed')) {
    // eslint-disable-next-line no-await-in-loop
    await notifyForFailure(db, failure, log);
  }
}

async function notifyForFailure(
  db: Database,
  failure: BackupJobMeta,
  log: { warn: (msg: string, err?: unknown) => void },
): Promise<void> {
  const recipients = failure.tenantId
    ? await resolveRecipients(db, { kind: 'tenant', tenantId: failure.tenantId })
    : await resolveRecipients(db, { kind: 'admin' });

  if (recipients.length === 0) {
    log.warn(
      `no recipients for failed backup job ${failure.namespace}/${failure.name} (tenantId=${failure.tenantId ?? 'admin'})`,
    );
    return;
  }

  const reason = failure.failureReason
    ? failure.failureReason.slice(0, 500)
    : 'Job entered Failed state without a status condition message.';

  // The legacy notifyUsers fan-out that used to sit here has been removed.
  //
  // It was kept "for back-compat with any non-categorised consumer (e.g. the
  // bell dropdown reads from `notifications` directly)" — but the categorised
  // dispatcher writes that same row through its in_app channel, so the two
  // calls produced TWO inbox entries for one failed backup. The dispatcher
  // path is a strict superset: same row, plus a template, an email leg, a
  // preference gate, a rate limit and a delivery audit.
  // Dedupe on the Job UID: the scheduler reports a failed Job on every tick
  // until the Job is garbage collected, and this key is what makes all but
  // the first report a no-op.
  await notifyAdminBackupFailed(db, {
    backupName: `${failure.namespace}/${failure.name} (${failure.displayName})`,
    errorMessage: `Category: ${failure.category}, severity: ${failure.severity}. ${reason}`,
  }, `backup-job-failed:${failure.uid}`);
}
