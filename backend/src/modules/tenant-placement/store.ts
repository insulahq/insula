/**
 * Persistence for tenant placement (migration 0141).
 *
 * Every platform-api replica runs the reconciler; everything here is written
 * to be safe under that: the state upsert is idempotent, a failover event
 * inserts once (unique on volume + Longhorn's remount timestamp), and each
 * notification is claimed with a conditional UPDATE … RETURNING that exactly
 * one replica wins.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { tenantPlacementState, tenantStorageFailovers } from '../../db/schema.js';
import type { PlacementStatus, StorageFailoverObservation, TenantPlacementObservation } from './compute.js';

export interface StoredPlacement {
  readonly tenantId: string;
  readonly status: PlacementStatus;
  readonly primaryNode: string | null;
  readonly storageTier: 'local' | 'ha';
  readonly workloadNodes: readonly string[];
  readonly attachedNodes: readonly string[];
  readonly dataNodes: readonly string[];
  readonly actualNodes: readonly string[];
  readonly reasons: readonly string[];
  readonly misplacedSince: Date | null;
  readonly notifiedAt: Date | null;
  readonly checkedAt: Date;
}

export interface StoredFailover {
  readonly id: string;
  readonly tenantId: string;
  readonly volumeName: string;
  readonly pvcName: string | null;
  readonly remountRequestedAt: Date;
  readonly nodesBefore: readonly string[];
  readonly nodesAfter: readonly string[];
  readonly detectedAt: Date;
}

type PlacementRow = typeof tenantPlacementState.$inferSelect;
type FailoverRow = typeof tenantStorageFailovers.$inferSelect;

function toStoredPlacement(r: PlacementRow): StoredPlacement {
  return {
    tenantId: r.tenantId,
    status: r.status as PlacementStatus,
    primaryNode: r.primaryNode,
    storageTier: r.storageTier === 'ha' ? 'ha' : 'local',
    workloadNodes: r.workloadNodes,
    attachedNodes: r.attachedNodes,
    dataNodes: r.dataNodes,
    actualNodes: r.actualNodes,
    reasons: r.reasons,
    misplacedSince: r.misplacedSince,
    notifiedAt: r.notifiedAt,
    checkedAt: r.checkedAt,
  };
}

function toStoredFailover(r: FailoverRow): StoredFailover {
  return { ...r };
}

export async function loadPlacementStates(db: Database): Promise<Map<string, StoredPlacement>> {
  const rows = await db.select().from(tenantPlacementState);
  return new Map(rows.map((r) => [r.tenantId, toStoredPlacement(r)]));
}

export async function getPlacement(db: Database, tenantId: string): Promise<StoredPlacement | null> {
  const [row] = await db.select().from(tenantPlacementState).where(eq(tenantPlacementState.tenantId, tenantId));
  return row ? toStoredPlacement(row) : null;
}

export async function listPlacements(db: Database, tenantIds: readonly string[]): Promise<Map<string, StoredPlacement>> {
  if (tenantIds.length === 0) return new Map();
  const rows = await db.select().from(tenantPlacementState).where(inArray(tenantPlacementState.tenantId, [...tenantIds]));
  return new Map(rows.map((r) => [r.tenantId, toStoredPlacement(r)]));
}

/**
 * Write this tick's observations.
 *
 * `unknown` (incomplete cluster read) never overwrites known facts: the row
 * keeps the last good placement and its misplacement clock, and only a tenant
 * with no row yet gets an `unknown` one. `misplaced_since` survives while the
 * tenant stays misplaced and clears — with `notified_at`, re-arming the next
 * episode's notification — as soon as it is placed again.
 */
export async function savePlacementStates(
  db: Database,
  observations: readonly TenantPlacementObservation[],
  now: Date,
): Promise<void> {
  const known = observations.filter((o) => o.status !== 'unknown');
  const unknown = observations.filter((o) => o.status === 'unknown');

  if (known.length > 0) {
    await db.insert(tenantPlacementState).values(known.map((o) => ({
      tenantId: o.tenantId,
      status: o.status,
      primaryNode: o.primaryNode,
      storageTier: o.storageTier,
      workloadNodes: [...o.workloadNodes],
      attachedNodes: [...o.attachedNodes],
      dataNodes: [...o.dataNodes],
      actualNodes: [...o.actualNodes],
      reasons: [...o.reasons],
      misplacedSince: o.status === 'misplaced' ? now : null,
      notifiedAt: null,
      checkedAt: now,
    }))).onConflictDoUpdate({
      target: tenantPlacementState.tenantId,
      set: {
        status: sql`excluded.status`,
        primaryNode: sql`excluded.primary_node`,
        storageTier: sql`excluded.storage_tier`,
        workloadNodes: sql`excluded.workload_nodes`,
        attachedNodes: sql`excluded.attached_nodes`,
        dataNodes: sql`excluded.data_nodes`,
        actualNodes: sql`excluded.actual_nodes`,
        reasons: sql`excluded.reasons`,
        misplacedSince: sql`CASE WHEN excluded.status <> 'misplaced' THEN NULL
          WHEN ${tenantPlacementState.status} = 'misplaced'
            THEN COALESCE(${tenantPlacementState.misplacedSince}, excluded.misplaced_since)
          ELSE excluded.misplaced_since END`,
        notifiedAt: sql`CASE WHEN excluded.status = 'misplaced' AND ${tenantPlacementState.status} = 'misplaced'
          THEN ${tenantPlacementState.notifiedAt} ELSE NULL END`,
        checkedAt: sql`excluded.checked_at`,
      },
    });
  }

  if (unknown.length > 0) {
    await db.insert(tenantPlacementState).values(unknown.map((o) => ({
      tenantId: o.tenantId,
      status: 'unknown',
      primaryNode: o.primaryNode,
      storageTier: o.storageTier,
      checkedAt: now,
    }))).onConflictDoNothing({ target: tenantPlacementState.tenantId });
  }
}

/**
 * Record salvages not seen before. Returns only the rows THIS call inserted —
 * the claim for their notification. `nodesBefore` is where the tenant was on
 * the previous tick; `nodesAfter` where it is now.
 */
export async function recordStorageFailovers(
  db: Database,
  failovers: readonly StorageFailoverObservation[],
  before: ReadonlyMap<string, StoredPlacement>,
  after: ReadonlyMap<string, TenantPlacementObservation>,
): Promise<StoredFailover[]> {
  if (failovers.length === 0) return [];
  const rows = await db.insert(tenantStorageFailovers).values(failovers.map((f) => ({
    id: randomUUID(),
    tenantId: f.tenantId,
    volumeName: f.volumeName,
    pvcName: f.pvcName,
    remountRequestedAt: new Date(f.remountRequestedAt),
    nodesBefore: [...(before.get(f.tenantId)?.actualNodes ?? [])],
    nodesAfter: [...(after.get(f.tenantId)?.actualNodes ?? [])],
  }))).onConflictDoNothing({
    target: [tenantStorageFailovers.volumeName, tenantStorageFailovers.remountRequestedAt],
  }).returning();
  return rows.map(toStoredFailover);
}

export async function listStorageFailovers(db: Database, tenantId: string, limit = 10): Promise<StoredFailover[]> {
  const rows = await db.select().from(tenantStorageFailovers)
    .where(eq(tenantStorageFailovers.tenantId, tenantId))
    .orderBy(desc(tenantStorageFailovers.remountRequestedAt))
    .limit(limit);
  return rows.map(toStoredFailover);
}

/**
 * Claim the notification for every misplacement that has lasted `minAgeMs`
 * and was not yet announced. The age gate is hysteresis: a data-locality
 * rebuild or an operator migration is "misplaced" for the minutes it takes,
 * and must not page anyone.
 */
export async function claimMisplacedNotifications(
  db: Database,
  now: Date,
  minAgeMs: number,
): Promise<StoredPlacement[]> {
  const cutoff = new Date(now.getTime() - minAgeMs);
  const rows = await db.update(tenantPlacementState)
    .set({ notifiedAt: now })
    .where(and(
      eq(tenantPlacementState.status, 'misplaced'),
      isNull(tenantPlacementState.notifiedAt),
      lte(tenantPlacementState.misplacedSince, cutoff),
    ))
    .returning();
  return rows.map(toStoredPlacement);
}
