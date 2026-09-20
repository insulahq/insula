/**
 * tenant_restic_repo_state upsert helpers (Phase 1 piece #6, ADR-047).
 *
 * After a successful `restic backup` snapshot, the orchestrator
 * upserts a row that records:
 *   - which repo URI received the snapshot (so retention sweeper +
 *     cross-region browse can reach it without re-resolving the
 *     BackupConfiguration)
 *   - which snapshot id (full 64-char) is the most recent
 *   - which bundle produced it
 *   - bytes processed (for the per-tenant storage cost UI)
 *   - source region id (slugified PLATFORM_BASE_DOMAIN; informational
 *     on local repos, mandatory for restored-from-external rows)
 *   - bundle schema version that wrote it
 *
 * Single-row PK is (tenantId, component) — every backup overwrites
 * the last_snapshot_* fields. The history of snapshots lives in
 * restic itself (`restic snapshots`); this row is a fast-lookup
 * cache for the admin UI and the retention sweeper.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import {
  tenantResticRepoState,
  type NewTenantResticRepoState,
} from '../../db/schema.js';
import { BUNDLE_SCHEMA_VERSION } from './restic-driver.js';

export interface RecordResticSnapshotArgs {
  readonly db: Database;
  readonly tenantId: string;
  readonly component: 'files' | 'mailboxes';
  readonly repoUri: string;
  readonly targetConfigId: string | null;
  readonly snapshotId: string;
  readonly backupJobId: string;
  readonly sizeBytes: number;
  readonly regionId: string;
  readonly snapshotAt: Date;
  /**
   * `data_added_packed` from this snapshot's restic summary — the bytes the
   * snapshot actually added to the repository. Advances `repo_total_bytes`
   * so the admin UI has a live repo size without paying for `restic stats`.
   *
   * NULL = the snapshot did not report one. The accumulator is then left
   * untouched rather than advanced by 0, so `repo_total_at` keeps saying when
   * the total was last genuinely updated.
   */
  readonly dataAddedPacked: number | null;
}

/**
 * Upsert the per-tenant restic state. Conflict on PK (tenantId,
 * component) — last_* fields overwritten on every successful capture.
 */
export async function recordResticSnapshot(args: RecordResticSnapshotArgs): Promise<void> {
  const row: NewTenantResticRepoState = {
    tenantId: args.tenantId,
    component: args.component,
    repoUri: args.repoUri,
    targetConfigId: args.targetConfigId,
    lastSnapshotId: args.snapshotId,
    lastBackupJobId: args.backupJobId,
    lastRepoSizeBytes: args.sizeBytes,
    lastSnapshotAt: args.snapshotAt,
    lastRunAt: args.snapshotAt,
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    sourceRegionId: args.regionId,
  };
  await args.db
    .insert(tenantResticRepoState)
    .values(row)
    .onConflictDoUpdate({
      target: [tenantResticRepoState.tenantId, tenantResticRepoState.component],
      set: {
        repoUri: sql`excluded.repo_uri`,
        targetConfigId: sql`excluded.target_config_id`,
        lastSnapshotId: sql`excluded.last_snapshot_id`,
        lastBackupJobId: sql`excluded.last_backup_job_id`,
        lastRepoSizeBytes: sql`excluded.last_repo_size_bytes`,
        lastSnapshotAt: sql`excluded.last_snapshot_at`,
        lastRunAt: sql`excluded.last_run_at`,
        bundleSchemaVersion: sql`excluded.bundle_schema_version`,
        sourceRegionId: sql`excluded.source_region_id`,
        // Advance the tracked repo total — but ONLY on a row that already has
        // one. Accumulating from NULL would produce "bytes added since we
        // started counting" and present it as the repo size, which for a
        // tenant with 26 existing snapshots understates it by orders of
        // magnitude. A confidently wrong number is worse than "not measured",
        // so an unanchored row stays NULL until the reclamation sweep seeds it
        // with a real measurement (see anchorResticRepoTotal).
        //
        // The bare table reference is the EXISTING row in an ON CONFLICT SET
        // clause; `excluded.*` would be the row we tried to insert.
        repoTotalBytes: sql`CASE
          WHEN ${tenantResticRepoState.repoTotalBytes} IS NULL THEN NULL
          WHEN ${args.dataAddedPacked}::bigint IS NULL THEN ${tenantResticRepoState.repoTotalBytes}
          ELSE ${tenantResticRepoState.repoTotalBytes} + ${args.dataAddedPacked}::bigint
        END`,
        repoTotalSource: sql`CASE
          WHEN ${tenantResticRepoState.repoTotalBytes} IS NULL THEN ${tenantResticRepoState.repoTotalSource}
          WHEN ${args.dataAddedPacked}::bigint IS NULL THEN ${tenantResticRepoState.repoTotalSource}
          ELSE 'tracked'
        END`,
        repoTotalAt: sql`CASE
          WHEN ${tenantResticRepoState.repoTotalBytes} IS NULL THEN ${tenantResticRepoState.repoTotalAt}
          WHEN ${args.dataAddedPacked}::bigint IS NULL THEN ${tenantResticRepoState.repoTotalAt}
          ELSE ${args.snapshotAt}
        END`,
      },
    });
}

/**
 * Write an AUTHORITATIVE repo size — the result of `restic stats --mode
 * raw-data` — and reset the tracking anchor.
 *
 * Called from two places: the operator's Refresh button, and the reclamation
 * sweep (after a prune, and once for any component that has never been
 * measured). Both stamp `repoStatsAt`, which is what lets the UI distinguish
 * "verified just now" from "tracked since a measurement four days ago".
 *
 * Uses UPDATE, not upsert: a component with no state row has never been backed
 * up, so there is nothing to anchor and nothing to create.
 */
export async function anchorResticRepoTotal(args: {
  readonly db: Database;
  readonly tenantId: string;
  readonly component: string;
  readonly totalBytes: number;
  readonly measuredAt: Date;
}): Promise<void> {
  await args.db
    .update(tenantResticRepoState)
    .set({
      repoTotalBytes: args.totalBytes,
      repoStatsAt: args.measuredAt,
      repoTotalAt: args.measuredAt,
      repoTotalSource: 'measured',
    })
    .where(and(
      eq(tenantResticRepoState.tenantId, args.tenantId),
      eq(tenantResticRepoState.component, args.component),
    ));
}

/**
 * Mark the run timestamp without recording a successful snapshot.
 * Used when the capture failed mid-stream — keeps last_run_at fresh
 * for "stale tenant" alerts without claiming a snapshot we don't
 * have.
 */
export async function recordResticRunFailed(args: {
  readonly db: Database;
  readonly tenantId: string;
  readonly component: 'files' | 'mailboxes';
  readonly runAt: Date;
}): Promise<void> {
  // INSERT path uses a dummy repoUri because the row may not exist
  // yet (first-ever attempt that failed). On conflict we only bump
  // last_run_at; repoUri stays whatever the prior successful run
  // wrote.
  await args.db
    .insert(tenantResticRepoState)
    .values({
      tenantId: args.tenantId,
      component: args.component,
      repoUri: '',
      lastRunAt: args.runAt,
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    } as NewTenantResticRepoState)
    .onConflictDoUpdate({
      target: [tenantResticRepoState.tenantId, tenantResticRepoState.component],
      set: {
        lastRunAt: sql`excluded.last_run_at`,
      },
    });
}
