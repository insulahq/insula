/**
 * Tenant on-server volume snapshots — service layer.
 *
 * Longhorn CSI VolumeSnapshot (`volumeSnapshotClassName: longhorn`, which is
 * `type=snap` → an in-cluster Longhorn snapshot, NO off-site upload). These
 * are short-term PVC recovery points the tenant manages from the tenant panel.
 * They auto-expire after `system_settings.snapshot_expiry_hours` (the reaper in
 * scheduler.ts deletes the VolumeSnapshot CR — Longhorn snapshot cascades via
 * deletionPolicy=Delete — and the DB row). They are NOT backups: the real
 * backups are the off-site tenant bundles (restic).
 *
 * Why a DB mirror of the CR: the tenant panel needs label + expiry + creation
 * metadata the bare VolumeSnapshot doesn't carry, and the reaper needs an
 * indexed `expires_at` to sweep without listing every namespace.
 */

import { randomUUID } from 'node:crypto';
import { eq, and, ne, lt, desc } from 'drizzle-orm';
import { tenants, tenantVolumeSnapshots, storageOperations, type TenantVolumeSnapshot } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { getSettings } from '../system-settings/service.js';
import { ApiError } from '../../shared/errors.js';
import type { TenantSnapshot, TenantSnapshotStatus } from '@insula/api-contracts';

const SNAPSHOT_API = 'snapshot.storage.k8s.io';
/** The `longhorn` VolumeSnapshotClass uses Longhorn `type=snap` → in-cluster
 *  snapshot, no BackupTarget upload. deletionPolicy=Delete, so removing the
 *  VolumeSnapshot removes the Longhorn snapshot. */
const SNAPSHOT_CLASS = 'longhorn';
/** Abuse guard: cap live snapshots per tenant. Expiry bounds accumulation over
 *  time; this bounds a burst. */
const MAX_SNAPSHOTS_PER_TENANT = 20;

export interface Deps {
  readonly db: Database;
  readonly k8s: K8sClients;
}

// ─── live VolumeSnapshot status shape (subset we read) ──────────────────────
interface VolumeSnapshotLive {
  readonly metadata?: { readonly name?: string; readonly labels?: Record<string, string> };
  readonly status?: {
    readonly readyToUse?: boolean;
    readonly restoreSize?: string;
    readonly error?: { readonly message?: string };
  };
}

// ─── CustomObjects helpers (mirror postgres-restore/service.ts) ─────────────
async function createVolumeSnapshot(k8s: K8sClients, namespace: string, body: unknown): Promise<void> {
  await k8s.custom.createNamespacedCustomObject({
    group: SNAPSHOT_API, version: 'v1', namespace, plural: 'volumesnapshots', body,
  } as unknown as Parameters<typeof k8s.custom.createNamespacedCustomObject>[0]);
}

async function listVolumeSnapshots(k8s: K8sClients, namespace: string, labelSelector: string): Promise<VolumeSnapshotLive[]> {
  const r = await (k8s.custom as unknown as {
    listNamespacedCustomObject: (a: { group: string; version: string; namespace: string; plural: string; labelSelector?: string }) => Promise<{ items?: VolumeSnapshotLive[] }>;
  }).listNamespacedCustomObject({ group: SNAPSHOT_API, version: 'v1', namespace, plural: 'volumesnapshots', labelSelector });
  return r.items ?? [];
}

async function deleteVolumeSnapshot(k8s: K8sClients, namespace: string, name: string): Promise<void> {
  try {
    await k8s.custom.deleteNamespacedCustomObject({
      group: SNAPSHOT_API, version: 'v1', namespace, plural: 'volumesnapshots', name,
    } as unknown as Parameters<typeof k8s.custom.deleteNamespacedCustomObject>[0]);
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code ?? (err as { statusCode?: number }).statusCode;
    if (code !== 404) throw err;
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────
function parseQuantityToBytes(q: string | undefined): number {
  if (!q) return 0;
  const m = /^(\d+(?:\.\d+)?)\s*([KMGTP]i?)?$/.exec(q.trim());
  if (!m) return 0;
  const value = Number(m[1]);
  const unit = m[2];
  const bin: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5 };
  const dec: Record<string, number> = { K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 };
  if (!unit) return value;
  return Math.round(value * (bin[unit] ?? dec[unit] ?? 1));
}

/**
 * Build the VolumeSnapshot manifest. `volumeSnapshotClassName: longhorn` is
 * Longhorn `type=snap` (in-cluster snapshot, NO off-site upload) — the whole
 * point of these being "on-server only". Labels let the reaper + list path
 * find a tenant's snapshots without enumerating every CR.
 */
export function buildVolumeSnapshotManifest(args: {
  namespace: string;
  vsName: string;
  pvcName: string;
  tenantId: string;
  snapshotId: string;
}): Record<string, unknown> {
  return {
    apiVersion: `${SNAPSHOT_API}/v1`,
    kind: 'VolumeSnapshot',
    metadata: {
      name: args.vsName,
      namespace: args.namespace,
      labels: {
        'insula.host/tenant-snapshot': 'true',
        'insula.host/tenant-id': args.tenantId,
        'insula.host/snapshot-id': args.snapshotId,
      },
    },
    spec: {
      volumeSnapshotClassName: SNAPSHOT_CLASS,
      source: { persistentVolumeClaimName: args.pvcName },
    },
  };
}

async function mustGetTenant(db: Database, tenantId: string) {
  const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!t) throw new ApiError('TENANT_NOT_FOUND', `Tenant ${tenantId} not found`, 404);
  if (!t.kubernetesNamespace) throw new ApiError('CONFIG_INVALID', `Tenant ${tenantId} has no kubernetes namespace`, 400);
  return t;
}

function toApi(row: TenantVolumeSnapshot): TenantSnapshot {
  return {
    id: row.id,
    tenantId: row.tenantId,
    label: row.label,
    status: row.status as TenantSnapshotStatus,
    sizeBytes: row.sizeBytes,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    readyAt: row.readyAt ? row.readyAt.toISOString() : null,
    expiresAt: row.expiresAt.toISOString(),
  };
}

// ─── public API ─────────────────────────────────────────────────────────────

export async function createSnapshot(
  deps: Deps,
  tenantId: string,
  opts: { label?: string | null; triggeredByUserId?: string | null },
): Promise<TenantSnapshot> {
  const { db, k8s } = deps;
  const tenant = await mustGetTenant(db, tenantId);
  const namespace = tenant.kubernetesNamespace!;
  const pvcName = `${namespace}-storage`;

  // Burst guard: count the tenant's USABLE snapshots. `error` rows hold no
  // snapshot data — excluding them means a k8s outage that fails N creates
  // can't lock the tenant out of their own quota until expiry.
  const existing = await db.select({ id: tenantVolumeSnapshots.id })
    .from(tenantVolumeSnapshots)
    .where(and(
      eq(tenantVolumeSnapshots.tenantId, tenantId),
      ne(tenantVolumeSnapshots.status, 'error'),
    ));
  if (existing.length >= MAX_SNAPSHOTS_PER_TENANT) {
    throw new ApiError(
      'SNAPSHOT_LIMIT_REACHED',
      `You already have ${existing.length} snapshots (max ${MAX_SNAPSHOTS_PER_TENANT}). Delete some, or wait for the oldest to expire.`,
      409,
    );
  }

  const settings = await getSettings(db);
  const expiryHours = settings.snapshotExpiryHours;
  const id = randomUUID();
  const vsName = `tvs-${id}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiryHours * 60 * 60 * 1000);

  await db.insert(tenantVolumeSnapshots).values({
    id,
    tenantId,
    namespace,
    pvcName,
    volumeSnapshotName: vsName,
    label: opts.label ?? null,
    status: 'creating',
    triggeredByUserId: opts.triggeredByUserId ?? null,
    createdAt: now,
    expiresAt,
  });

  try {
    await createVolumeSnapshot(k8s, namespace, buildVolumeSnapshotManifest({
      namespace, vsName, pvcName, tenantId, snapshotId: id,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The compensating update must not mask the real error — if IT throws,
    // log + still surface the original failure (the reaper expiry is the
    // backstop for a row left in 'creating').
    try {
      await db.update(tenantVolumeSnapshots)
        .set({ status: 'error', lastError: msg })
        .where(eq(tenantVolumeSnapshots.id, id));
    } catch (dbErr) {
      // eslint-disable-next-line no-console
      console.error(`[tenant-snapshots] could not mark snapshot ${id} as error:`, dbErr);
    }
    throw new ApiError('SNAPSHOT_CREATE_FAILED', `Could not create the volume snapshot: ${msg}`, 502);
  }

  const [row] = await db.select().from(tenantVolumeSnapshots).where(eq(tenantVolumeSnapshots.id, id)).limit(1);
  return toApi(row);
}

export async function listSnapshots(
  deps: Deps,
  tenantId: string,
): Promise<{ snapshots: TenantSnapshot[]; expiryHours: number }> {
  const { db, k8s } = deps;
  const tenant = await mustGetTenant(db, tenantId);
  const settings = await getSettings(db);

  const rows = await db.select().from(tenantVolumeSnapshots)
    .where(eq(tenantVolumeSnapshots.tenantId, tenantId))
    .orderBy(desc(tenantVolumeSnapshots.createdAt));

  // Reconcile `creating` rows against the live VolumeSnapshots (one list
  // call). Collect updates rather than mutating the fetched rows in place.
  const updates = new Map<string, Partial<TenantVolumeSnapshot>>();
  if (rows.some((r) => r.status === 'creating')) {
    let live: VolumeSnapshotLive[] = [];
    try {
      live = await listVolumeSnapshots(k8s, tenant.kubernetesNamespace!, `insula.host/tenant-id=${tenantId}`);
    } catch (err) {
      // Best-effort: a transient k8s error leaves rows as-is this tick — but
      // log it so a persistent RBAC/API failure (stuck-'creating' snapshots)
      // is diagnosable rather than silent.
      // eslint-disable-next-line no-console
      console.warn(`[tenant-snapshots] list reconcile for ${tenantId} failed: ${(err as Error).message}`);
    }
    const byName = new Map(live.map((v) => [v.metadata?.name ?? '', v]));
    for (const r of rows) {
      if (r.status !== 'creating') continue;
      const vs = byName.get(r.volumeSnapshotName);
      if (!vs) continue;
      if (vs.status?.error?.message) {
        updates.set(r.id, { status: 'error', lastError: vs.status.error.message });
      } else if (vs.status?.readyToUse === true) {
        updates.set(r.id, { status: 'ready', sizeBytes: parseQuantityToBytes(vs.status.restoreSize), readyAt: new Date() });
      }
    }
    for (const [snapId, patch] of updates) {
      await db.update(tenantVolumeSnapshots).set(patch).where(eq(tenantVolumeSnapshots.id, snapId));
    }
  }

  const snapshots = rows.map((r) => toApi(updates.has(r.id) ? { ...r, ...updates.get(r.id)! } : r));
  return { snapshots, expiryHours: settings.snapshotExpiryHours };
}

/**
 * Poll until a snapshot reaches `ready` (Longhorn CSI flips in a few seconds).
 * Reuses {@link listSnapshots} so the live VolumeSnapshot status is reconciled
 * into the DB on each tick. Throws on `error`, on the row vanishing, or on
 * timeout. Used by the restore-cart pre-restore safety snapshot, which must be
 * a valid rollback target BEFORE the destructive restore proceeds.
 */
export async function waitForSnapshotReady(
  deps: Deps,
  tenantId: string,
  snapshotId: string,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    /** Injectable list fn + clock for tests. Default to the real ones. */
    list?: (deps: Deps, tenantId: string) => Promise<{ snapshots: TenantSnapshot[] }>;
    now?: () => number;
  } = {},
): Promise<TenantSnapshot> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const list = opts.list ?? listSnapshots;
  const now = opts.now ?? Date.now;
  const start = now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { snapshots } = await list(deps, tenantId);
    const snap = snapshots.find((s) => s.id === snapshotId);
    if (!snap) {
      throw new ApiError('SNAPSHOT_NOT_FOUND', `Snapshot ${snapshotId} vanished while waiting for ready`, 404);
    }
    if (snap.status === 'ready') return snap;
    if (snap.status === 'error') {
      throw new ApiError('SNAPSHOT_FAILED', `Snapshot ${snapshotId} failed: ${snap.lastError ?? 'unknown'}`, 502);
    }
    if (now() - start > timeoutMs) {
      throw new ApiError('SNAPSHOT_TIMEOUT', `Snapshot ${snapshotId} not ready after ${Math.round(timeoutMs / 1000)}s (status=${snap.status})`, 504);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Restore the tenant PVC from a snapshot by reverting the EXISTING Longhorn
 * volume in place (replicas stay healthy — NOT a destructive PVC swap). Hands
 * off to the storage-lifecycle orchestrator, which quiesces, calls Longhorn
 * `snapshotRevert`, and unquiesces. Returns the storage operation id; poll
 * {@link getRestoreOpStatus}. The snapshot row + CR are preserved (revert
 * doesn't consume the snapshot), so the tenant can restore again.
 */
export async function restoreSnapshot(
  deps: Deps,
  tenantId: string,
  snapshotId: string,
  opts: { triggeredByUserId?: string | null },
): Promise<{ operationId: string }> {
  const { db, k8s } = deps;
  const [row] = await db.select().from(tenantVolumeSnapshots)
    .where(and(eq(tenantVolumeSnapshots.id, snapshotId), eq(tenantVolumeSnapshots.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new ApiError('SNAPSHOT_NOT_FOUND', `Snapshot ${snapshotId} not found`, 404);
  if (row.status !== 'ready') {
    throw new ApiError('SNAPSHOT_NOT_READY', `Snapshot is '${row.status}' — wait until it's ready before restoring.`, 409);
  }
  const { restoreTenantFromVolumeSnapshot } = await import('../storage-lifecycle/service.js');
  return restoreTenantFromVolumeSnapshot(db, k8s, {
    tenantId,
    volumeSnapshotName: row.volumeSnapshotName,
    snapshotLabel: row.label,
    triggeredByUserId: opts.triggeredByUserId ?? null,
  });
}

/** Tenant-scoped poll for a restore operation. Verifies the op belongs to the
 *  tenant (an operator/tenant can only see their own op). */
export async function getRestoreOpStatus(
  deps: Deps,
  tenantId: string,
  operationId: string,
): Promise<{ operationId: string; state: string; progressPct: number; progressMessage: string | null; lastError: string | null }> {
  const [op] = await deps.db.select().from(storageOperations)
    .where(and(eq(storageOperations.id, operationId), eq(storageOperations.tenantId, tenantId)))
    .limit(1);
  if (!op) throw new ApiError('OPERATION_NOT_FOUND', `Operation ${operationId} not found`, 404);
  return {
    operationId: op.id,
    state: op.state,
    progressPct: op.progressPct,
    progressMessage: op.progressMessage,
    lastError: op.lastError,
  };
}

/** In-flight storage lifecycle states — a snapshot must not be deleted while
 *  any of these is active, since a restore in progress is provisioning a new
 *  PVC FROM a VolumeSnapshot (deleting its CR mid-provision aborts the restore
 *  and strands the PVC). Reaper-only states ('idle','failed') are deletable. */
const STORAGE_OP_ACTIVE_STATES = new Set([
  'snapshotting', 'quiescing', 'resizing', 'replacing', 'restoring', 'unquiescing', 'archiving',
]);

export async function deleteSnapshot(deps: Deps, tenantId: string, snapshotId: string): Promise<void> {
  const { db, k8s } = deps;
  const [row] = await db.select().from(tenantVolumeSnapshots)
    .where(and(eq(tenantVolumeSnapshots.id, snapshotId), eq(tenantVolumeSnapshots.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new ApiError('SNAPSHOT_NOT_FOUND', `Snapshot ${snapshotId} not found`, 404);

  // Refuse while a storage op is running — a restore-from-snapshot could be
  // provisioning the PVC from this very snapshot; deleting its CR mid-flight
  // strands the volume. (TOCTOU guard.)
  const [tenant] = await db.select({ state: tenants.storageLifecycleState })
    .from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (tenant && STORAGE_OP_ACTIVE_STATES.has(tenant.state)) {
    throw new ApiError(
      'STORAGE_OP_IN_PROGRESS',
      `A storage operation (${tenant.state}) is in progress — wait for it to finish before deleting snapshots.`,
      409,
    );
  }

  await deleteVolumeSnapshot(k8s, row.namespace, row.volumeSnapshotName);
  await db.delete(tenantVolumeSnapshots).where(eq(tenantVolumeSnapshots.id, snapshotId));
}

/**
 * Reaper tick: delete snapshots past their expiry. Deletes the VolumeSnapshot
 * CR (Longhorn snapshot cascades) then the row. Capped per tick so a backlog
 * catches up over multiple ticks. Returns the number reaped.
 */
export async function reapExpiredSnapshots(deps: Deps, now: Date = new Date()): Promise<number> {
  const { db, k8s } = deps;
  const expired = await db.select().from(tenantVolumeSnapshots)
    .where(lt(tenantVolumeSnapshots.expiresAt, now))
    .orderBy(tenantVolumeSnapshots.expiresAt)
    .limit(100);
  let reaped = 0;
  for (const row of expired) {
    try {
      await deleteVolumeSnapshot(k8s, row.namespace, row.volumeSnapshotName);
      await db.delete(tenantVolumeSnapshots).where(eq(tenantVolumeSnapshots.id, row.id));
      reaped += 1;
    } catch (err) {
      // Leave the row for the next tick; log and continue.
      // eslint-disable-next-line no-console
      console.warn(`[tenant-snapshots] reap of ${row.id} (${row.volumeSnapshotName}) failed: ${(err as Error).message}`);
    }
  }
  return reaped;
}

export const __test = { parseQuantityToBytes, MAX_SNAPSHOTS_PER_TENANT };
