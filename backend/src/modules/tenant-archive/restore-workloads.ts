/**
 * Bring an archived tenant's applications back when it is restored.
 *
 * Archive deleted every Deployment, CronJob and Service in the namespace, and
 * the volume; the `deployments` rows stayed (status 'stopped'), and the files
 * — the databases' data among them — are back on a fresh volume by the time
 * this runs. Each row is deployed again from its stored spec, as DR recover
 * does (catalog: `redeployWithCurrentConfig`, re-stamping each database's root
 * password onto its restored data; custom: `redeployCustomDeploymentRow`).
 *
 * Every row, not only the running ones: all of them read 'stopped' since the
 * suspension. What each ran at before it is in the suspension's own record —
 * the replica counts it scaled down from — and is set again after, 0 included:
 * an application the tenant had stopped before the suspension is stopped again.
 *
 * Never throws for one application: what failed is reported back, to be
 * redeployed from the tenant's page.
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
}

const say = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
          await redeployCustomDeploymentRow(db, k8s, tenantId, dep);
        } else {
          await redeployWithCurrentConfig(db, dep, k8s, { armPasswordReset: true });
        }
        redeployed += 1;
      } catch (err) {
        failures.push(`${dep.name}: ${say(err)}`);
      }
    }
  }

  // What the suspension scaled down from, put back.
  const [suspendOp] = await db.select({ params: storageOperations.params }).from(storageOperations)
    .where(and(eq(storageOperations.tenantId, tenantId), eq(storageOperations.opType, 'suspend')))
    .orderBy(desc(storageOperations.createdAt)).limit(1);
  const before = (suspendOp?.params as { quiesceSnapshot?: QuiesceSnapshot } | null)?.quiesceSnapshot;
  for (const d of before?.deployments ?? []) {
    // Exactly the count, 0 included — `unquiesce` reads 0 as nothing to do,
    // and a fresh deploy runs what the tenant had stopped.
    try {
      await (k8s.apps as unknown as DeploymentPatcher).patchNamespacedDeployment(
        { name: d.name, namespace, body: { spec: { replicas: d.replicas } } },
        MERGE_PATCH,
      );
    } catch (err) {
      if (!isNotFound(err)) failures.push(`${d.name}: replicas not set back to ${d.replicas} (${say(err)})`);
    }
  }
  return { total: rows.length, redeployed, failures };
}

interface DeploymentPatcher {
  patchNamespacedDeployment(args: { name: string; namespace: string; body: unknown }, options: unknown): Promise<unknown>;
}

function isNotFound(err: unknown): boolean {
  const e = err as { statusCode?: number; code?: number; body?: { code?: number } };
  return (e.statusCode ?? e.code ?? e.body?.code) === 404;
}
