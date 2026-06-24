/**
 * Strict existence check for a CNPG source cluster, used by the pg-dump
 * POST route to reject up-front instead of spawning a Job that hangs.
 *
 * WHY (issue #128): a pg_dump against a non-existent CNPG cluster (e.g.
 * `mail-db` after the RocksDB DataStore migration removed it) spawns a
 * Job whose `pg_dump` blocks on the dead `<cluster>-ro` Service until the
 * Job's `activeDeadlineSeconds` (90 min) SIGKILLs it. Because k8s kills
 * the process rather than raising an exception, the orchestrator's
 * catch-path never runs, so the `system_backup_runs` row stays in
 * 'running' the whole time and any poller waits out its own timeout.
 * Validating the Cluster CR exists at POST time fails fast with a clear
 * 404 and never creates a run or Job.
 *
 * Pure over the k8s seam — unit-testable without a cluster.
 */
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const CNPG_GROUP = 'postgresql.cnpg.io';
const CNPG_VERSION = 'v1';

export class CnpgClusterNotFoundError extends Error {
  constructor(
    readonly namespace: string,
    readonly cluster: string,
  ) {
    super(`CNPG cluster ${namespace}/${cluster} not found`);
    this.name = 'CnpgClusterNotFoundError';
  }
}

function statusCodeOf(err: unknown): number | undefined {
  return (
    (err as { statusCode?: number }).statusCode
    ?? (err as { code?: number }).code
    ?? (err as { body?: { code?: number } }).body?.code
  );
}

/**
 * Throws {@link CnpgClusterNotFoundError} if the named CNPG Cluster CR
 * does not exist in `namespace`. A 404 is the only "absent" signal; any
 * other error (RBAC, transient apiserver) is re-thrown so the caller's
 * 5xx path handles it rather than masking infra problems as "not found".
 */
export async function assertCnpgClusterExists(
  k8s: K8sClients,
  namespace: string,
  cluster: string,
): Promise<void> {
  const custom = k8s.custom as unknown as {
    getNamespacedCustomObject: (a: {
      group: string; version: string; namespace: string; plural: string; name: string;
    }) => Promise<unknown>;
  };
  try {
    await custom.getNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace, plural: 'clusters', name: cluster,
    });
  } catch (err) {
    if (statusCodeOf(err) === 404) throw new CnpgClusterNotFoundError(namespace, cluster);
    throw err;
  }
}
