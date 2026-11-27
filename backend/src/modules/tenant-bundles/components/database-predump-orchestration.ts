/**
 * Clean-up after the files snapshot: the SQLite dumps a bundle wrote onto the
 * tenant's volume (sqlite-predump.ts). Standalone database instances are
 * backed up straight into restic and leave nothing there
 * (database-snapshots.ts).
 */
import { execInPod } from '../../../shared/k8s-exec.js';
import { FM_PLATFORM_CONTAINER } from '../../file-manager/protected-folder.js';

/**
 * Delete THIS bundle's SQLite dumps from the live tenant PVC AFTER the files
 * snapshot has captured them, so they never accumulate on the tenant's volume.
 * Best-effort: the capture removes earlier dumps before it writes new ones
 * (sqlite-predump.ts), which bounds what a failed clean-up leaves.
 */
export async function deletePredumpsFromPvc(args: {
  namespace: string;
  /** A file-manager pod the caller holds a lease on (file-manager/lease.ts). */
  fmPod: string;
  bundleId: string;
  kubeconfigPath?: string;
}): Promise<void> {
  const safe = args.bundleId.replace(/[^A-Za-z0-9._-]/g, '_');
  try {
    // The platform container: it sees the whole volume (R48).
    await execInPod(args.kubeconfigPath, args.namespace, args.fmPod, FM_PLATFORM_CONTAINER,
      ['sh', '-c', `find /data -type f -name 'predump-*-${safe}.*' -delete 2>/dev/null || true`]);
  } catch (err) {
    // Best-effort — the next capture removes it regardless.
    console.warn(
      `[bundle ${args.bundleId}] predump cleanup failed in ${args.namespace}/${args.fmPod}: ${(err as Error).message}`,
    );
  }
}
