/**
 * Collect pre-flight FACTS from the live cluster (ADR-045 W14). Resilient + best
 * effort: every probe is independent and falls back to a safe default the pure
 * `evaluatePreflight` handles (null → n/a / soft-warn), so a single unreachable
 * subsystem degrades that one gate instead of failing the whole check.
 */
import { eq, sql } from 'drizzle-orm';
import { tenantLifecycleTransitions } from '../../db/schema.js';
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

async function cnpgReady(k8s: K8sClients): Promise<{ ready: boolean; detail: string }> {
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

async function longhornMinReplicas(k8s: K8sClients): Promise<number | null> {
  try {
    const list = (await k8s.custom.listNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2', namespace: 'longhorn-system', plural: 'volumes',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0])) as {
      items?: Array<{ spec?: { numberOfReplicas?: number }; status?: { robustness?: string } }>;
    };
    const vols = list.items ?? [];
    if (vols.length === 0) return null;
    let min = Infinity;
    for (const v of vols) {
      const robustness = v.status?.robustness;
      const healthy = robustness === 'healthy' ? (v.spec?.numberOfReplicas ?? 0) : robustness === 'degraded' ? 1 : 0;
      if (healthy < min) min = healthy;
    }
    return Number.isFinite(min) ? min : null;
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
  const [cnpg, lhMin, inFlight, backupAge] = await Promise.all([
    cnpgReady(k8s),
    longhornMinReplicas(k8s),
    inFlightTransitions(db),
    freshestBackupAgeHours(k8s, nowMs),
  ]);
  return {
    environment: ENVIRONMENT,
    cnpgReady: cnpg.ready,
    cnpgDetail: cnpg.detail,
    longhornMinReplicas: lhMin,
    inFlightTransitions: inFlight,
    // Disk-usage % requires the security-probe node data; wired as a follow-up.
    // null → a soft "unknown" warning, never a false block.
    maxDiskUsedPct: null,
    freshestBackupAgeHours: backupAge,
  };
}
