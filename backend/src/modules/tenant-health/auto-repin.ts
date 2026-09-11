/**
 * Automatic re-pin for HA-tier tenants stranded on a downed node.
 *
 * An HA-tier tenant's Longhorn volume has a replica on a second node, so its
 * data survives the loss. But if an operator explicitly pinned that tenant
 * (`tenants.node_name`), the pin outlives the node: workloads stay
 * unschedulable and the tenant is down even though a complete copy of its
 * data is sitting on a healthy node. Clearing the pin lets the scheduler and
 * Longhorn place it, and the tenant comes back without anyone waking up.
 *
 * LOCAL-TIER TENANTS ARE NEVER TOUCHED. Their volume has exactly one replica
 * and it is on the dead node — clearing the pin would not recover anything
 * and would discard the locality guarantee the tier exists to provide. Those
 * stay a deliberate operator decision (wait for the node, or restore from a
 * bundle), surfaced through the degraded-tenant modal.
 *
 * Kill switch: `AUTO_REPIN_HA_TENANTS=disable`, following the lifecycle-hook
 * precedent — for an outage where the operator wants nothing moving.
 */
import crypto from 'node:crypto';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { auditLogs } from '../../db/schema.js';
import { notifyAdminTenantAutoRepinned } from '../notifications/events.js';
import {
  makeLonghornHostTagEnsurer,
  repinTenantPlacement,
  buildDrainImpact,
} from '../nodes/service.js';
import type { NodeFact, ReplicaFact, TenantFact, VolumeFact } from './service.js';

export interface RepinCandidate {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly namespace: string;
  /** The dead node the pin points at. */
  readonly strandedOn: string;
  /** Live nodes that still hold a replica of this tenant's data. */
  readonly liveReplicaNodes: readonly string[];
}

/** Lifecycle states where moving a tenant's placement would be wrong. */
const NON_SERVING: ReadonlySet<string> = new Set([
  'suspended', 'archived', 'deleted', 'deleting', 'pending',
]);

/**
 * Which tenants may be auto-re-pinned right now. Pure — unit tested.
 *
 * Every condition here is a safety gate, not a filter for tidiness:
 *
 *  1. tier must be `ha`            — local tier's only replica is on the dead node
 *  2. pin must point at a DOWN node — otherwise there is nothing to fix
 *  3. tenant must be serving        — don't resurrect a suspended tenant
 *  4. a replica must exist on a LIVE node — proven per-tenant, not inferred
 *     from the tier. A tenant whose tier was flipped to `ha` moments ago may
 *     not have finished building its second replica; moving it then would
 *     strand it exactly like a local-tier tenant.
 *  5. somewhere Ready must exist to move to
 */
export function selectAutoRepinCandidates(input: {
  readonly tenants: ReadonlyArray<TenantFact>;
  readonly nodes: ReadonlyArray<NodeFact>;
  readonly volumes: ReadonlyArray<VolumeFact>;
  readonly replicas: ReadonlyArray<ReplicaFact>;
}): RepinCandidate[] {
  const downNodes = new Set(input.nodes.filter((n) => !n.ready).map((n) => n.name));
  const liveNodes = input.nodes.filter((n) => n.ready).map((n) => n.name);
  if (downNodes.size === 0 || liveNodes.length === 0) return [];

  const replicasByVolume = new Map<string, string[]>();
  for (const r of input.replicas) {
    if (!r.nodeId) continue;
    const list = replicasByVolume.get(r.volumeName) ?? [];
    list.push(r.nodeId);
    replicasByVolume.set(r.volumeName, list);
  }

  const out: RepinCandidate[] = [];
  for (const t of input.tenants) {
    if (t.storageTier !== 'ha') continue;                    // (1)
    if (!t.pinnedNode || !downNodes.has(t.pinnedNode)) continue; // (2)
    if (NON_SERVING.has(t.status)) continue;                 // (3)

    const nsVolumes = input.volumes.filter((v) => v.namespace === t.namespace);
    // (4) Prove a live replica per volume. A tenant with NO volumes is still
    // a valid candidate — it is pure compute and can move freely.
    const liveReplicaNodes = new Set<string>();
    let everyVolumeHasLiveReplica = true;
    for (const v of nsVolumes) {
      const nodes = replicasByVolume.get(v.volumeName) ?? [];
      const live = nodes.filter((n) => !downNodes.has(n));
      if (live.length === 0) { everyVolumeHasLiveReplica = false; break; }
      live.forEach((n) => liveReplicaNodes.add(n));
    }
    if (!everyVolumeHasLiveReplica) continue;

    out.push({
      tenantId: t.id,
      tenantName: t.name,
      namespace: t.namespace,
      strandedOn: t.pinnedNode,
      liveReplicaNodes: [...liveReplicaNodes].sort(),
    });
  }
  return out;
}

export function autoRepinDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTO_REPIN_HA_TENANTS === 'disable';
}

/**
 * Clear the pins for every candidate, one at a time.
 *
 * Sequential on purpose: each re-pin issues several cluster patches, and a
 * fan-out during an outage is exactly when the API server is least able to
 * absorb it. Partial failure is tolerated — the next tick retries, because
 * the candidate set is recomputed from live state rather than remembered.
 */
export async function applyAutoRepin(
  db: Database,
  k8s: K8sClients,
  candidates: ReadonlyArray<RepinCandidate>,
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void } = console,
): Promise<{ repinned: string[]; failed: Array<{ tenantId: string; error: string }> }> {
  const repinned: string[] = [];
  const failed: Array<{ tenantId: string; error: string }> = [];
  if (candidates.length === 0) return { repinned, failed };

  const ensureHostTag = makeLonghornHostTagEnsurer(k8s);

  for (const c of candidates) {
    try {
      // Re-derive the tenant's live workloads + volumes from the cluster
      // rather than trusting the health snapshot: the snapshot exists to
      // decide WHETHER to act, not to describe what to patch.
      const impact = await buildDrainImpact(k8s, db, c.strandedOn);
      const pinned = impact.pinnedTenants.find((p) => p.tenantId === c.tenantId);
      if (!pinned) {
        log.info(`[auto-repin] tenant=${c.tenantId} no longer pinned to ${c.strandedOn} — skipping`);
        continue;
      }

      // target '' = clear the pin, letting the scheduler and Longhorn place
      // freely. We deliberately do NOT pick a specific node: dataLocality
      // best-effort will drift the volume toward wherever the pod lands.
      const counts = await repinTenantPlacement(
        k8s, db,
        {
          tenantId: c.tenantId,
          namespace: pinned.namespace,
          workloads: pinned.workloads,
          pvcs: pinned.pvcs,
        },
        '',
        c.strandedOn,
        ensureHostTag,
      );

      if (counts.tenants === 0) {
        failed.push({ tenantId: c.tenantId, error: 'repin reported no tenant updated' });
        continue;
      }

      repinned.push(c.tenantId);
      log.info(
        `[auto-repin] tenant=${c.tenantId} (${c.tenantName}) unpinned from offline ${c.strandedOn} — `
        + `${counts.workloads} workload(s), ${counts.pvcs} volume(s), `
        + `${counts.evictedPods} stranded pod(s) evicted; `
        + `live replicas on ${c.liveReplicaNodes.join(', ') || 'n/a'}`,
      );

      await db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorId: 'system',
        actorType: 'system',
        actionType: 'tenant.auto_repin',
        resourceType: 'tenant',
        resourceId: c.tenantId,
        changes: {
          reason: 'HA-tier tenant was pinned to a NotReady node',
          strandedOn: c.strandedOn,
          liveReplicaNodes: c.liveReplicaNodes,
          workloadsPatched: counts.workloads,
          volumesPatched: counts.pvcs,
          strandedPodsEvicted: counts.evictedPods,
        } as unknown as Record<string, unknown>,
      }).catch((err) => log.warn('[auto-repin] audit insert failed:', (err as Error).message));

      await notifyAdminTenantAutoRepinned(db, {
        tenantName: c.tenantName,
        strandedOn: c.strandedOn,
      }, `auto-repin:${c.tenantId}:${c.strandedOn}`)
        .catch(() => { /* best-effort; never fail the recovery on a notification */ });
    } catch (err) {
      failed.push({ tenantId: c.tenantId, error: (err as Error).message ?? 'repin failed' });
      log.warn(`[auto-repin] tenant=${c.tenantId} failed:`, (err as Error).message);
    }
  }

  return { repinned, failed };
}

export const AUTO_REPIN_AUDIT_ACTION = 'tenant.auto_repin';
