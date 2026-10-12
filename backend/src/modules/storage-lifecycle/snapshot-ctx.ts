import type { SnapshotClass } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/**
 * The service context for an operation that WRITES a snapshot of the given
 * class (an archive): the store the class is assigned to in
 * `backup_target_assignments`, and that target's id for the snapshot row.
 * Throws NO_SNAPSHOT_TARGET (409) when the class is unassigned.
 */
export async function buildSnapshotServiceCtx(
  db: Database,
  k8s: K8sClients,
  config: Record<string, unknown>,
  backupClass: SnapshotClass,
) {
  const { resolveSnapshotStoreForClass } = await import('./snapshot-store.js');
  const platformNamespace = (config.PLATFORM_NAMESPACE as string | undefined) ?? 'platform';
  const bundle = await resolveSnapshotStoreForClass(
    db,
    config as Record<string, string | undefined>,
    backupClass,
    // k8s ctx for CIFS read paths.
    { k8sCtx: { k8s, namespace: platformNamespace } },
  );
  return {
    db,
    k8s,
    store: bundle.store,
    platformNamespace,
    targetId: bundle.targetId,
    backupClass,
  };
}

/**
 * The context an ARCHIVE is taken with: archives are tenant snapshots, so
 * they go to the target that class is assigned to.
 */
export function buildArchiveServiceCtx(db: Database, k8s: K8sClients, config: Record<string, unknown>) {
  return buildSnapshotServiceCtx(db, k8s, config, 'tenant_snapshot');
}
