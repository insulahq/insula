/**
 * Operator-set retention for the Flux-owned DR CronJobs, delivered by a
 * ConfigMap the platform owns outright.
 *
 * Why not just patch the CronJob's env, the way the etcd job's reconciler
 * does? Because Flux owns these two objects. It reverts anything it did not
 * apply, so a patched env value survives until the next reconcile and then
 * silently goes back — which is precisely how the mail snapshot's retention
 * behaved before it moved to this pattern (see mail-admin/snapshot-settings.ts,
 * where the same note is recorded from the other side).
 *
 * So the value lives in a ConfigMap that Flux is given NO manifest for, and
 * the CronJob picks it up with `envFrom: configMapRef, optional: true`. Flux
 * keeps ownership of the workload; the platform keeps ownership of the number;
 * neither can overwrite the other.
 *
 * `optional: true` matters on the other side too: until the platform has
 * written the ConfigMap the job still runs, on the default compiled into its
 * own script.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../../../db/index.js';
import { backupSchedules } from '../../../db/schema.js';

export interface RetentionConfigMapTarget {
  /** `backup_schedules.subsystem`. */
  readonly subsystem: string;
  readonly namespace: string;
  readonly configMapName: string;
  /**
   * The count compiled into the job's own script, used when the operator has
   * set nothing. Keep in sync with the manifest: if they disagree, the number
   * shown in the panel before an operator first saves is not the number the
   * job is running.
   */
  readonly defaultCount: number;
}

export const RETENTION_CONFIGMAP_TARGETS: readonly RetentionConfigMapTarget[] = [
  {
    subsystem: 'secrets_bundle',
    namespace: 'platform',
    configMapName: 'secrets-backup-retention',
    defaultCount: 30,
  },
  {
    subsystem: 'cluster_state',
    namespace: 'platform',
    configMapName: 'cluster-state-backup-retention',
    defaultCount: 14,
  },
];

export function retentionTargetFor(subsystem: string): RetentionConfigMapTarget | undefined {
  return RETENTION_CONFIGMAP_TARGETS.find((t) => t.subsystem === subsystem);
}

/**
 * The count to publish for one subsystem.
 *
 * NULL means "never configured", which is the job's own default — NOT zero.
 * Anything below 1 is refused for the same reason: the scripts guard
 * themselves, but a writer that can emit a destructive number and relies on
 * the reader to ignore it is one script edit away from being destructive.
 */
export async function desiredRetentionCount(
  db: Database,
  target: RetentionConfigMapTarget,
): Promise<number> {
  const [row] = await db
    .select({ retentionCount: backupSchedules.retentionCount })
    .from(backupSchedules)
    .where(eq(backupSchedules.subsystem, target.subsystem));
  const n = row?.retentionCount;
  if (n === null || n === undefined || !Number.isInteger(n) || n < 1) return target.defaultCount;
  return n;
}

interface CoreLike {
  readNamespacedConfigMap(args: { name: string; namespace: string }): Promise<unknown>;
  replaceNamespacedConfigMap(args: { name: string; namespace: string; body: object }): Promise<unknown>;
  createNamespacedConfigMap(args: { namespace: string; body: object }): Promise<unknown>;
}

function isNotFound(err: unknown): boolean {
  const code = (err as { statusCode?: number; code?: number })?.statusCode
    ?? (err as { code?: number })?.code;
  return code === 404;
}

/**
 * Converge one subsystem's retention ConfigMap. Idempotent.
 *
 * Returns the value published, or null when the cluster could not be written —
 * a failure here must not fail the caller: the job keeps running on its
 * previous value, which is a stale number rather than a broken backup.
 */
export async function applyRetentionConfigMap(
  db: Database,
  core: CoreLike,
  target: RetentionConfigMapTarget,
  log?: { warn: (o: unknown, m: string) => void },
): Promise<number | null> {
  const count = await desiredRetentionCount(db, target);
  const body = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: target.configMapName,
      namespace: target.namespace,
      labels: {
        'app.kubernetes.io/component': 'backup-retention',
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/managed-by': 'platform-api',
      },
    },
    data: { RETENTION_COUNT: String(count) },
  };

  try {
    await core.readNamespacedConfigMap({ name: target.configMapName, namespace: target.namespace });
    await core.replaceNamespacedConfigMap({
      name: target.configMapName, namespace: target.namespace, body,
    });
    return count;
  } catch (err) {
    if (!isNotFound(err)) {
      log?.warn({ err, configMap: target.configMapName }, 'retention: ConfigMap update failed');
      return null;
    }
  }
  try {
    await core.createNamespacedConfigMap({ namespace: target.namespace, body });
    return count;
  } catch (err) {
    log?.warn({ err, configMap: target.configMapName }, 'retention: ConfigMap create failed');
    return null;
  }
}
