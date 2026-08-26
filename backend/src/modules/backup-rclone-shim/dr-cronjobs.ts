/**
 * DR-CronJob bridge — feeds the legacy `backup-credentials` consumers
 * from the 3-class shim binding.
 *
 * The nightly DR CronJobs (`platform-secrets-backup`,
 * `platform-cluster-state-backup`, `platform-backup-audit`) predate the
 * shim: they read the `backup-credentials` Secret and are unsuspended
 * ONLY by the legacy "Activate" flow (backup-config/longhorn-reconciler).
 * A cluster configured purely through the shim assignments — the normal
 * path since R-X20 — left them suspended forever, so the age-encrypted
 * secrets bundle and the cluster-state dump silently never ran
 * (production, 2026-08-26). Their planned shim-native replacement
 * ("R-X9 secrets-bundle rclone-push", see k8s/base/backup/
 * LEGACY-DEPRECATED.md) was never built.
 *
 * This bridge closes the gap without new upload code: when the SYSTEM
 * class is bound, it materialises
 * `backup-credentials` pointing at the shim's own S3 endpoint with the
 * HKDF-derived per-cluster credentials — the job scripts run unchanged,
 * and the shim handles whatever upstream the operator picked
 * (S3/SFTP/CIFS/NFS). Objects land under `system/dr/…`.
 *
 * Deliberately NOT bridged: `platform-pg-backup` and
 * `platform-etcd-snapshot-upload` — their live replacements (CNPG
 * base backups via barman plugin, `etcd-snap-via-shim`) already run on
 * the shim; unsuspending them would double-back-up the same data.
 *
 * Ownership: this bridge is the SOLE writer of `backup-credentials`
 * and the suspend flags. The legacy target-activate flow was retired
 * 2026-08-26 (routes + longhorn-reconciler deleted; migration 0090
 * cleared any `active` rows), so there is nothing to defer to.
 *
 * Side check — Longhorn volume backups: the same sweep found Longhorn's
 * recurring `backup` jobs fail EVERY run on a shim-only cluster ("backup
 * target default is not available") while the CronJob pod still reports
 * Complete. Longhorn cannot be silently pointed at the shim here (perf +
 * the deliberate "no longhorn shim class" decision), but the failure
 * must not stay invisible: when recurring backup jobs exist with no
 * BackupTarget URL, raise a daily admin
 * notification.
 */

import { eq, inArray } from 'drizzle-orm';
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';

import { backupConfigurations, backupTargetAssignments } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { buildS3SecretData } from '../backup-config/target-secret-shape.js';
import { notifyAdminBackupTargetUnreachable } from '../notifications/events.js';
import { loadBackupTargetKey, SHIM_NAMESPACE } from './service.js';
import { deriveShimAccessKey, deriveShimSecretKey } from './crypto.js';
import { SHIM_S3_ENDPOINT_URL, SHIM_REGION } from './rclone-push.js';
import { JSON_PATCH } from '../../shared/k8s-patch.js';

const PLATFORM_NAMESPACE = 'platform';
const CREDENTIALS_SECRET_NAME = 'backup-credentials';

/** The three legacy DR CronJobs with NO live shim-era replacement. */
export const BRIDGED_DR_CRONJOBS = [
  'platform-secrets-backup',
  'platform-cluster-state-backup',
  'platform-backup-audit',
] as const;

export interface DrCronJobsResult {
  readonly state: 'bridged' | 'unbound' | 'error';
  readonly errorMessage: string;
  readonly secretApplied: boolean;
  readonly unsuspended: number;
  readonly suspended: number;
}

interface CronJobClients {
  readonly core: k8s.CoreV1Api;
  readonly batch: k8s.BatchV1Api;
  readonly custom: k8s.CustomObjectsApi;
}

async function systemClassBound(db: Database): Promise<boolean> {
  const rows = await db
    .select({ enabled: backupConfigurations.enabled })
    .from(backupTargetAssignments)
    .innerJoin(backupConfigurations, eq(backupConfigurations.id, backupTargetAssignments.targetId))
    .where(inArray(backupTargetAssignments.backupClass, ['system']))
    .orderBy(backupTargetAssignments.priority)
    .limit(1);
  return rows.length > 0 && rows[0].enabled === 1;
}

async function upsertCredentialsSecret(
  core: k8s.CoreV1Api,
  data: Record<string, string>,
): Promise<void> {
  const body = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: CREDENTIALS_SECRET_NAME,
      namespace: PLATFORM_NAMESPACE,
      labels: { 'app.kubernetes.io/part-of': 'hosting-platform' },
      // Distinguishes the shim-bridge writer from the legacy activate
      // flow for operators debugging "where did this Secret come from".
      annotations: { 'insula.host/owned-by': 'backup-rclone-shim-dr-bridge' },
    },
    stringData: data,
  };
  const api = core as unknown as {
    replaceNamespacedSecret: (a: { name: string; namespace: string; body: unknown }) => Promise<unknown>;
    createNamespacedSecret: (a: { namespace: string; body: unknown }) => Promise<unknown>;
  };
  try {
    // replace (not patch) so switching writers leaves no stale keys.
    // backup-coverage: excluded:derived-from-BACKUP_TARGET_KEY (HKDF creds,
    // re-materialised every tick — nothing to back up)
    await api.replaceNamespacedSecret({ name: CREDENTIALS_SECRET_NAME, namespace: PLATFORM_NAMESPACE, body });
  } catch (err: unknown) {
    const status = (err as { response?: { statusCode?: number }; code?: number })?.response?.statusCode
      ?? (err as { code?: number })?.code;
    if (status !== 404) throw err;
    // backup-coverage: excluded:derived-from-BACKUP_TARGET_KEY (see above)
    await api.createNamespacedSecret({ namespace: PLATFORM_NAMESPACE, body });
  }
}

/** Patch one CronJob's spec.suspend; 404 (Flux not synced yet) is a no-op. */
async function setCronJobSuspend(
  batch: k8s.BatchV1Api,
  name: string,
  suspend: boolean,
): Promise<boolean> {
  const api = batch as unknown as {
    readNamespacedCronJob: (a: { name: string; namespace: string }) => Promise<{ spec?: { suspend?: boolean } }>;
    patchNamespacedCronJob: (a: { name: string; namespace: string; body: unknown }, o?: unknown) => Promise<unknown>;
  };
  let live: { spec?: { suspend?: boolean } };
  try {
    live = await api.readNamespacedCronJob({ name, namespace: PLATFORM_NAMESPACE });
  } catch (err: unknown) {
    const status = (err as { response?: { statusCode?: number }; code?: number })?.response?.statusCode
      ?? (err as { code?: number })?.code;
    if (status === 404) return false;
    throw err;
  }
  if ((live.spec?.suspend ?? true) === suspend) return false;
  await api.patchNamespacedCronJob(
    { name, namespace: PLATFORM_NAMESPACE, body: [{ op: 'replace', path: '/spec/suspend', value: suspend }] },
    JSON_PATCH,
  );
  return true;
}

/**
 * Longhorn volume-backup visibility: recurring `backup` jobs with no
 * BackupTarget configured fail every run while their Job pods still
 * complete — nothing surfaces. One admin notification per day.
 */
async function checkLonghornBackupTarget(
  db: Database,
  custom: k8s.CustomObjectsApi,
  log: Pick<Logger, 'warn'>,
): Promise<void> {
  const api = custom as unknown as {
    getNamespacedCustomObject: (a: { group: string; version: string; namespace: string; plural: string; name: string }) => Promise<unknown>;
    listNamespacedCustomObject: (a: { group: string; version: string; namespace: string; plural: string }) => Promise<unknown>;
  };
  let targetUrl = '';
  try {
    const bt = await api.getNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2', namespace: 'longhorn-system',
      plural: 'backuptargets', name: 'default',
    }) as { spec?: { backupTargetURL?: string } };
    targetUrl = bt.spec?.backupTargetURL ?? '';
  } catch {
    return; // Longhorn absent / transient — nothing to report
  }
  if (targetUrl !== '') return;

  let hasBackupJobs = false;
  try {
    const jobs = await api.listNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2', namespace: 'longhorn-system',
      plural: 'recurringjobs',
    }) as { items?: Array<{ spec?: { task?: string } }> };
    hasBackupJobs = (jobs.items ?? []).some((j) => j.spec?.task === 'backup');
  } catch {
    return;
  }
  if (!hasBackupJobs) return;

  try {
    await notifyAdminBackupTargetUnreachable(db, {
      targetName: 'Longhorn volume backups',
      errorMessage:
        'Longhorn recurring backup jobs are scheduled but no Longhorn BackupTarget is configured — every nightly '
        + 'volume backup fails ("backup target default is not available") while the job pod still reports Complete. '
        + 'The platform does not manage Longhorn volume backups (retired 2026-08-26 in favour of tenant bundles); '
        + 'either remove the custom recurring backup job or configure a Longhorn BackupTarget manually.',
    }, `longhorn-no-backup-target:${new Date().toISOString().slice(0, 10)}`);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'dr-cronjobs: longhorn notification failed');
  }
}

/**
 * One reconcile pass. Idempotent; safe to run every tick.
 */
export async function reconcileDrCronJobs(
  db: Database,
  clients: CronJobClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<DrCronJobsResult> {
  // Longhorn visibility check first — it reports a distinct gap.
  await checkLonghornBackupTarget(db, clients.custom, log);

  const bound = await systemClassBound(db);
  if (!bound) {
    let suspended = 0;
    for (const name of BRIDGED_DR_CRONJOBS) {
      try {
        if (await setCronJobSuspend(clients.batch, name, true)) suspended += 1;
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err), name }, 'dr-cronjobs: suspend failed');
      }
    }
    return { state: 'unbound', errorMessage: '', secretApplied: false, unsuspended: 0, suspended };
  }

  let keyInput;
  try {
    keyInput = await loadBackupTargetKey(clients.core, SHIM_NAMESPACE, { log });
  } catch (err) {
    // Fresh cluster without the shim key — the CronJobs would fail
    // anyway; keep them suspended and report.
    const msg = err instanceof Error ? err.message : String(err);
    return { state: 'error', errorMessage: msg, secretApplied: false, unsuspended: 0, suspended: 0 };
  }

  try {
    await upsertCredentialsSecret(clients.core, buildS3SecretData({
      kind: 's3',
      endpoint: SHIM_S3_ENDPOINT_URL,
      region: SHIM_REGION,
      bucket: 'system',
      pathPrefix: 'dr',
      accessKeyId: deriveShimAccessKey(keyInput.rawKey),
      secretAccessKey: deriveShimSecretKey(keyInput.rawKey),
      // No wildcard DNS on the shim Service — virtual-hosted bucket
      // addressing can never resolve; the job scripts must use
      // path-style.
      forcePathStyle: true,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'dr-cronjobs: backup-credentials Secret apply failed');
    return { state: 'error', errorMessage: msg, secretApplied: false, unsuspended: 0, suspended: 0 };
  }

  let unsuspended = 0;
  for (const name of BRIDGED_DR_CRONJOBS) {
    try {
      if (await setCronJobSuspend(clients.batch, name, false)) {
        unsuspended += 1;
        log.info({ name }, 'dr-cronjobs: unsuspended (system class bound via shim)');
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), name }, 'dr-cronjobs: unsuspend failed');
    }
  }
  return { state: 'bridged', errorMessage: '', secretApplied: true, unsuspended, suspended: 0 };
}
