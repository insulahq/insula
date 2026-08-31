import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { fileTrashState, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { createK8sClients, type K8sClients } from '../k8s-provisioner/k8s-client.js';
import { safeTick } from '../../shared/safe-tick.js';
import { fileManagerRequest } from './service.js';
import { getFileManagerImage } from './image.js';
import { getTrashRetentionDays, purgeExpiredTrash } from './trash-service.js';

/**
 * Expiry reconciler for the file-manager recycle bin.
 *
 * WHY THIS EXISTS AT ALL. The opportunistic sweep in trash-service.ts only
 * fires when someone is actually using the file manager. A tenant who trashes
 * 20 GB and never reopens the panel would keep it forever, while the admin UI
 * promises a 14-day policy. Shipping a documented retention that no code
 * enforces is exactly the bug that left tenant-bundle restic snapshots
 * unreclaimed for months — the retention was real in the docs and absent in the
 * code, and nobody noticed because nothing ever contradicted it.
 *
 * WHY IT IS CACHE-DRIVEN. The file-manager Deployment is scaled to 0 after 10
 * minutes idle and its PVC is RWO. Sweeping blindly would start every tenant's
 * pod on every pass to discover that nearly every bin is empty, and would fight
 * storage operations for the volume lock. `file_trash_state` records which
 * tenants have something in the bin, so a pass usually wakes nobody.
 */

const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
/** Pods started per pass. Bounded so a backlog cannot stampede the cluster. */
const MAX_TENANTS_PER_TICK = 10;

export interface TrashReconcileSummary {
  readonly examined: number;
  readonly swept: number;
  readonly purged: number;
  readonly bytesFreed: number;
  readonly failed: number;
}

/** Refresh the cache from what the sidecar actually reports. Authoritative —
 *  callers pass the sidecar's own summary, never a guess. */
export async function recordTrashSummary(
  db: Database,
  tenantId: string,
  summary: { count: number; oldestDeletedAt: string | null; usedBytes: number },
): Promise<void> {
  const oldest = summary.oldestDeletedAt ? new Date(summary.oldestDeletedAt) : null;
  await db
    .insert(fileTrashState)
    .values({
      tenantId,
      oldestDeletedAt: oldest,
      usedBytes: summary.usedBytes,
      entryCount: summary.count,
    })
    .onConflictDoUpdate({
      target: fileTrashState.tenantId,
      set: {
        oldestDeletedAt: oldest,
        usedBytes: summary.usedBytes,
        entryCount: summary.count,
        updatedAt: new Date(),
      },
    });
}

/**
 * Note that SOMETHING was just trashed, without a sidecar round-trip.
 *
 * Only ever moves `oldest_deleted_at` EARLIER (`LEAST`). Overwriting it with
 * `now` would push an older entry's timestamp forward every time the tenant
 * deleted anything, and a bin whose oldest entry keeps resetting never looks
 * expired — the reconciler would skip it forever. Running early merely costs a
 * sweep that finds nothing and then corrects the row.
 */
export async function noteTrashActivity(db: Database, tenantId: string): Promise<void> {
  const now = new Date();
  await db
    .insert(fileTrashState)
    .values({ tenantId, oldestDeletedAt: now, entryCount: 1 })
    .onConflictDoUpdate({
      target: fileTrashState.tenantId,
      set: {
        oldestDeletedAt: sql`LEAST(COALESCE(${fileTrashState.oldestDeletedAt}, ${now.toISOString()}::timestamp), ${now.toISOString()}::timestamp)`,
        entryCount: sql`${fileTrashState.entryCount} + 1`,
        updatedAt: now,
      },
    });
}

/** Stamp an examination. Called for EVERY candidate, whatever the outcome —
 *  see the class comment and migration 0095. */
async function stampSweep(
  db: Database,
  tenantId: string,
  outcome: string,
  error?: string,
): Promise<void> {
  await db
    .insert(fileTrashState)
    .values({ tenantId, lastSweepAt: new Date(), lastSweepOutcome: outcome, lastSweepError: error ?? null })
    .onConflictDoUpdate({
      target: fileTrashState.tenantId,
      set: { lastSweepAt: new Date(), lastSweepOutcome: outcome, lastSweepError: error ?? null, updatedAt: new Date() },
    });
}

async function fetchTrashSummary(
  k8s: K8sClients,
  kubeconfigPath: string | undefined,
  namespace: string,
): Promise<{ count: number; oldestDeletedAt: string | null; usedBytes: number }> {
  const result = await fileManagerRequest(
    k8s, kubeconfigPath, namespace, getFileManagerImage(), '/trash/summary', { method: 'GET' },
  );
  if (result.status !== 200) throw new Error(`trash summary failed: HTTP ${result.status}`);
  return JSON.parse(result.body);
}

export async function runTrashReconcile(
  db: Database,
  kubeconfigPath?: string,
): Promise<TrashReconcileSummary> {
  const retentionDays = await getTrashRetentionDays(db);
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);

  // Candidates: a bin that is known non-empty and whose OLDEST entry is already
  // past the window. Least-recently-examined first so coverage rotates instead
  // of re-picking the same head every pass.
  const candidates = await db
    .select({ tenantId: fileTrashState.tenantId })
    .from(fileTrashState)
    .where(and(
      isNotNull(fileTrashState.oldestDeletedAt),
      lt(fileTrashState.oldestDeletedAt, cutoff),
    ))
    // ASC goes INSIDE the raw fragment. Wrapping it in Drizzle's asc() helper
    // renders `ORDER BY "last_sweep_at" NULLS FIRST asc`, which Postgres
    // rejects with `syntax error at or near "asc"` — so every reconcile tick
    // threw and the sweep never ran once. It failed silently: the tick logs a
    // warning and moves on, the opportunistic sweep (a different query) kept
    // working for ACTIVE tenants, and the only symptom was that idle tenants
    // never had their bins expired — exactly the promise this reconciler
    // exists to keep. Caught by reading the DEV logs, not by any test.
    .orderBy(sql`${fileTrashState.lastSweepAt} ASC NULLS FIRST`)
    .limit(MAX_TENANTS_PER_TICK);

  let swept = 0;
  let purged = 0;
  let bytesFreed = 0;
  let failed = 0;

  for (const { tenantId } of candidates) {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);

    // A vanished tenant leaves an inert row (loose reference, no FK). Clear the
    // marker so it stops being selected, but keep stamping so the row rotates
    // out of the candidate head rather than sitting there forever.
    if (!tenant || tenant.provisioningStatus !== 'provisioned') {
      await db.update(fileTrashState)
        .set({ oldestDeletedAt: null, entryCount: 0, usedBytes: 0 })
        .where(eq(fileTrashState.tenantId, tenantId));
      await stampSweep(db, tenantId, 'tenant_unavailable');
      continue;
    }

    // A destructive storage op quiesces the namespace and holds the PVC lock.
    // Starting the file-manager now would fight it — skip, stamp, come back.
    const state = tenant.storageLifecycleState;
    if (state !== 'idle' && state !== 'failed') {
      await stampSweep(db, tenantId, 'storage_op_in_progress');
      continue;
    }

    const namespace = tenant.kubernetesNamespace;
    try {
      const k8s = createK8sClients(kubeconfigPath);
      const outcome = await purgeExpiredTrash(k8s, kubeconfigPath, namespace, retentionDays);
      purged += outcome.purged;
      bytesFreed += outcome.bytesFreed;
      swept += 1;

      // Refresh from what the sidecar now reports rather than assuming the bin
      // is empty — a sweep that purged nothing still tells us the real oldest.
      await recordTrashSummary(db, tenantId, await fetchTrashSummary(k8s, kubeconfigPath, namespace));
      await stampSweep(db, tenantId, outcome.purged > 0 ? 'purged' : 'nothing_expired');
    } catch (err) {
      failed += 1;
      await stampSweep(db, tenantId, 'error', (err as Error).message);
      console.warn(`[file-trash] reconcile failed for tenant ${tenantId}:`, (err as Error).message);
    }
  }

  return { examined: candidates.length, swept, purged, bytesFreed, failed };
}

export function startTrashReconciler(db: Database, kubeconfigPath?: string): NodeJS.Timeout {
  // One pass at startup so a long-stopped cluster catches up promptly, then on
  // the interval — mirroring data-retention/scheduler.ts.
  safeTick('file-trash-reconcile', () => runOnce(db, kubeconfigPath));
  const timer = setInterval(() => {
    safeTick('file-trash-reconcile', () => runOnce(db, kubeconfigPath));
  }, RECONCILE_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

async function runOnce(db: Database, kubeconfigPath?: string): Promise<void> {
  try {
    const r = await runTrashReconcile(db, kubeconfigPath);
    if (r.purged > 0 || r.failed > 0) {
      console.log(`[file-trash] reconcile: examined ${r.examined}, swept ${r.swept}, purged ${r.purged} (${r.bytesFreed} bytes), failed ${r.failed}`);
    }
  } catch (err) {
    console.error('[file-trash] reconcile tick failed:', err);
  }
}
