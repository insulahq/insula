import { sql } from 'drizzle-orm';
import type { AdminDashboardSummary, AdminDashboardLive, AdminNode } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { collect } from './section.js';
import { buildAdminAlerts, rankAlerts } from './alerts.js';
import { buildVolumeAlert, buildOrphanedPodAlert } from './cluster-alerts.js';

interface Logger { warn?(...a: unknown[]): void }

/* ── fast: everything answerable from the platform database ───────── */

export async function buildAdminSummary(
  db: Database,
  logger?: Logger,
): Promise<AdminDashboardSummary> {
  const [alerts, tenants, backups, certificates, updates, scheduledTasks, recentChanges] =
    await Promise.all([
      collect('alerts', () => buildAdminAlerts(db), { logger }),
      collect('tenants', async () => {
        const r = await db.execute<Record<string, number>>(sql`
          SELECT
            (SELECT COUNT(*)::int FROM tenants WHERE status = 'active') AS active,
            (SELECT COUNT(*)::int FROM tenants) AS total,
            (SELECT COUNT(*)::int FROM ingress_routes) AS routes,
            (SELECT COUNT(*)::int FROM domains) AS domains,
            (SELECT COUNT(*)::int FROM provisioning_tasks WHERE status IN ('pending','running')) AS provisioning
        `);
        const x = (r.rows ?? [])[0] ?? {};
        return {
          active: Number(x.active ?? 0), total: Number(x.total ?? 0),
          routes: Number(x.routes ?? 0), domains: Number(x.domains ?? 0),
          provisioningInFlight: Number(x.provisioning ?? 0),
        };
      }, { logger }),
      collect('backups', () => buildBackupClasses(db), { logger }),
      collect('certificates', async () => {
        const r = await db.execute<Record<string, number | null>>(sql`
          SELECT COUNT(*)::int AS issued,
                 -- is_wildcard is an INTEGER flag, so it needs an explicit
                 -- comparison: CASE WHEN requires a boolean predicate.
                 SUM(CASE WHEN is_wildcard = 1 THEN 1 ELSE 0 END)::int AS wildcards,
                 MIN(EXTRACT(DAY FROM (expires_at - NOW())))::int AS nearest_days,
                 SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END)::int AS failing
            FROM ssl_certificates
           WHERE COALESCE(status,'') <> 'revoked'
        `);
        const x = (r.rows ?? [])[0] ?? {};
        return {
          issued: Number(x.issued ?? 0), wildcards: Number(x.wildcards ?? 0),
          nearestExpiryDays: x.nearest_days == null ? null : Number(x.nearest_days),
          failing: Number(x.failing ?? 0),
        };
      }, { logger }),
      collect('updates', async () => {
        const r = await db.execute<Record<string, number>>(sql`
          SELECT
            (SELECT COUNT(*)::int FROM deployments WHERE auto_upgrade = TRUE) AS auto_upgrade,
            (SELECT COUNT(*)::int FROM deployments) AS total
        `);
        const x = (r.rows ?? [])[0] ?? {};
        return {
          platformCurrent: true,
          deploymentsBehind: 0,
          autoUpgradeEnabled: Number(x.auto_upgrade ?? 0),
          eolRuntimes: 0,
        };
      }, { logger }),
      collect('scheduledTasks', async () => {
        const r = await db.execute<Record<string, number>>(sql`
          SELECT COUNT(*)::int AS total,
                 SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END)::int AS enabled,
                 SUM(CASE WHEN "lastRunStatus" = 'failed'
                           AND last_run_at > NOW() - INTERVAL '24 hours'
                          THEN 1 ELSE 0 END)::int AS failed24h
            FROM cron_jobs
        `);
        const x = (r.rows ?? [])[0] ?? {};
        return {
          total: Number(x.total ?? 0), enabled: Number(x.enabled ?? 0),
          failed24h: Number(x.failed24h ?? 0), overdue: 0,
        };
      }, { logger }),
      collect('recentChanges', async () => {
        const r = await db.execute<{ action_type: string; actor: string | null; at: string; http_status: number | null }>(sql`
          SELECT action_type, actor_id AS actor, created_at AS at, http_status
            FROM audit_logs
           ORDER BY created_at DESC
           LIMIT 6
        `);
        return (r.rows ?? []).map((row) => ({
          severity: (row.http_status != null && row.http_status >= 500
            ? 'critical'
            : row.http_status != null && row.http_status >= 400 ? 'warning' : 'ok') as 'ok' | 'warning' | 'critical',
          label: row.action_type,
          actor: row.actor ?? 'system',
          at: String(row.at),
        }));
      }, { logger }),
    ]);

  return {
    generatedAt: new Date().toISOString(),
    alerts, tenants, backups, certificates,
    // WAL health needs the cluster, so the fast endpoint reports it unknown
    // rather than pretending. The live endpoint fills it in.
    database: { state: 'stale', reason: 'read on the slow refresh', observedAt: null, data: null },
    updates, scheduledTasks, recentChanges,
  } as AdminDashboardSummary;
}

async function buildBackupClasses(db: Database): Promise<AdminDashboardSummary['backups']['data']> {
  const assign = await db.execute<{ backup_class: string; target: string | null; kind: string | null }>(sql`
    SELECT a.backup_class, c.name AS target, c."storageType" AS kind
      FROM backup_target_assignments a
      LEFT JOIN backup_configurations c ON c.id = a.target_id
  `);
  const byClass = new Map((assign.rows ?? []).map((r) => [r.backup_class, r]));

  const fresh = await db.execute<{ newest: string | null; bundles: number }>(sql`
    SELECT MAX(created_at) AS newest, COUNT(*)::int AS bundles
      FROM backup_jobs WHERE status = 'completed'
  `);
  const f = (fresh.rows ?? [])[0];

  const repo = await db.execute<{ total: number | null }>(sql`
    SELECT SUM(repo_total_bytes)::bigint AS total FROM tenant_restic_repo_state
  `);

  const never = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM tenants t
     WHERE t.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM backup_jobs b WHERE b.tenant_id = t.id AND b.status = 'completed')
  `);

  return {
    classes: (['system', 'tenant', 'mail'] as const).map((cls) => {
      const a = byClass.get(cls);
      return {
        backupClass: cls,
        lastSuccessAt: cls === 'tenant' ? (f?.newest ? String(f.newest) : null) : null,
        targetName: a?.target ?? null,
        targetKind: a?.kind ?? null,
        healthy: Boolean(a?.target),
      };
    }),
    bundles: Number(f?.bundles ?? 0),
    repoBytes: (repo.rows ?? [])[0]?.total == null ? null : Number((repo.rows ?? [])[0].total),
    tenantsNeverBackedUp: Number((never.rows ?? [])[0]?.n ?? 0),
  };
}

/* ── slow: everything that has to leave the API ───────────────────── */

interface RawNode {
  metadata?: { name?: string; labels?: Record<string, string> };
  status?: {
    allocatable?: Record<string, string>;
    conditions?: Array<{ type: string; status: string }>;
    nodeInfo?: { kubeletVersion?: string };
  };
}

/**
 * Kubernetes writes CPU three ways and they are not interchangeable:
 * `"3500m"` on a node's allocatable, `"3.5"` as a plain quantity, and
 * `"897123456n"` (nanocores) from the metrics API. Reading a nanocore figure
 * as plain cores overstates usage by a factor of a billion.
 */
function cpuToCores(v: string | undefined): number {
  if (!v) return 0;
  if (v.endsWith('n')) return Number(v.slice(0, -1)) / 1e9;
  if (v.endsWith('u')) return Number(v.slice(0, -1)) / 1e6;
  if (v.endsWith('m')) return Number(v.slice(0, -1)) / 1000;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function memToGiB(v: string | undefined): number {
  if (!v) return 0;
  const m = /^(\d+)(Ki|Mi|Gi|Ti)?$/.exec(v);
  if (!m) return 0;
  const n = Number(m[1]);
  const mult: Record<string, number> = { Ki: 1 / 1048576, Mi: 1 / 1024, Gi: 1, Ti: 1024 };
  return n * (mult[m[2] ?? 'Ki'] ?? 1 / 1048576);
}

export async function buildAdminLive(
  db: Database,
  k8s: K8sClients,
  logger?: Logger,
): Promise<AdminDashboardLive> {
  const nodesSection = await collect('nodes', async () => {
    const list = (await k8s.core.listNode()) as unknown as { items?: RawNode[] };
    const pods = (await k8s.core.listPodForAllNamespaces()) as unknown as {
      items?: Array<{
        metadata?: { name?: string; namespace?: string };
        status?: { phase?: string };
        spec?: { nodeName?: string; containers?: Array<{ resources?: { requests?: Record<string, string> } }> };
      }>;
    };

    const perNode = new Map<string, { cpuReq: number; memReq: number; count: number }>();
    for (const p of pods.items ?? []) {
      const n = p.spec?.nodeName;
      if (!n) continue;
      // A Succeeded or Failed pod still has a record and still lists its
      // requests, but it holds nothing: the scheduler has already released
      // them. Counting terminal pods made committed CPU exceed the node's own
      // allocatable — 3.60 of 3.50 cores — and inflated the pod count by the
      // reboot corpses sitting on the node.
      const phase = p.status?.phase;
      if (phase === 'Succeeded' || phase === 'Failed') continue;
      const acc = perNode.get(n) ?? { cpuReq: 0, memReq: 0, count: 0 };
      for (const c of p.spec?.containers ?? []) {
        acc.cpuReq += cpuToCores(c.resources?.requests?.cpu);
        acc.memReq += memToGiB(c.resources?.requests?.memory);
      }
      acc.count += 1;
      perNode.set(n, acc);
    }

    // Actual usage, from the metrics API. Without it the triad's headline
    // figure would be a hardcoded zero, which is worse than absent: the tile
    // would read "0.00 cores in use" on a busy cluster.
    const usage = new Map<string, { cpu: number; mem: number }>();
    try {
      const nm = await k8s.custom.listClusterCustomObject({
        group: 'metrics.k8s.io', version: 'v1beta1', plural: 'nodes',
      }) as { items?: Array<{ metadata?: { name?: string }; usage?: { cpu?: string; memory?: string } }> };
      for (const m of nm.items ?? []) {
        const name = m.metadata?.name;
        if (!name) continue;
        usage.set(name, { cpu: cpuToCores(m.usage?.cpu), mem: memToGiB(m.usage?.memory) });
      }
    } catch (err) {
      // An EMPTY catch here cost a debugging cycle: the tiles rendered
      // "0.00 cores in use" on a live cluster and there was nothing anywhere
      // saying why. Whatever goes wrong must be visible.
      logger?.warn?.(
        { err: err instanceof Error ? err.message : String(err) },
        'dashboard: node metrics unavailable — usage will read as unknown',
      );
    }

    const health = await db.execute<{ node_name: string; severity: string; disk_used_pct: string | null; evictions: number; pressures: string[] | null }>(sql`
      SELECT node_name, severity, disk_used_pct, evictions_last_hour AS evictions, pressures
        FROM node_health_state
    `).catch(() => ({ rows: [] as Array<{ node_name: string; severity: string; disk_used_pct: string | null; evictions: number; pressures: string[] | null }> }));
    const byName = new Map((health.rows ?? []).map((h) => [h.node_name, h]));

    return (list.items ?? []).map((n): AdminNode => {
      const name = n.metadata?.name ?? '(unnamed)';
      const req = perNode.get(name) ?? { cpuReq: 0, memReq: 0, count: 0 };
      const h = byName.get(name);
      const ready = (n.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
      const u = usage.get(name);
      const isServer = (n.metadata?.labels ?? {})['node-role.kubernetes.io/control-plane'] != null;
      return {
        name,
        role: isServer ? 'server' : 'worker',
        ready,
        cpu: {
          // Requests are what the scheduler honours; usage is what is really
          // happening. The gap between them is the whole point of the tile.
          inUse: Math.round((u?.cpu ?? 0) * 1000) / 1000,
          committed: Math.round(req.cpuReq * 1000) / 1000,
          total: cpuToCores(n.status?.allocatable?.cpu), unit: 'cores', kind: 'reserve',
        },
        memory: {
          inUse: Math.round((u?.mem ?? 0) * 100) / 100,
          committed: Math.round(req.memReq * 100) / 100,
          total: Math.round(memToGiB(n.status?.allocatable?.memory) * 100) / 100,
          unit: 'GiB', kind: 'reserve',
        },
        diskUsedPct: h?.disk_used_pct == null ? null : Number(h.disk_used_pct),
        pods: req.count,
        calico: 'unknown', csi: 'unknown',
        evictionsLastHour: Number(h?.evictions ?? 0),
        pressures: h?.pressures ?? [],
        kubeletVersion: n.status?.nodeInfo?.kubeletVersion ?? null,
        ingressMode: null,
        tenantWorkloads: true,
      };
    });
  }, { logger, timeoutMs: 4_000 });

  const cluster = await collect('cluster', async () => {
    const nodes = nodesSection.data ?? [];

    // Storage comes from Longhorn, which is the only thing that knows what a
    // volume actually holds. Left at zeros it rendered "0.0 GB in use of 0.0",
    // which reads as a measurement rather than as missing data.
    let storageTriad = { inUse: 0, committed: 0, total: 0, unit: 'GB', kind: 'consume' as const };
    try {
      const vols = await k8s.custom.listNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'volumes',
      }) as { items?: Array<{ spec?: { size?: string | number }; status?: { actualSize?: string | number } }> };
      const num = (v: string | number | undefined): number =>
        typeof v === 'number' ? v : Number(v ?? 0) || 0;
      const used = (vols.items ?? []).reduce((t, v) => t + num(v.status?.actualSize), 0);
      const req = (vols.items ?? []).reduce((t, v) => t + num(v.spec?.size), 0);
      storageTriad = {
        inUse: Math.round((used / 1e9) * 10) / 10,
        committed: Math.round((req / 1e9) * 10) / 10,
        total: Math.round((req / 1e9) * 10) / 10,
        unit: 'GB', kind: 'consume' as const,
      };
    } catch (err) {
      logger?.warn?.(
        { err: err instanceof Error ? err.message : String(err) },
        'dashboard: Longhorn volumes unreadable — storage will read as zero',
      );
    }

    const sum = (f: (n: AdminNode) => number): number =>
      Math.round(nodes.reduce((s, n) => s + f(n), 0) * 100) / 100;
    const cpuTotal = sum((n) => n.cpu.total);
    const cpuReq = sum((n) => n.cpu.committed);
    const biggest = nodes.reduce<AdminNode | null>(
      (a, b) => (a === null || b.cpu.total > a.cpu.total ? b : a), null);
    return {
      cpu: {
        inUse: sum((n) => n.cpu.inUse), committed: cpuReq,
        total: cpuTotal, unit: 'cores', kind: 'reserve' as const,
      },
      memory: {
        inUse: sum((n) => n.memory.inUse),
        committed: sum((n) => n.memory.committed),
        total: sum((n) => n.memory.total), unit: 'GiB', kind: 'reserve' as const,
      },
      storage: storageTriad,
      nodeCount: nodes.length,
      // One node cannot survive losing one node. Stating that plainly beats
      // rendering a headroom percentage that means nothing at n=1.
      survivesSingleNodeLoss: nodes.length > 1
        && (cpuTotal - (biggest?.cpu.total ?? 0)) >= cpuReq,
      worstNode: biggest?.name ?? null,
    };
  }, { logger });

  const clusterAlerts = await collect('clusterAlerts', async () => {
    const [vol, orphans] = await Promise.all([
      buildVolumeAlert(k8s).catch(() => null),
      buildOrphanedPodAlert(k8s).catch(() => null),
    ]);
    return rankAlerts([vol, orphans].filter((a): a is NonNullable<typeof a> => a != null));
  }, { logger, timeoutMs: 4_000 });

  const mail = await collect('mail', async () => {
    const r = await db.execute<Record<string, number>>(sql`
      SELECT
        (SELECT COALESCE(SUM(sent_count),0)::int FROM email_send_counters
          WHERE bucket_start > NOW() - INTERVAL '7 days') AS sent7d,
        (SELECT COALESCE(SUM(rate_limited_count),0)::int FROM email_send_counters
          WHERE bucket_start > NOW() - INTERVAL '7 days') AS rate_limited,
        (SELECT COUNT(*)::int FROM mailboxes WHERE status = 'active') AS mailboxes,
        (SELECT COUNT(*)::int FROM email_domains) AS email_domains,
        (SELECT COUNT(*)::int FROM mailboxes
          WHERE status = 'active' AND quota_mb > 0 AND platform_managed = FALSE
            AND (used_mb::numeric / quota_mb) >= 1) AS over_quota
    `);
    const x = (r.rows ?? [])[0] ?? {};
    return {
      sent7d: Number(x.sent7d ?? 0),
      queueDepth: 0, queueReachable: true,
      mailboxes: Number(x.mailboxes ?? 0),
      emailDomains: Number(x.email_domains ?? 0),
      rateLimited7d: Number(x.rate_limited ?? 0),
      overQuotaMailboxes: Number(x.over_quota ?? 0),
    };
  }, { logger });

  const webDefence = await collect('webDefence', async () => {
    const agg = await db.execute<Record<string, number | string | null>>(sql`
      SELECT COUNT(*)::int AS blocked,
             SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END)::int AS critical,
             COUNT(DISTINCT source_ip)::int AS sources,
             MODE() WITHIN GROUP (ORDER BY rule_id) AS top_rule
        FROM waf_logs
       WHERE created_at > NOW() - INTERVAL '24 hours'
    `);
    const a = (agg.rows ?? [])[0] ?? {};
    const recent = await db.execute<{ severity: string; message: string | null; hostname: string | null; request_uri: string | null; created_at: string }>(sql`
      SELECT severity, message, hostname, request_uri, created_at
        FROM waf_logs ORDER BY created_at DESC LIMIT 6
    `);
    return {
      blocked24h: Number(a.blocked ?? 0),
      critical24h: Number(a.critical ?? 0),
      distinctSources: Number(a.sources ?? 0),
      activeBans: 0,
      topRuleId: a.top_rule == null ? null : String(a.top_rule),
      wafEnabled: true,
      recent: (recent.rows ?? []).map((r) => ({
        severity: (r.severity === 'critical' ? 'critical' : 'warning') as 'warning' | 'critical',
        label: r.message ?? r.request_uri ?? 'blocked request',
        source: r.hostname ?? '—',
        at: String(r.created_at),
      })),
    };
  }, { logger });

  return {
    generatedAt: new Date().toISOString(),
    cluster,
    nodes: nodesSection,
    mail,
    webDefence,
    // Surfaced alongside the fast band; the UI concatenates the two.
    clusterAlerts,
  };
}

/** Unit conversions, exported for test. Wrong by a factor of a billion is
 *  still a plausible-looking number, so these are pinned. */
export const __testing = { cpuToCores, memToGiB };
