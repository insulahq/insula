import {
  DEFAULT_TRASH_RETENTION_DAYS,
  MIN_TRASH_RETENTION_DAYS,
  MAX_TRASH_RETENTION_DAYS,
} from '@insula/api-contracts';
import { systemSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { fileManagerRequest } from './service.js';
import { getFileManagerImage } from './image.js';

/**
 * Retention policy for the file-manager recycle bin.
 *
 * THE VALUE LIVES HERE, NOT IN THE POD. The obvious implementation — inject
 * `FM_TRASH_RETENTION_DAYS` into the file-manager container — does not work:
 * `ensureFileManagerRunning` drift-checks the Deployment on pvc, caps, image,
 * resources, pullPolicy and nodeSelector, and NOT on env. A literal env value
 * would freeze at whatever existed when each tenant's Deployment was first
 * created and would never see an admin change. Adding env to that mismatch list
 * is worse than it looks: an always-true comparison there makes the reconciler
 * delete and recreate the Deployment on every pass at replicas=0, which is
 * exactly how /files/start became a permanent no-op once before.
 *
 * So the backend owns the number and passes it on every purge call. Setting
 * changes take effect immediately, with no pod churn.
 */
export async function getTrashRetentionDays(db: Database): Promise<number> {
  const [row] = await db
    .select({ days: systemSettings.fileTrashRetentionDays })
    .from(systemSettings)
    .limit(1);
  const parsed = Number(row?.days);
  // A missing or malformed value must NEVER become "purge everything" — this
  // number is multiplied into a cutoff, and a 0 or NaN here would expire every
  // tenant's bin on the next sweep. Fall back to the documented default.
  if (!Number.isFinite(parsed) || parsed < MIN_TRASH_RETENTION_DAYS || parsed > MAX_TRASH_RETENTION_DAYS) {
    if (row !== undefined) {
      console.warn(`[file-trash] ignoring invalid file_trash_retention_days=${row.days}; using ${DEFAULT_TRASH_RETENTION_DAYS}`);
    }
    return DEFAULT_TRASH_RETENTION_DAYS;
  }
  return Math.floor(parsed);
}

export interface TrashPurgeOutcome {
  readonly purged: number;
  readonly bytesFreed: number;
  readonly examined: number;
  readonly failed: ReadonlyArray<{ id: string; error: string }>;
}

/** Run the expiry sweep for ONE namespace. The file-manager pod must already be
 *  running — callers reach this either off the back of real user activity or
 *  from the reconciler, which starts the pod deliberately. */
export async function purgeExpiredTrash(
  k8s: K8sClients,
  kubeconfigPath: string | undefined,
  namespace: string,
  retentionDays: number,
): Promise<TrashPurgeOutcome> {
  const result = await fileManagerRequest(
    k8s, kubeconfigPath, namespace, getFileManagerImage(), '/trash/purge',
    { method: 'POST', body: JSON.stringify({ olderThanDays: retentionDays }), contentType: 'application/json' },
  );
  if (result.status !== 200) {
    throw new Error(`trash purge failed for ${namespace}: HTTP ${result.status}`);
  }
  return JSON.parse(result.body) as TrashPurgeOutcome;
}

// ─── Opportunistic sweep ─────────────────────────────────────────────────────

/**
 * Namespaces swept recently, so ordinary file-manager traffic does not fire a
 * purge on every click. In-process only and intentionally so: the cost of a
 * duplicate sweep across replicas is one cheap no-op call, and a shared lock
 * would buy nothing.
 */
const lastOpportunisticSweep = new Map<string, number>();
const OPPORTUNISTIC_INTERVAL_MS = 60 * 60 * 1000; // 1h

export function __resetOpportunisticSweepForTests(): void {
  lastOpportunisticSweep.clear();
}

/**
 * Fire-and-forget expiry sweep triggered by real user activity.
 *
 * This is the cheap half of retention: the pod is already up because someone is
 * using it, so the sweep costs one HTTP call. It is NOT sufficient on its own —
 * a tenant who trashes 20 GB and never reopens the panel would keep it forever
 * while the admin UI claims a 14-day policy. The reconciler
 * (trash-reconciler.ts) covers that tail; this just keeps active tenants tidy
 * between reconciler passes.
 */
export function sweepTrashOpportunistically(
  db: Database,
  k8s: K8sClients,
  kubeconfigPath: string | undefined,
  namespace: string,
): void {
  const now = Date.now();
  const last = lastOpportunisticSweep.get(namespace) ?? 0;
  if (now - last < OPPORTUNISTIC_INTERVAL_MS) return;
  // Stamp BEFORE the await so concurrent requests do not all pass the gate.
  lastOpportunisticSweep.set(namespace, now);

  void (async () => {
    try {
      const retentionDays = await getTrashRetentionDays(db);
      const outcome = await purgeExpiredTrash(k8s, kubeconfigPath, namespace, retentionDays);
      if (outcome.purged > 0) {
        console.log(`[file-trash] opportunistic sweep purged ${outcome.purged} entr${outcome.purged === 1 ? 'y' : 'ies'} (${outcome.bytesFreed} bytes) in ${namespace}`);
      }
    } catch (err) {
      // Never surface: this rides along with a user request that has nothing to
      // do with retention. Un-stamp so the next request retries rather than
      // waiting out the full hour after a transient failure.
      lastOpportunisticSweep.delete(namespace);
      console.warn(`[file-trash] opportunistic sweep failed for ${namespace}:`, (err as Error).message);
    }
  })();
}
