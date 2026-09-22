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

import { and, eq } from 'drizzle-orm';

import { backupJobs, tenantResticRepoState } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { DEFAULT_REPO_LAYOUT, type ResticRepoLayout } from './restic-driver.js';

/**
 * Layout every NEW bundle is written to.
 *
 * Existing bundles are NOT moved. They keep the layout stamped on their row
 * and are read from the repository that holds them until they expire under
 * normal retention, at which point the legacy repositories are empty.
 *
 * Retention had to become repo-centric before this could flip: it derives the
 * layout from each state row's recorded `repo_uri`, and -- critically -- drops
 * the `bc.component` filter from its keep-set when the repository is merged,
 * because that repository holds every component. Filtering to one component
 * there would make the others' snapshots look unreferenced, and an
 * unreferenced snapshot is one the sweep forgets.
 */
export const CURRENT_REPO_LAYOUT: ResticRepoLayout = 'per-tenant';

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

/**
 * Derive the layout from a repository URI that was RECORDED when snapshots
 * were written to it (`tenant_restic_repo_state.repo_uri`).
 *
 * Why derive rather than trust the stored URI outright: the stored URI also
 * encodes the storage TARGET, which an operator can migrate. Callers rebuild
 * the URI against the live target — but they must rebuild it with the layout
 * the snapshots are actually in, and that is what this recovers.
 */
export function layoutFromRepoUri(
  repoUri: string | null | undefined,
  tenantId: string,
): ResticRepoLayout {
  if (!repoUri) return DEFAULT_REPO_LAYOUT;
  // `restic/<tenantId>` is the merged repo; `restic-files/<tenantId>` and
  // `restic-mailboxes/<tenantId>` are the split ones. Anchor on the segment
  // boundary so `restic-files` can never match `restic`.
  return repoUri.includes(`/restic/${tenantId}`) ? 'per-tenant' : DEFAULT_REPO_LAYOUT;
}

/**
 * The layout a given (tenant, component) repo-state row points at.
 *
 * Used by the sweeps, which iterate state rows rather than bundles. A tenant
 * mid-migration has rows for both, and a sweep that assumed one layout would
 * either skip the merged repository (snapshots never reclaimed) or point a
 * forget at the wrong one.
 */
export async function repoLayoutForStateRow(
  db: Database,
  tenantId: string,
  component: string,
): Promise<ResticRepoLayout> {
  const [row] = await db
    .select({ repoUri: tenantResticRepoState.repoUri })
    .from(tenantResticRepoState)
    .where(and(
      eq(tenantResticRepoState.tenantId, tenantId),
      eq(tenantResticRepoState.component, component),
    ))
    .limit(1);
  return layoutFromRepoUri(row?.repoUri, tenantId);
}
