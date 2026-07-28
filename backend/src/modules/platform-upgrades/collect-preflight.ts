/**
 * Collect pre-flight FACTS from the live cluster (ADR-045 W14). Resilient + best
 * effort: every probe is independent and falls back to a safe default the pure
 * `evaluatePreflight` handles (null → n/a / soft-warn), so a single unreachable
 * subsystem degrades that one gate instead of failing the whole check.
 */
import { eq, sql } from 'drizzle-orm';
import { tenantLifecycleTransitions, nodeHealthState } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { PreflightFacts } from './preflight.js';

const ENVIRONMENT = process.env.PLATFORM_ENV ?? 'production';
const CNPG_NS = 'platform';
// Validate the override against the k8s name charset; a malformed/spoofed env
// must not redirect the health read to an arbitrary (always-healthy) CR name.
const CNPG_CLUSTER = (() => {
  const v = process.env.PLATFORM_CNPG_CLUSTER;
  return v && /^[a-z0-9]([a-z0-9-]{0,251}[a-z0-9])?$/.test(v) ? v : 'system-db';
})();

/** CNPG primary health, shared by pre-flight + post-flight. Env-validated cluster name. */
export async function cnpgReady(k8s: K8sClients): Promise<{ ready: boolean; detail: string }> {
  try {
    const cr = (await k8s.custom.getNamespacedCustomObject({
      group: 'postgresql.cnpg.io', version: 'v1', namespace: CNPG_NS, plural: 'clusters', name: CNPG_CLUSTER,
    } as unknown as Parameters<typeof k8s.custom.getNamespacedCustomObject>[0])) as {
      status?: { readyInstances?: number; instances?: number; phase?: string };
    };
    const ready = cr.status?.readyInstances ?? 0;
    const total = cr.status?.instances ?? 0;
    return { ready: ready >= 1, detail: `${ready}/${total} instances ready${cr.status?.phase ? ` (${cr.status.phase})` : ''}` };
  } catch {
    return { ready: false, detail: 'CNPG Cluster status unreadable' };
  }
}

/**
 * Count ATTACHED Longhorn volumes that are below their configured redundancy
 * (robustness degraded/faulted) — i.e. genuinely at risk if a node rolls during
 * the upgrade.
 *
 * 2026-07-28: this replaced a `min healthy replicas < 2` check that could NEVER
 * pass on the platform's documented single-node default ("Longhorn replica=1 on
 * single node") — a healthy replica=1 volume reported 1 < 2 → the upgrade
 * preflight hard-blocked, so single-node clusters could never upgrade. The
 * correct question is not "are there ≥2 replicas?" but "is any in-use volume
 * degraded below the redundancy it was configured for?":
 *   - `healthy`  → at its configured replica count (1 or 3) → NOT at risk.
 *   - `degraded`/`faulted` (attached) → fewer healthy replicas than desired →
 *      at risk.
 *   - detached volumes → not mounted, a node roll can't disrupt them → ignored
 *      (they also report robustness `unknown`, which the old code mis-counted
 *      as 0 healthy and let idle tenant PVCs block every upgrade).
 *
 * Returns the at-risk count, or null when there are no volumes / the list call
 * failed (the gate treats null as "not applicable").
 */
async function longhornAtRiskVolumes(k8s: K8sClients): Promise<number | null> {
  try {
    const list = (await k8s.custom.listNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2', namespace: 'longhorn-system', plural: 'volumes',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0])) as {
      items?: Array<{ status?: { robustness?: string; state?: string } }>;
    };
    const vols = list.items ?? [];
    if (vols.length === 0) return null;
    let atRisk = 0;
    for (const v of vols) {
      const attached = v.status?.state === 'attached';
      const robustness = v.status?.robustness;
      if (attached && (robustness === 'degraded' || robustness === 'faulted')) atRisk += 1;
    }
    return atRisk;
  } catch {
    return null;
  }
}

async function inFlightTransitions(db: Database): Promise<number | null> {
  try {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tenantLifecycleTransitions)
      .where(eq(tenantLifecycleTransitions.state, 'running'));
    return rows[0]?.n ?? 0;
  } catch {
    // DB unreachable → UNKNOWN (null), surfaced as a warn. NEVER 0/pass — this
    // gate exists to ensure nothing else is mutating the cluster mid-upgrade.
    return null;
  }
}

/**
 * Disk facts from the node-health reconciler's persisted state (5-min tick):
 *   maxDiskUsedPct        — highest disk-used % across nodes, or null if that
 *                           column is unpopulated (Phase 1 leaves it null).
 *   nodesWithDiskPressure — nodes flagged with the kubelet DiskPressure
 *                           condition; null when node-health has NO rows yet
 *                           (fresh boot before the first tick / DB unreachable).
 * Reading the already-collected table (vs. a fresh kubelet /stats/summary probe)
 * keeps pre-flight cheap and avoids new RBAC — DiskPressure is the exact signal
 * node-health deemed sufficient for the high-impact case.
 */
async function nodeDiskFacts(db: Database): Promise<{ maxDiskUsedPct: number | null; nodesWithDiskPressure: number | null }> {
  try {
    const rows = await db
      .select({ pressures: nodeHealthState.pressures, diskUsedPct: nodeHealthState.diskUsedPct })
      .from(nodeHealthState);
    if (rows.length === 0) return { maxDiskUsedPct: null, nodesWithDiskPressure: null };
    let maxPct: number | null = null;
    let pressured = 0;
    for (const r of rows) {
      if ((r.pressures as string[]).includes('disk')) pressured++;
      if (r.diskUsedPct !== null) {
        const pct = Number(r.diskUsedPct);
        if (!Number.isNaN(pct) && (maxPct === null || pct > maxPct)) maxPct = pct;
      }
    }
    return { maxDiskUsedPct: maxPct, nodesWithDiskPressure: pressured };
  } catch {
    // DB unreachable → unknown (both null), surfaced as the "unavailable" warn.
    return { maxDiskUsedPct: null, nodesWithDiskPressure: null };
  }
}

async function freshestBackupAgeHours(k8s: K8sClients, nowMs: number): Promise<number | null> {
  try {
    const list = (await k8s.custom.listNamespacedCustomObject({
      group: 'postgresql.cnpg.io', version: 'v1', namespace: CNPG_NS, plural: 'backups',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0])) as {
      items?: Array<{ status?: { phase?: string; stoppedAt?: string } }>;
    };
    let freshest: number | null = null;
    for (const b of list.items ?? []) {
      if (b.status?.phase !== 'completed' || !b.status.stoppedAt) continue;
      const t = Date.parse(b.status.stoppedAt);
      if (!Number.isNaN(t) && (freshest === null || t > freshest)) freshest = t;
    }
    return freshest === null ? null : Math.max(0, Math.round((nowMs - freshest) / 3_600_000));
  } catch {
    return null;
  }
}

export async function collectPreflightFacts(db: Database, k8s: K8sClients, nowMs: number): Promise<PreflightFacts> {
  const [cnpg, lhAtRisk, inFlight, disk, backupAge] = await Promise.all([
    cnpgReady(k8s),
    longhornAtRiskVolumes(k8s),
    inFlightTransitions(db),
    nodeDiskFacts(db),
    freshestBackupAgeHours(k8s, nowMs),
  ]);
  return {
    environment: ENVIRONMENT,
    cnpgReady: cnpg.ready,
    cnpgDetail: cnpg.detail,
    longhornAtRiskVolumes: lhAtRisk,
    inFlightTransitions: inFlight,
    maxDiskUsedPct: disk.maxDiskUsedPct,
    nodesWithDiskPressure: disk.nodesWithDiskPressure,
    freshestBackupAgeHours: backupAge,
  };
}
