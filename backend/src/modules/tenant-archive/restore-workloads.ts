/**
 * Bring an archived tenant's applications back when it is restored — stopped.
 *
 * Archive deleted every Deployment, CronJob and Service in the namespace, and
 * the volume; the `deployments` rows stayed (status 'stopped'), and the files
 * — the databases' data among them — are back on a fresh volume by the time
 * this runs. Each row is deployed again from its stored spec, as DR recover
 * does (catalog: `redeployWithCurrentConfig`, re-stamping each database's root
 * password onto its restored data; custom: `redeployCustomDeploymentRow`).
 *
 * A restored tenant comes back SUSPENDED (an operator decision), so
 * everything is deployed at 0 replicas and every CronJob suspended — nothing
 * runs until the tenant is reactivated. What Reactivate brings back is
 * returned as a quiesce snapshot, which the restore writes down as the
 * suspension's own record (the resume reads the tenant's newest `suspend`
 * operation):
 *
 *   - a workload the suspension before the archive wrote down: its count then,
 *     0 included — an application the tenant had stopped stays stopped (not
 *     when a resume came after that record: it is then not what it ran at);
 *   - one it did not (the record is gone, or the tenant was suspended by a path
 *     that writes none): what a deploy runs — the row's replica count for a
 *     catalog application, 1 for a custom one;
 *   - a Deployment no row explains: 0. Reactivate starts nothing nobody asked for.
 *
 * Never throws for one application: what failed is reported back, to be
 * redeployed from the tenant's page once it is active.
 */
import { and, desc, eq, notInArray } from 'drizzle-orm';
import { deployments, storageOperations } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { QuiesceSnapshot } from '../storage-lifecycle/quiesce.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';

export interface WorkloadRestoreResult {
  readonly total: number;
  readonly redeployed: number;
  readonly failures: readonly string[];
  /** What Reactivate scales back up to — the suspension's record. */
  readonly resumeTo: QuiesceSnapshot;
}

const say = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const MANAGED = 'platform.io/managed=true';

interface Labelled {
  readonly metadata?: { readonly name?: string; readonly labels?: Readonly<Record<string, string>> };
  readonly spec?: { readonly suspend?: boolean };
}

export interface ResumeRow {
  readonly id: string;
  readonly name: string;
  readonly source: string | null;
  readonly replicaCount: number | null;
}

/** Pure: what Reactivate brings each restored workload back to. */
export function resumeSnapshotFor(
  deploymentsNow: ReadonlyArray<Labelled>,
  cronJobsNow: ReadonlyArray<Labelled>,
  rows: ReadonlyArray<ResumeRow>,
  before: QuiesceSnapshot | null | undefined,
): QuiesceSnapshot {
  const was = new Map((before?.deployments ?? []).map((d) => [d.name, d.replicas]));
  const wasSuspended = new Map((before?.cronJobs ?? []).map((c) => [c.name, c.wasSuspended]));
  const catalogByName = new Map(rows.filter((r) => r.source !== 'custom').map((r) => [r.name, r]));
  const customById = new Map(rows.filter((r) => r.source === 'custom').map((r) => [r.id, r]));
  const deploymentsOut = deploymentsNow.flatMap((d) => {
    const name = d.metadata?.name;
    if (!name) return [];
    const labels = d.metadata?.labels ?? {};
    const prior = was.get(name);
    if (prior !== undefined) return [{ name, replicas: prior }];
    const catalog = labels.app ? catalogByName.get(labels.app) : undefined;
    if (catalog) return [{ name, replicas: catalog.replicaCount ?? 1 }];
    const custom = labels['insula.host/deployment-id'] ? customById.get(labels['insula.host/deployment-id']) : undefined;
    if (custom) return [{ name, replicas: 1 }];
    return [{ name, replicas: 0 }];
  });
  const cronJobsOut = cronJobsNow.flatMap((c) => {
    const name = c.metadata?.name;
    return name ? [{ name, wasSuspended: wasSuspended.get(name) ?? false }] : [];
  });
  return { deployments: deploymentsOut, cronJobs: cronJobsOut };
}

export async function redeployTenantWorkloads(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  namespace: string,
): Promise<WorkloadRestoreResult> {
  const rows = await db.select().from(deployments)
    .where(and(eq(deployments.tenantId, tenantId), notInArray(deployments.status, ['deleting', 'deleted'])));
  const failures: string[] = [];
  let redeployed = 0;
  if (rows.length > 0) {
    const { redeployWithCurrentConfig } = await import('../deployments/service.js');
    const { redeployCustomDeploymentRow } = await import('../custom-deployments/service.js');
    for (const dep of rows) {
      try {
        if (dep.source === 'custom') {
          await redeployCustomDeploymentRow(db, k8s, tenantId, dep, { stopped: true });
        } else {
          await redeployWithCurrentConfig(db, dep, k8s, { armPasswordReset: true, replicas: 0 });
        }
        redeployed += 1;
      } catch (err) {
        failures.push(`${dep.name}: ${say(err)}`);
      }
    }
  }

  // Nothing runs while the tenant is suspended: a catalog component with a
  // schedule is a CronJob, and a fresh one is not suspended.
  const cronJobs = await listManaged(k8s, 'cronjobs', namespace);
  for (const c of cronJobs) {
    const name = c.metadata?.name;
    if (!name || c.spec?.suspend === true) continue;
    try {
      await (k8s.batch as unknown as CronJobPatcher).patchNamespacedCronJob({ name, namespace, body: { spec: { suspend: true } } }, MERGE_PATCH);
    } catch (err) {
      failures.push(`${name}: schedule not paused (${say(err)})`);
    }
  }

  const resumeTo = resumeSnapshotFor(await listManaged(k8s, 'deployments', namespace), cronJobs, rows, await suspensionRecord(db, tenantId));
  return { total: rows.length, redeployed, failures, resumeTo };
}

/**
 * What the suspension before the archive wrote down — the tenant's newest
 * `suspend` operation — unless a resume came after it: then the tenant ran
 * again, and was suspended later by a path that writes no record (the
 * subscription expiry check), and the counts are not what it ran at.
 */
async function suspensionRecord(db: Database, tenantId: string): Promise<QuiesceSnapshot | null> {
  const newest = async (opType: 'suspend' | 'resume') => (await db.select({ params: storageOperations.params, createdAt: storageOperations.createdAt })
    .from(storageOperations)
    .where(and(
      eq(storageOperations.tenantId, tenantId),
      eq(storageOperations.opType, opType),
      // A resume that failed did not start the tenant again.
      ...(opType === 'resume' ? [eq(storageOperations.state, 'idle')] : []),
    ))
    .orderBy(desc(storageOperations.createdAt)).limit(1))[0];
  const suspendOp = await newest('suspend');
  if (!suspendOp) return null;
  const resumeOp = await newest('resume');
  if (resumeOp && resumeOp.createdAt > suspendOp.createdAt) return null;
  return (suspendOp.params as { quiesceSnapshot?: QuiesceSnapshot } | null)?.quiesceSnapshot ?? null;
}


async function listManaged(k8s: K8sClients, kind: 'deployments' | 'cronjobs', namespace: string): Promise<Labelled[]> {
  const list = kind === 'deployments'
    ? await (k8s.apps as unknown as Lister).listNamespacedDeployment({ namespace, labelSelector: MANAGED })
    : await (k8s.batch as unknown as CronLister).listNamespacedCronJob({ namespace, labelSelector: MANAGED });
  return list.items ?? [];
}

interface Lister {
  listNamespacedDeployment(args: { namespace: string; labelSelector: string }): Promise<{ items?: Labelled[] }>;
}
interface CronLister {
  listNamespacedCronJob(args: { namespace: string; labelSelector: string }): Promise<{ items?: Labelled[] }>;
}
interface CronJobPatcher {
  patchNamespacedCronJob(args: { name: string; namespace: string; body: unknown }, options: unknown): Promise<unknown>;
}
