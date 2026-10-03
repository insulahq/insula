/**
 * The bundle's use of the tenant's file manager — ONE lease per bundle.
 *
 * Two bundle steps exec into the file manager: the SQLite pre-dump (before the
 * files capture) and the predump cleanup (after it). Each used to start the
 * file manager on its own, and the idle loop scaled it down between them — so
 * every nightly bundle started every tenant's file manager twice, and the
 * first start was often killed mid-dump. Now the bundle holds one lease:
 *
 *   acquire → SQLite pre-dump → (nothing dumped? release now)
 *           → files capture   → predump cleanup → release
 *
 * Most tenants have no database and no SQLite file, so for them the file
 * manager is up for the length of the SQLite discovery and handed straight
 * back. A tenant with predumps keeps it through the capture, because the
 * cleanup needs it afterwards and a second start costs more than holding one.
 */
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import type { BackupDatabaseDumps } from '@insula/api-contracts';
import type { FileManagerLease } from '../../file-manager/lease.js';
import type { PreDumpDeploymentResult } from './database-predump.js';

type DumpDeployment = BackupDatabaseDumps['deployments'][number];

export type AcquireLease = (k8s: K8sClients, namespace: string, purpose: string) => Promise<FileManagerLease>;

/**
 * Did this bundle leave predump files on the live PVC? Any attempted database
 * dump counts — a failed one can leave a partial file — and any SQLite dump
 * that was written. Pure.
 */
export function predumpsNeedCleanup(
  dbResults: ReadonlyArray<PreDumpDeploymentResult>,
  sqlite: DumpDeployment | null,
): boolean {
  const dbAttempted = dbResults.some((r) => r.databaseDumps.length + r.databaseFailures.length > 0);
  const sqliteWritten = (sqlite?.databases ?? []).some((d) => d.status === 'dumped');
  return dbAttempted || sqliteWritten;
}

/**
 * Lease the file manager for this bundle, or null — with the reason logged —
 * when it cannot be started. Not a bundle failure: the raw-files snapshot
 * still captures any SQLite file, and the retention-window prune bounds any
 * predump left on the PVC.
 */
export async function leaseBundleFileManager(
  k8s: K8sClients,
  namespace: string,
  bundleId: string,
  acquire: AcquireLease,
): Promise<FileManagerLease | null> {
  try {
    return await acquire(k8s, namespace, 'bundle');
  } catch (err) {
    console.warn(
      `[bundle ${bundleId}] file manager not available in ${namespace} — sqlite pre-dump and predump `
      + `cleanup skipped (${(err as Error).message})`,
    );
    return null;
  }
}
