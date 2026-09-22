/**
 * Which restic repository a given bundle's snapshots live in (ADR-061).
 *
 * Tenant snapshots were split across `restic-files/<tenantId>` and
 * `restic-mailboxes/<tenantId>` because each component was migrated to restic
 * separately — not because the split was a boundary. One per-tenant password
 * already opens both. New bundles go to a single `restic/<tenantId>`.
 *
 * The merge moves no data, so BOTH layouts are live at once for as long as a
 * pre-merge bundle is inside its retention window. Everything that opens a
 * repository for a specific bundle must therefore ask THIS module which one,
 * rather than assume the current layout.
 *
 * Why that matters more than it sounds: restic does not fail when pointed at a
 * repository that does not contain a snapshot — it reports the snapshot as
 * absent. A wrong layout surfaces to an operator as "the backup is gone".
 */

import { eq } from 'drizzle-orm';

import { backupJobs } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { DEFAULT_REPO_LAYOUT, type ResticRepoLayout } from './restic-driver.js';

/**
 * Layout every NEW bundle is written to.
 *
 * STILL 'per-component' on purpose. Capture, restore, browse, export and DR
 * are all layout-aware already, but RETENTION is not: `restic-retention.ts`
 * rebuilds a repository URI from (tenant, component) and builds its keep-set
 * with `WHERE bc.component::text = <component>`. Point that at a merged
 * repository and the keep-set comes back EMPTY — the sweep would then forget
 * every snapshot it found. Flipping this constant before that module is
 * repo-centric would not "mostly work"; it would delete backups.
 *
 * Flip to 'per-tenant' in the same change that makes retention sweep per
 * REPOSITORY (grouping state rows by repo_uri and unioning the keep-set
 * across the components that share it), with tests for the empty-keep-set
 * case specifically.
 */
export const CURRENT_REPO_LAYOUT: ResticRepoLayout = 'per-component';

/**
 * Normalise a stored value. Anything unrecognised — NULL, empty, a value from
 * a newer platform — reads as the historical layout, because that is where
 * every bundle written before this field existed actually lives.
 */
export function normaliseRepoLayout(value: string | null | undefined): ResticRepoLayout {
  return value === 'per-tenant' ? 'per-tenant' : DEFAULT_REPO_LAYOUT;
}

/**
 * Resolve the layout for one bundle from its row.
 *
 * A bundle that has no row at all (deleted, or a foreign target being scanned
 * before import) resolves to the historical layout — the conservative answer,
 * since that is where anything old enough to have lost its row will be.
 */
export async function resolveBundleRepoLayout(
  db: Database,
  bundleId: string,
): Promise<ResticRepoLayout> {
  const [row] = await db
    .select({ repoLayout: backupJobs.repoLayout })
    .from(backupJobs)
    .where(eq(backupJobs.id, bundleId))
    .limit(1);
  return normaliseRepoLayout(row?.repoLayout ?? null);
}

/**
 * Both layouts, for the sweeps that are NOT scoped to one bundle — repository
 * statistics, retention, and the orphan reclaimer. During the transition a
 * tenant genuinely has snapshots in both places, and a sweep that looked at
 * only one would under-report storage and leave snapshots unreclaimed.
 */
export const ALL_REPO_LAYOUTS: ReadonlyArray<ResticRepoLayout> = ['per-component', 'per-tenant'];
