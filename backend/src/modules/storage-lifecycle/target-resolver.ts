// Per-snapshot-class target resolver (Phase 3 of snapshot-storage overhaul).
//
// One entry point for every subsystem that needs to know "where does
// a snapshot of class X go right now?". After the Phase 2 legacy purge
// (2026-05-22) the routing table only stores rows for the three R-X
// shim classes (system / tenant / mail). Callers still pass the
// `SnapshotClass` enum values (tenant_snapshot, tenant_bundle,
// system_backup, system_mail) because those remain the category labels
// on existing `storage_snapshots` rows. This resolver translates the
// legacy category into the shim routing class internally:
//
//   tenant_snapshot, tenant_bundle  → tenant
//   system_backup                   → system
//   system_mail                     → mail
//
// Fallback behaviour: NONE. The locked decision is fail-loud — an
// unassigned class refuses to snapshot rather than silently writing
// to a default. Operators get NO_SNAPSHOT_TARGET + a deep link to
// the per-class Targets, Schedules & Retention tab in the UI.

import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { backupTargetAssignments, backupConfigurations } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { SnapshotClass } from '@insula/api-contracts';

/** R-X shim routing classes — the only values stored in
 *  `backup_target_assignments.backup_class` after the Phase 2 purge. */
type ShimClass = 'system' | 'tenant' | 'mail';

/**
 * Map a legacy snapshot category to its shim routing class. The
 * mapping is 1:1 and deterministic. Mirrors the gate-map in
 * backup-schedules/service.ts and backups-overview/service.ts so all
 * three modules agree on routing.
 */
function shimRoutingClassFor(backupClass: SnapshotClass): ShimClass {
  switch (backupClass) {
    case 'tenant_snapshot':
    case 'tenant_bundle':
      return 'tenant';
    case 'system_backup':
      return 'system';
    case 'system_mail':
      return 'mail';
  }
}

interface PrimaryTargetRow {
  readonly targetId: string;
  readonly targetName: string;
  readonly targetStorageType: string;
  readonly targetEnabled: number;
}

/**
 * Internal lookup: pick the lowest-priority assignment row for the
 * given shim class. Returns null if no row exists.
 */
async function lookupShimTarget(
  db: Database,
  shimClass: ShimClass,
): Promise<PrimaryTargetRow | null> {
  const [row] = await db
    .select({
      targetId: backupTargetAssignments.targetId,
      targetName: backupConfigurations.name,
      targetStorageType: backupConfigurations.storageType,
      targetEnabled: backupConfigurations.enabled,
    })
    .from(backupTargetAssignments)
    .innerJoin(backupConfigurations, eq(backupConfigurations.id, backupTargetAssignments.targetId))
    .where(eq(backupTargetAssignments.backupClass, shimClass))
    .orderBy(backupTargetAssignments.priority)
    .limit(1);
  return row ?? null;
}

export interface ResolvedSnapshotTarget {
  readonly backupClass: SnapshotClass;
  readonly targetId: string;
  readonly targetName: string;
  readonly targetStorageType: string;
}

/**
 * Resolve the primary backup target for a snapshot class. Throws
 * `NO_SNAPSHOT_TARGET` (HTTP 409) when no assignment exists — caller
 * surfaces this to the admin UI with a deep-link to the per-class
 * Targets, Schedules & Retention tab.
 */
export async function resolveTargetFor(
  db: Database,
  backupClass: SnapshotClass,
): Promise<ResolvedSnapshotTarget> {
  const shimClass = shimRoutingClassFor(backupClass);
  const primary = await lookupShimTarget(db, shimClass);
  if (!primary) {
    throw new ApiError(
      'NO_SNAPSHOT_TARGET',
      `No backup target bound to the '${shimClass}' class. ` +
      `Bind one at /backups/${shimClass} → Targets, Schedules & Retention.`,
      409,
    );
  }
  // Strict-primary semantics: a disabled primary MUST fail loudly
  // rather than silently failing over to the next-priority assignment.
  if (primary.targetEnabled !== 1) {
    throw new ApiError(
      'TARGET_DISABLED',
      `Primary backup target '${primary.targetName}' for the '${shimClass}' ` +
      `class is disabled. Either re-enable the target at /backups/targets ` +
      `or rebind the class at /backups/${shimClass}.`,
      503,
    );
  }
  return {
    backupClass,
    targetId: primary.targetId,
    targetName: primary.targetName,
    targetStorageType: primary.targetStorageType,
  };
}

/**
 * Soft variant — returns null instead of throwing. Used by code paths
 * that want to ask "is this class bound?" without crashing the whole
 * operation (e.g. admin UI status indicators).
 */
export async function maybeResolveTargetFor(
  db: Database,
  backupClass: SnapshotClass,
): Promise<ResolvedSnapshotTarget | null> {
  const shimClass = shimRoutingClassFor(backupClass);
  const primary = await lookupShimTarget(db, shimClass);
  if (!primary || primary.targetEnabled !== 1) return null;
  return {
    backupClass,
    targetId: primary.targetId,
    targetName: primary.targetName,
    targetStorageType: primary.targetStorageType,
  };
}
