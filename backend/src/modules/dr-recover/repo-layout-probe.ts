/**
 * Does the per-tenant restic repository (ADR-061 `restic/<tenantId>`) hold a
 * snapshot of this bundle?
 *
 * Asked only when a bundle reaches this cluster without a `repoLayout` in its
 * meta.json (see `resolveForeignBundleRepoLayout`). It opens the repository
 * the restore will open — the tenant-class shim, the per-tenant password —
 * and narrows `restic snapshots` to the bundle's own `bundle-id=` tag, so a
 * tenant that holds BOTH layouts (older bundles still in retention) resolves
 * per bundle, not per tenant.
 */

import type { FastifyInstance } from 'fastify';

import { ApiError } from '../../shared/errors.js';
import { resolveShimBackupTarget } from '../tenant-bundles/resolve-backup-target.js';
import {
  buildResticRepoUri,
  deriveResticPassword,
  isResticRepoMissingError,
  listResticSnapshots,
} from '../tenant-bundles/restic-driver.js';

export async function bundleHasPerTenantSnapshots(
  app: FastifyInstance,
  tenantId: string,
  bundleId: string,
): Promise<boolean> {
  const config = app.config as Record<string, unknown>;
  const secretsKeyHex = (config.PLATFORM_ENCRYPTION_KEY as string | undefined)
    ?? process.env.PLATFORM_ENCRYPTION_KEY;
  if (!secretsKeyHex) {
    throw new ApiError('CONFIG_INVALID', 'PLATFORM_ENCRYPTION_KEY not configured', 500);
  }
  const kubeconfigPath = (config.KUBECONFIG_PATH as string | undefined)
    ?? process.env.KUBECONFIG_PATH ?? process.env.KUBECONFIG;
  const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
  const target = await resolveShimBackupTarget(createK8sClients(kubeconfigPath).core, 'tenant', app.log);
  // The component argument is ignored by the per-tenant layout.
  const repoUri = buildResticRepoUri(target, tenantId, 'files', 'per-tenant');

  try {
    const snapshots = await listResticSnapshots({
      target,
      passwordHex: deriveResticPassword(secretsKeyHex, tenantId),
      repoUri,
      readOnly: true,
      tagFilters: [`bundle-id=${bundleId}`],
    });
    return snapshots.length > 0;
  } catch (err) {
    // No per-tenant repository at all: the bundle predates the merge.
    if (isResticRepoMissingError(err)) return false;
    // Anything else (wrong password, shim unreachable) is NOT an answer.
    // Guessing per-component here is exactly the bug this probe exists to
    // fix: the restore would then report the backup as gone.
    throw new ApiError(
      'DR_REPO_LAYOUT_UNKNOWN',
      `Cannot tell which restic repository holds bundle '${bundleId}': ${err instanceof Error ? err.message : String(err)}`,
      502,
      { bundle_id: bundleId, tenant_id: tenantId },
      "Check that the tenant-class backup target is reachable and that this cluster's PLATFORM_ENCRYPTION_KEY matches the source cluster's, then retry.",
    );
  }
}
