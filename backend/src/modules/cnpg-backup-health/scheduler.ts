/**
 * CNPG backup-failure notification scheduler.
 *
 * Sister to the existing backup-health scheduler (which watches K8s
 * Jobs labelled insula.host/backup-health-watch — used
 * for tenant-side backups). CNPG `Backup` CRs live in a separate API
 * group and are managed by the operator, not as Jobs, so this is a
 * dedicated tick.
 *
 * Each tick:
 *   1. Snapshot CNPG Backup health via readBackupHealth().
 *   2. For each cluster's `mostRecentFailure`, check whether we've
 *      already written an admin notification for that specific Backup
 *      CR name. (Dedup key: `<namespace>/<backup-name>` — CNPG names
 *      are timestamped and never reused.)
 *   3. Emit one notification per newly-observed failure.
 *
 * Idempotent: re-derives the already-notified set from the
 * notifications table on every tick, so a pod restart mid-tick is
 * safe. The next tick re-reads + re-checks.
 *
 * Phase 2A.2 follow-up: closes the loop where operators only learn
 * about backup failures by visiting the admin Email Management page.
 * Now: operators get a notification the moment a Backup CR fails
 * (typical lag: 0-5min depending on tick alignment).
 */

import { eq, and, inArray } from 'drizzle-orm';
import * as k8s from '@kubernetes/client-node';
import { notifications } from '../../db/schema.js';
import { notifyUsers } from '../notifications/service.js';
import { resolveRecipients } from '../notifications/recipients.js';
import { readBackupHealth, type ClusterBackupHealth, type BackupRecord } from './service.js';
import type { Database } from '../../db/index.js';

const RESOURCE_TYPE = 'cnpg_backup_failure';

/**
 * Default tick interval — 5 minutes balances freshness vs apiserver
 * load. Backup CRs typically fire on cron schedules (daily / hourly),
 * so 5min is plenty fast to catch a failure within useful time. The
 * existing tenant backup-health scheduler uses the same cadence.
 */
export const CNPG_BACKUP_HEALTH_TICK_MS = 5 * 60 * 1000;

export interface CnpgBackupHealthSchedulerDeps {
  readonly db: Database;
  readonly custom: k8s.CustomObjectsApi;
  readonly tickMs?: number;
  readonly logger?: { warn: (msg: string, err?: unknown) => void; info?: (msg: string) => void };
}

export function startCnpgBackupHealthScheduler(
  deps: CnpgBackupHealthSchedulerDeps,
): () => void {
  const tickMs = deps.tickMs ?? CNPG_BACKUP_HEALTH_TICK_MS;
  const log = deps.logger ?? {
    // eslint-disable-next-line no-console
    warn: (msg, err) => console.warn(`[cnpg-backup-health] ${msg}`, err ?? ''),
    // eslint-disable-next-line no-console
    info: (msg) => console.info(`[cnpg-backup-health] ${msg}`),
  };

  void runTick(deps.db, deps.custom, log);

  const timer = setInterval(() => {
    void runTick(deps.db, deps.custom, log);
  }, tickMs);

  return () => clearInterval(timer);
}

/**
 * One tick of the scheduler. Public for testability — the test injects
 * a fake CustomObjectsApi + DB and asserts the right notifications are
 * created.
 */
export async function runTick(
  db: Database,
  custom: k8s.CustomObjectsApi,
  log: { warn: (msg: string, err?: unknown) => void; info?: (msg: string) => void },
): Promise<void> {
  let snapshot: ReadonlyArray<ClusterBackupHealth>;
  try {
    snapshot = await readBackupHealth({ custom });
  } catch (err) {
    log.warn('readBackupHealth failed', err);
    return;
  }

  // Collect failures across all clusters in one batch so we hit the
  // notifications table once for the dedup query.
  const failures: ReadonlyArray<{
    cluster: ClusterBackupHealth;
    backup: BackupRecord;
    dedupKey: string;
  }> = snapshot
    .filter((c) => c.mostRecentFailure !== null)
    .map((c) => {
      const backup = c.mostRecentFailure!;
      return {
        cluster: c,
        backup,
        dedupKey: `${backup.namespace}/${backup.name}`,
      };
    });

  if (failures.length === 0) return;

  const alreadyNotified = await loadAlreadyNotifiedKeys(
    db,
    failures.map((f) => f.dedupKey),
  );

  const newFailures = failures.filter((f) => !alreadyNotified.has(f.dedupKey));
  if (newFailures.length === 0) return;

  for (const f of newFailures) {
    // eslint-disable-next-line no-await-in-loop
    await notifyForFailure(db, f.cluster, f.backup, log);
  }
}

async function loadAlreadyNotifiedKeys(
  db: Database,
  candidateKeys: ReadonlyArray<string>,
): Promise<Set<string>> {
  if (candidateKeys.length === 0) return new Set();
  const rows = await db
    .select({ resourceId: notifications.resourceId })
    .from(notifications)
    .where(
      and(
        eq(notifications.resourceType, RESOURCE_TYPE),
        inArray(notifications.resourceId, candidateKeys as string[]),
      ),
    );
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.resourceId) seen.add(row.resourceId);
  }
  return seen;
}

async function notifyForFailure(
  db: Database,
  cluster: ClusterBackupHealth,
  backup: BackupRecord,
  log: { warn: (msg: string, err?: unknown) => void; info?: (msg: string) => void },
): Promise<void> {
  // CNPG backups are platform-level (not tenant-scoped) — every CNPG
  // cluster is shared infrastructure. Always notify admin recipients.
  const recipients = await resolveRecipients(db, { kind: 'admin' });
  if (recipients.length === 0) {
    log.warn(
      `no admin recipients for failed CNPG backup ${backup.namespace}/${backup.name} — notification skipped`,
    );
    return;
  }

  const reason = backup.error
    ? backup.error.slice(0, 500)
    : 'Backup CR entered Failed phase without an error message.';

  // Add useful context: how long since last successful backup, what
  // recovery flow exists. Keep the body short — the admin UI surfaces
  // full detail in the Backup Health card.
  const recoveryHint = cluster.lastSuccessSecondsAgo !== null
    ? `Last successful backup ${formatAge(cluster.lastSuccessSecondsAgo)} ago.`
    : `No prior successful backup recorded.`;

  await notifyUsers(db, recipients, {
    type: 'error',
    title: `Database backup failed: ${cluster.namespace}/${cluster.clusterName}`,
    message:
      `CNPG backup ${backup.namespace}/${backup.name} failed. ${reason} ${recoveryHint} ` +
      `Inspect via /backups/system → Backups, or run ` +
      `\`kubectl -n ${backup.namespace} get backup.postgresql.cnpg.io\`.`,
    resourceType: RESOURCE_TYPE,
    resourceId: `${backup.namespace}/${backup.name}`,
  });

  log.info?.(
    `notified admins about failed backup ${backup.namespace}/${backup.name} (cluster ${cluster.namespace}/${cluster.clusterName}, ${recipients.length} recipients)`,
  );
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

// Test-only re-exports.
export const __test = {
  RESOURCE_TYPE,
};
