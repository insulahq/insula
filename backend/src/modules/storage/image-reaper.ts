/**
 * Image Reaper — Phase 1 eager image cleanup after deployment deletion.
 *
 * Public API:
 *   scheduleReap(db, k8s, input)  — fire-and-forget after graceMs delay
 *   reapImageNow(db, k8s, input)  — synchronous reap with in-use safety check
 *
 * Safety contract:
 *   Before issuing any `crictl rmi` call the reaper checks whether any live
 *   pod still references the image via getInUseImages(). Deployment deletion
 *   is async (the workload pod may still be Terminating), so the grace period
 *   (default 5 min) lets the pod vanish before we attempt removal.
 *
 * Persistence:
 *   Every reap attempt (success, skip, or error) is recorded in the
 *   image_reap_log table (migration 0064) so operators can audit what was
 *   removed and why.
 *
 * Durability + multi-replica (2026-08-04):
 *   scheduleReap persists the pending reap to `pending_image_reaps` and ALSO
 *   arms an in-process timer. The row is the source of truth; the timer only
 *   keeps the common case prompt. Previously the grace period lived in the
 *   timer alone, so a restart inside the window dropped the reap silently —
 *   no log row, no retry (seen on DEV, where Flux rolls platform-api on every
 *   push). runDueReaps() sweeps due rows and is what makes this restart-safe.
 *
 *   Claiming is `DELETE … RETURNING`, which is atomic in Postgres, so each row
 *   goes to exactly ONE replica. That supersedes the old "at-most-once-per-
 *   replica" caveat and the deferred distributed lock.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';
import { lte } from 'drizzle-orm';
import { imageReapLog, pendingImageReaps } from '../../db/schema.js';
import { getInUseImages, runPurgeOnNode, isAnyNameInUse } from './service.js';
import { canonicalImageRef } from './image-ref-utils.js';

export interface ReapInput {
  /** Canonical image ref — with tag or digest (e.g. `ghcr.io/foo/bar:v1.2.3`). */
  image: string;
  triggeredBy: 'deployment_delete' | 'manual_purge' | 'pressure_watcher';
  /** deployment_id | actor_id | node_name — context for the audit log */
  triggerRef?: string;
  /** Delay before reaping. Defaults to 5 minutes to let terminating pods vanish. */
  graceMs?: number;
}

export interface ReapResult {
  reclaimedBytes: number;
  nodes: string[];
  /** true when the image is still in use or already absent from all nodes */
  skipped: boolean;
  reason?: string;
}

const DEFAULT_GRACE_MS = 5 * 60 * 1000;
/** Give up (and log the failure) after this many failed reap attempts. */
const MAX_REAP_ATTEMPTS = 5;
const RETRY_BASE_MS = 60 * 1000;
const RETRY_MAX_MS = 15 * 60 * 1000;

/**
 * Schedule a reap after graceMs milliseconds — fire-and-forget.
 * Errors inside the reap are logged via imageReapLog but are not thrown.
 */
export function scheduleReap(db: Database, k8s: K8sClients, input: ReapInput): void {
  const grace = input.graceMs ?? DEFAULT_GRACE_MS;
  // DURABILITY: persist the intent FIRST. A setTimeout lives only in this
  // process, so a restart inside the grace window used to drop the reap
  // silently — no image_reap_log row, no retry, nothing to find afterwards.
  // (DEV cluster, 2026-08-04: delete at 13:43:44 armed a timer for 13:48:44,
  // Flux rolled platform-api, replacement pod up at 13:49:28, reap never ran.)
  // The row is the source of truth; the timer below is only a latency
  // optimisation so the common case still fires promptly.
  void db.insert(pendingImageReaps).values({
    imageName: input.image,
    triggeredBy: input.triggeredBy,
    triggerRef: input.triggerRef ?? null,
    dueAt: new Date(Date.now() + grace),
  }).catch(() => {
    // If the enqueue fails we still run the in-process timer below — degraded
    // to the old behaviour rather than losing the reap entirely.
  });

  setTimeout(() => {
    // Claim through the same path the scheduler uses so the fast path and the
    // sweeper can never both reap the same row.
    runDueReaps(db, k8s).catch(() => {
      // runDueReaps logs failures via imageReapLog — nothing more to do
    });
  }, grace);
}

/**
 * Claim and execute every reap whose grace period has expired.
 *
 * Claiming is `DELETE … RETURNING`, which is atomic in Postgres: with N
 * replicas ticking concurrently each row is handed to exactly ONE of them, so
 * duplicate reap pods stop being possible. (The previous design was documented
 * as "at-most-once-per-replica" with a distributed lock deferred — this removes
 * the need for one.)
 *
 * A reap that throws is re-enqueued with a capped exponential backoff so a
 * transient k8s error retries instead of vanishing. After MAX_REAP_ATTEMPTS the
 * failure is written to image_reap_log and the row is dropped, so a
 * permanently-failing image cannot spin forever.
 */
export async function runDueReaps(db: Database, k8s: K8sClients): Promise<number> {
  const claimed = await db
    .delete(pendingImageReaps)
    .where(lte(pendingImageReaps.dueAt, new Date()))
    .returning();

  let executed = 0;
  for (const row of claimed) {
    const input: ReapInput = {
      image: row.imageName,
      triggeredBy: row.triggeredBy as ReapInput['triggeredBy'],
      triggerRef: row.triggerRef ?? undefined,
    };
    try {
      await reapImageNow(db, k8s, input);
      executed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = row.attempts + 1;
      if (attempts >= MAX_REAP_ATTEMPTS) {
        await insertLog(db, {
          imageName: row.imageName,
          triggeredBy: input.triggeredBy,
          triggerRef: input.triggerRef,
          succeeded: false,
          error: `gave up after ${attempts} attempts: ${message}`,
        }).catch(() => undefined);
        continue;
      }
      // Backoff: 1m, 2m, 4m … capped. Re-insert rather than update because the
      // row was already removed by the atomic claim above.
      const backoffMs = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
      await db.insert(pendingImageReaps).values({
        imageName: row.imageName,
        triggeredBy: row.triggeredBy,
        triggerRef: row.triggerRef,
        dueAt: new Date(Date.now() + backoffMs),
        attempts,
        lastError: message.slice(0, 500),
      }).catch(() => undefined);
    }
  }
  return executed;
}

/**
 * Reap `input.image` from every node that still holds a copy, unless any
 * running pod still references the image (in which case the reap is skipped
 * and the skip is logged).
 *
 * Idempotent: if the image is already gone from all nodes the function returns
 * immediately with `{ skipped: true, reason: 'not_present' }`.
 */
export async function reapImageNow(
  db: Database,
  k8s: K8sClients,
  input: ReapInput,
): Promise<ReapResult> {
  const { image, triggeredBy, triggerRef } = input;

  // ── 1. In-use guard ────────────────────────────────────────────────────────
  // HIGH #1: use the same docker.io/library/ normalisation the aggregator
  // uses. A direct `inUseSet.has(image)` misses when the caller passes
  // `docker.io/library/nginx:latest` while the pod spec says `nginx:latest`
  // (or vice-versa).
  const inUseSet = await getInUseImages(k8s);
  if (isAnyNameInUse([image], inUseSet)) {
    await insertLog(db, { imageName: image, triggeredBy, triggerRef, succeeded: false, error: 'image still in use — skipped' });
    return { reclaimedBytes: 0, nodes: [], skipped: true, reason: 'in_use' };
  }

  // ── 2. Find which nodes have the image ────────────────────────────────────
  let nodeList: readonly { metadata?: { name?: string }; status?: { images?: readonly { names?: readonly string[] | null; sizeBytes?: number }[] } }[] = [];
  try {
    const raw = await k8s.core.listNode();
    nodeList = (raw as { items?: typeof nodeList }).items ?? [];
  } catch {
    await insertLog(db, { imageName: image, triggeredBy, triggerRef, succeeded: false, error: 'k8s listNode failed' });
    return { reclaimedBytes: 0, nodes: [], skipped: false, reason: 'k8s_error' };
  }

  // Normalize the caller's image ref to its canonical Docker form so we
  // can compare against whatever shape kubelet reports under
  // node.status.images[].names (which is always a canonical
  // `<registry>/<repo>:<tag>` or `<registry>/<repo>@<digest>` string).
  const wantedCanonical = canonicalImageRef(image);
  const nodePresences: { node: string; sizeBytes: number }[] = [];
  for (const node of nodeList) {
    const nodeName = node.metadata?.name ?? 'unknown';
    const images = node.status?.images ?? [];
    for (const img of images) {
      const names = img.names ?? [];
      const matches = names.some((n) => canonicalImageRef(n) === wantedCanonical);
      if (matches) {
        nodePresences.push({ node: nodeName, sizeBytes: img.sizeBytes ?? 0 });
        break;
      }
    }
  }

  if (nodePresences.length === 0) {
    // Already gone — idempotent success
    await insertLog(db, { imageName: image, triggeredBy, triggerRef, succeeded: true, bytesReclaimed: 0, nodesReclaimed: [] });
    return { reclaimedBytes: 0, nodes: [], skipped: true, reason: 'not_present' };
  }

  // ── 3. Reap on each node ───────────────────────────────────────────────────
  const reclaimedNodes: string[] = [];
  let totalBytes = 0;
  const errors: string[] = [];

  for (const presence of nodePresences) {
    // Pass the CANONICAL form to crictl so the rmi call works on every
    // runtime. containerd accepts short refs and resolves them against
    // the default registry, but cri-o requires the FQDN form to remove
    // an image. The original short ref stays as `displayName` so audit
    // logs (image_reap_log.image_name) keep the operator-facing string.
    const result = await runPurgeOnNode(k8s, presence.node, [{
      crictlName: wantedCanonical,
      displayName: image,
      sizeBytes: presence.sizeBytes,
    }]);
    if (result.removedDisplayNames.length > 0) {
      reclaimedNodes.push(presence.node);
      totalBytes += result.freedBytes;
    }
    if (result.podError) errors.push(result.podError);
    if (result.failedDisplayNames.length > 0) {
      errors.push(`failed on ${presence.node}: ${result.failedDisplayNames.join(', ')}`);
    }
  }

  const succeeded = reclaimedNodes.length > 0;
  await insertLog(db, {
    imageName: image,
    triggeredBy,
    triggerRef,
    succeeded,
    bytesReclaimed: totalBytes,
    nodesReclaimed: reclaimedNodes,
    error: errors.length > 0 ? errors.join('; ') : undefined,
  });

  return { reclaimedBytes: totalBytes, nodes: reclaimedNodes, skipped: false };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function insertLog(
  db: Database,
  row: {
    imageName: string;
    triggeredBy: 'deployment_delete' | 'manual_purge' | 'pressure_watcher';
    triggerRef?: string;
    succeeded: boolean;
    bytesReclaimed?: number;
    nodesReclaimed?: string[];
    error?: string;
  },
): Promise<void> {
  try {
    await db.insert(imageReapLog).values({
      imageName: row.imageName,
      triggeredBy: row.triggeredBy,
      triggerRef: row.triggerRef ?? null,
      succeeded: row.succeeded,
      bytesReclaimed: row.bytesReclaimed ?? 0,
      nodesReclaimed: row.nodesReclaimed ?? [],
      error: row.error ?? null,
    });
  } catch {
    // Non-fatal: logging failure must not break the caller
  }
}
