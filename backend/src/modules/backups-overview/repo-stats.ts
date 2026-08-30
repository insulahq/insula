/**
 * On-demand measurement of a tenant's TRUE restic repository size.
 *
 * Why this is a button and not a column read: the only honest source is
 * `restic stats --mode raw-data` against the repository itself, which walks the
 * repo index over the network. Everything we already store answers a different
 * question —
 *
 *   tenant_restic_repo_state.last_repo_size_bytes
 *       bytes PROCESSED by the most recent snapshot. For an incremental run
 *       that is a small fraction of the repo: a production tenant with ~6 GB of
 *       files reported 176 MiB there.
 *
 *   SUM(backup_jobs.size_bytes)
 *       the logical size of every bundle. restic deduplicates across snapshots,
 *       so this overstates the storage actually consumed.
 *
 * Neither may be labelled "repo size", so this measures it properly and caches
 * the result with the time it was taken.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../../db/index.js';
import { tenantResticRepoState } from '../../db/schema.js';
import {
  runResticStats,
  buildResticRepoUri,
  deriveResticPassword,
} from '../tenant-bundles/restic-driver.js';
import { resolveShimBackupTarget } from '../tenant-bundles/resolve-backup-target.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export interface RefreshRepoStatsArgs {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly tenantId: string;
  readonly secretsKeyHex: string;
  readonly logger: FastifyBaseLogger;
}

export interface RepoStatsResult {
  /** Summed across every measured component. */
  readonly totalBytes: number;
  readonly measuredAt: string;
  /** Per-component detail, so a partial failure is visible rather than hidden
   *  inside a total that silently lost a component. */
  readonly components: ReadonlyArray<{
    readonly component: string;
    readonly totalBytes: number | null;
    readonly error: string | null;
  }>;
}

/**
 * Measure every component repo this tenant has, cache each, and return the sum.
 *
 * A component that fails is reported with its error and contributes nothing to
 * the total — one unreachable repo must not make the whole number silently
 * wrong. Its cached value is left alone rather than zeroed.
 */
export async function refreshTenantRepoStats(args: RefreshRepoStatsArgs): Promise<RepoStatsResult> {
  const { db, k8s, tenantId, secretsKeyHex, logger } = args;

  const stateRows = await db
    .select({ component: tenantResticRepoState.component })
    .from(tenantResticRepoState)
    .where(and(
      eq(tenantResticRepoState.tenantId, tenantId),
      isNotNull(tenantResticRepoState.repoUri),
    ));

  if (stateRows.length === 0) {
    // Nothing has ever been backed up for this tenant — there is no repo to
    // measure. Report zero components rather than inventing a 0-byte repo.
    return { totalBytes: 0, measuredAt: new Date().toISOString(), components: [] };
  }

  const target = await resolveShimBackupTarget(k8s.core, 'tenant', logger);
  const passwordHex = deriveResticPassword(secretsKeyHex, tenantId);
  const measuredAt = new Date();

  const components: Array<{ component: string; totalBytes: number | null; error: string | null }> = [];
  let total = 0;

  for (const { component } of stateRows) {
    const repoUri = buildResticRepoUri(target, tenantId, component as 'files' | 'mailboxes');
    try {
      const stats = await runResticStats({ target, passwordHex, repoUri });
      total += stats.totalSizeBytes;
      components.push({ component, totalBytes: stats.totalSizeBytes, error: null });
      await db.update(tenantResticRepoState)
        .set({ repoTotalBytes: stats.totalSizeBytes, repoStatsAt: measuredAt })
        .where(and(
          eq(tenantResticRepoState.tenantId, tenantId),
          eq(tenantResticRepoState.component, component),
        ));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ tenantId, component, err: msg }, 'restic stats failed for component');
      components.push({ component, totalBytes: null, error: msg.slice(0, 300) });
    }
  }

  return { totalBytes: total, measuredAt: measuredAt.toISOString(), components };
}
