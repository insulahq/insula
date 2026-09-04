/**
 * Restore executor: `deployments-by-id`.
 *
 * Reads `components/config/db-rows.json.gz` from the bundle, picks
 * rows in the `deployments` table whose `id` matches the selector,
 * and UPSERTs them via INSERT … ON CONFLICT (id) DO UPDATE.
 *
 * For CATALOG deployments, cluster-side reconciliation (Kustomization,
 * NetworkPolicy, etc.) is left to the existing deployment lifecycle hooks —
 * they pick up DB changes on their next tick.
 *
 * CUSTOM deployments have no such hook. `custom-deployments/reconcile.ts` is a
 * STATUS reconciler: it reads the k8s Deployment and translates what it finds
 * into a DB status. It never creates a missing one. So a restored custom
 * deployment used to land in the DB and nowhere else — the tenant saw a row in
 * the panel, the cluster had nothing, and the status reconciler eventually
 * marked it failed. Its image-pull Secret was in the same position: the
 * credential ROW travels in the bundle (see the tenant-bundle config
 * component), the dockerconfigjson Secret does not.
 *
 * So this executor re-applies custom rows itself, reusing
 * `redeployCustomDeploymentRow` — the same path DR recover uses, which goes
 * through `deployToCluster` and therefore re-materialises the pull Secret from
 * the restored credential row. A `reconcilePullSecrets` sweep runs first so
 * that credentials belonging to deployments NOT in this restore (or whose
 * redeploy fails) still get their Secret back.
 *
 * Re-apply failures are recorded in the item's progress message, never thrown:
 * the DB restore itself succeeded, and failing the whole item would hide that.
 *
 * Selector shapes (per api-contracts/restore.ts):
 *   { kind: 'all' }                         — restore every deployment in bundle
 *   { kind: 'ids', deploymentIds: ['dep-…', …] }
 */

import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { BackupStore } from '../../tenant-bundles/bundle-store.js';
import { deployments, type RestoreItem } from '../../../db/schema.js';
import { readAndAuthorizeConfigDump, applyIdFilteredUpsert } from './_shared.js';

interface Selector {
  kind: 'all' | 'ids';
  deploymentIds?: readonly string[];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown error';
}

/** Statuses that mean "deliberately not running". Re-starting a deployment the
 *  tenant had stopped would be a surprise, not a restore. */
const REDEPLOY_SKIP_STATUSES = new Set(['stopped', 'suspended', 'archived', 'deleted']);

/**
 * Bring restored CUSTOM deployments back up in the cluster.
 *
 * Best-effort by design — returns a human-readable summary appended to the
 * restore item's progress message rather than throwing, because the DB restore
 * itself already succeeded and failing the item would hide that.
 */
async function reapplyCustomDeployments(
  app: FastifyInstance,
  restoredIds: readonly string[],
): Promise<string> {
  let k8s: Awaited<ReturnType<typeof import('../../k8s-provisioner/k8s-client.js')['createK8sClients']>> | undefined;
  try {
    const { createK8sClients } = await import('../../k8s-provisioner/k8s-client.js');
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    k8s = createK8sClients(kubeconfigPath);
  } catch (err) {
    app.log.warn(
      { module: 'restore-deployments', err: errMsg(err) },
      'restore: k8s clients unavailable — custom deployments restored to the DB only',
    );
    return 'custom workloads NOT re-applied (cluster unreachable)';
  }

  const rows = restoredIds.length > 0
    ? await app.db.select().from(deployments).where(and(
        inArray(deployments.id, [...restoredIds]),
        eq(deployments.source, 'custom'),
      ))
    : [];
  const custom = rows.filter((r) => r.customSpec);
  if (custom.length === 0) return '';

  // Secrets first, and for the whole tenant rather than just this cart: a
  // credential whose deployment is not part of this restore still needs its
  // Secret back, and the sweep is idempotent.
  const tenantIds = [...new Set(custom.map((r) => r.tenantId))];
  const { reconcilePullSecrets } = await import('../../custom-deployments/pull-secret-reconciler.js');
  let secretsRepaired = 0;
  for (const tenantId of tenantIds) {
    try {
      const summary = await reconcilePullSecrets(app.db, k8s, { tenantId });
      secretsRepaired += summary.repaired;
      for (const f of summary.failures) {
        app.log.warn(
          { module: 'restore-deployments', tenantId, deploymentId: f.deploymentId, reason: f.reason },
          'restore: image-pull Secret could not be rebuilt',
        );
      }
    } catch (err) {
      app.log.warn(
        { module: 'restore-deployments', tenantId, err: errMsg(err) },
        'restore: pull-secret reconcile failed',
      );
    }
  }

  const { redeployCustomDeploymentRow } = await import('../../custom-deployments/service.js');
  let redeployed = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const row of custom) {
    if (REDEPLOY_SKIP_STATUSES.has(row.status)) { skipped += 1; continue; }
    try {
      await redeployCustomDeploymentRow(app.db, k8s, row.tenantId, row);
      redeployed += 1;
    } catch (err) {
      // The cross-cluster case is worth naming: the PAT is envelope-encrypted
      // with the SOURCE cluster's PLATFORM_ENCRYPTION_KEY, so restoring onto a
      // DIFFERENT cluster throws PAT_DECRYPT_FAILED. The row is there; the
      // tenant just has to re-enter the token.
      failures.push(`${row.name}: ${errMsg(err)}`);
      app.log.warn(
        { module: 'restore-deployments', deploymentId: row.id, err: errMsg(err) },
        'restore: custom deployment re-apply failed',
      );
    }
  }

  const parts = [`re-applied ${redeployed}/${custom.length} custom workload(s)`];
  if (secretsRepaired > 0) parts.push(`${secretsRepaired} pull secret(s) rebuilt`);
  if (skipped > 0) parts.push(`${skipped} left stopped`);
  if (failures.length > 0) parts.push(`${failures.length} failed: ${failures.slice(0, 3).join('; ')}`);
  return parts.join(', ');
}

export async function execDeploymentsByIdItem(args: {
  app: FastifyInstance;
  item: RestoreItem;
  store: BackupStore;
}): Promise<void> {
  const { app, item, store } = args;
  const selector = item.selector as unknown as Selector;
  const dump = await readAndAuthorizeConfigDump({ app, item, store });

  let ids: 'all' | readonly string[];
  if (selector.kind === 'all') {
    ids = 'all';
  } else if (selector.kind === 'ids' && Array.isArray(selector.deploymentIds) && selector.deploymentIds.length > 0) {
    ids = selector.deploymentIds;
  } else {
    throw new Error(`deployments-by-id: unsupported selector ${JSON.stringify(selector)}`);
  }

  await applyIdFilteredUpsert({
    app,
    item,
    dump,
    cartItemTable: 'deployments',
    sqlTable: 'deployments',
    ids,
    bundleSizeBytes: JSON.stringify(dump.tables.deployments ?? []).length,
  });

  // Which ids actually landed — 'all' means every deployment row in the bundle.
  const bundleRows = (dump.tables.deployments ?? []) as Array<Record<string, unknown>>;
  const restoredIds = (ids === 'all'
    ? bundleRows.map((r) => r.id)
    : ids
  ).filter((v): v is string => typeof v === 'string');

  const summary = await reapplyCustomDeployments(app, restoredIds);
  if (summary) {
    await app.db.execute(sql`
      UPDATE restore_items
      SET progress_message = COALESCE(progress_message, '') || ${`; ${summary}`}
      WHERE id = ${item.id}
    `);
  }
}
