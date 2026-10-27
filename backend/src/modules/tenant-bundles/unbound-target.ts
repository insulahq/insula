/**
 * Bundles on a backup target that tenant backups are no longer bound to.
 *
 * Insula never writes to such a target (an operator decision). Its
 * bundles are still READ from it — a restore goes through a read-only source
 * shim (backup-source-shim/) — but nothing deletes from it:
 *   - DELETE /admin/tenant-bundles/:id refuses with BUNDLE_ON_UNBOUND_TARGET;
 *   - expiry leaves such a bundle as it is, listed past its expiry date;
 *   - the restic reclaimer, which only looks into the bound target, does not
 *     take a snapshot's absence there for its deletion.
 * All three used to act on the BOUND target: the delete found nothing there
 * and dropped the row, expiry marked the bundle expired as "already gone", and
 * the reclaimer stamped its snapshots reclaimed so the row was purged — the
 * data stayed on the old target with nothing left that knew of it.
 *
 * Why not delete it on its own target: a bundle this cluster captured and one a
 * cross-cluster migration registered look the same (same row, same repository
 * paths), and writing to a migration source deletes the other cluster's
 * backups.
 *
 * Bound again, a target's bundles expire and delete as usual. Removed, its
 * bundles lose their link to it (ON DELETE SET NULL) and are handled like rows
 * from before bundles named their target — on the bound target.
 *
 * "Bound" is the database's binding, but deletes go through the shim, which
 * serves a new binding only once the reconciler has rolled it out. While the
 * two disagree (a switch rolling) the bound target counts as not known, and
 * everything above holds off — a rebind to delete a target's kept bundles would
 * otherwise expire them, or declare them reclaimed, against the target the shim
 * still served.
 */
import { inArray } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { backupConfigurations } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { ServedShimClients } from '../backup-rclone-shim/served.js';
import { boundTenantTargetId, needsSourceShim } from '../backup-source-shim/service.js';

/**
 * The bound tenant target — or that it is not known: it could not be read (no
 * key, a database or API error), or the shim does not serve it yet (switching).
 */
export type BoundTenantTarget =
  | { readonly known: true; readonly id: string | null }
  | { readonly known: false; readonly reason: 'unresolved' | 'switching' };

interface WarnLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** The target tenant backups are bound to — the winning `tenant` assignment — once the shim serves it. */
export async function resolveBoundTenantTarget(
  db: Database,
  k8s: ServedShimClients,
  log: WarnLog,
): Promise<BoundTenantTarget> {
  const key = process.env.PLATFORM_ENCRYPTION_KEY;
  if (!key) {
    log.warn({}, 'tenant-bundles: PLATFORM_ENCRYPTION_KEY not configured — cannot tell the bound tenant target');
    return { known: false, reason: 'unresolved' };
  }
  try {
    const { shimServesCurrentBindings } = await import('../backup-rclone-shim/served.js');
    const [id, served] = await Promise.all([boundTenantTargetId(db, key), shimServesCurrentBindings(db, k8s, key)]);
    return served ? { known: true, id } : { known: false, reason: 'switching' };
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'tenant-bundles: could not tell the bound tenant target');
    return { known: false, reason: 'unresolved' };
  }
}

/**
 * Pure. Whether a bundle written to `bundleTargetId` is on a target other than
 * the bound one — exactly when a restore reads it through a source shim. A
 * bundle that names no target counts as on the bound one, as everywhere else.
 * Null when the bound target is not known.
 */
export function onUnboundTarget(bundleTargetId: string | null, bound: BoundTenantTarget): boolean | null {
  if (bundleTargetId === null) return false;
  if (!bound.known) return null;
  return needsSourceShim(bundleTargetId, bound.id);
}

/**
 * Refuse to delete a bundle that is not on the bound target. A bound target
 * that cannot be told refuses too: the delete would drop the row of a bundle
 * that may be elsewhere.
 */
export async function requireBundleOnBoundTarget(
  db: Database,
  k8s: ServedShimClients,
  bundleTargetId: string | null,
  log: WarnLog,
): Promise<void> {
  const bound = await resolveBoundTenantTarget(db, k8s, log);
  const unbound = onUnboundTarget(bundleTargetId, bound);
  if (unbound === false) return;
  if (!bound.known && bound.reason === 'switching') {
    throw new ApiError(
      'BOUND_TARGET_SWITCHING',
      'Tenant backups are being switched to another backup target, so the bundle was not deleted',
      503,
      undefined,
      'Try again once the switch has finished (the backup shim has rolled onto the new target).',
    );
  }
  if (unbound === null) {
    throw new ApiError(
      'BOUND_TARGET_UNKNOWN',
      'Could not tell which backup target tenant backups are bound to, so the bundle was not deleted',
      503,
      undefined,
      'Try again in a moment. If it persists, check the backup target bindings under Backups → Targets.',
    );
  }
  const names = await targetNames(db, [bundleTargetId as string]);
  const name = names.get(bundleTargetId as string) ?? (bundleTargetId as string);
  throw new ApiError(
    'BUNDLE_ON_UNBOUND_TARGET',
    `This bundle is stored on '${name}', which tenant backups are no longer bound to. Insula does not delete from a target it is not bound to.`,
    409,
    { targetConfigId: bundleTargetId, targetName: name },
    `Bind tenant backups to '${name}' again to delete it here. Or remove that target under Backups → Targets: Insula then stops tracking where these bundles are, and their data stays on it.`,
  );
}

/**
 * Refuse to write a bundle "to" a target other than the bound one. Writes go
 * through the shim, which serves the bound target alone: the data would land
 * there while the row named the other — and, unbound, that row would then be
 * kept for good with its data somewhere it does not say. Mid-switch it waits.
 * A binding that cannot be read lets the write through, as before this check:
 * captures must not stop on it.
 */
export async function requireWriteToBoundTarget(
  db: Database,
  k8s: ServedShimClients,
  targetConfigId: string,
  log: WarnLog,
): Promise<void> {
  const bound = await resolveBoundTenantTarget(db, k8s, log);
  if (!bound.known) {
    if (bound.reason === 'switching') {
      throw new ApiError(
        'BOUND_TARGET_SWITCHING',
        'Tenant backups are being switched to another backup target, so no bundle was written',
        503,
        undefined,
        'Try again once the switch has finished (the backup shim has rolled onto the new target).',
      );
    }
    return;
  }
  // No tenant binding at all: the shim has no tenant bucket, and the caller's
  // own fallback (the legacy active target) decides, as before this check.
  if (bound.id === null || !needsSourceShim(targetConfigId, bound.id)) return;
  const names = await targetNames(db, [targetConfigId, bound.id]);
  const name = names.get(targetConfigId) ?? targetConfigId;
  const boundName = names.get(bound.id) ?? bound.id;
  throw new ApiError(
    'BUNDLE_TARGET_NOT_BOUND',
    `Bundles are written to the target tenant backups are bound to ('${boundName}'), not '${name}'`,
    409,
    { targetConfigId, targetName: name, boundTargetId: bound.id, boundTargetName: boundName },
    `Pick '${boundName}', or bind tenant backups to '${name}' first (Backups → Targets).`,
  );
}

export interface TargetPlacement {
  readonly name: string;
  readonly bound: boolean;
}

/**
 * Where each of these bundles is stored, for the admin views (one bound-target
 * lookup and one query for all). A bundle without a target, on a target that
 * is no longer configured, or when the bound target cannot be told: null.
 */
export async function targetPlacements(
  db: Database,
  k8s: ServedShimClients,
  bundleTargetIds: ReadonlyArray<string | null>,
  log: WarnLog,
): Promise<(targetConfigId: string | null) => TargetPlacement | null> {
  const ids = bundleTargetIds.filter((t): t is string => t !== null);
  if (ids.length === 0) return () => null;
  const [bound, names] = await Promise.all([resolveBoundTenantTarget(db, k8s, log), targetNames(db, ids)]);
  return (targetConfigId) => {
    const name = targetConfigId ? names.get(targetConfigId) : undefined;
    const unbound = onUnboundTarget(targetConfigId, bound);
    if (name === undefined || unbound === null) return null;
    return { name, bound: !unbound };
  };
}

/** id → name of the given backup targets; ids that are not configured are absent. */
export async function targetNames(db: Database, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: backupConfigurations.id, name: backupConfigurations.name })
    .from(backupConfigurations)
    .where(inArray(backupConfigurations.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.name]));
}
