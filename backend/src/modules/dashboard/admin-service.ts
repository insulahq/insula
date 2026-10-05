import { sql } from 'drizzle-orm';
import type { AdminDashboardSummary, AdminDashboardLive, AdminNode } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { collect } from './section.js';
import { aliasAlertSection, buildAdminAlerts, rankAlerts } from './alerts.js';
import { loadNodeLabels } from '../nodes/labels.js';
import {
  buildVolumeAlert, buildOrphanedPodAlert, buildOrphanedVolumeAlert, loadTenantsByNamespace,
} from './cluster-alerts.js';
import { readCpuReservation, buildCpuReservationAlert, buildCpuReservationNotice } from './cpu-reservation.js';
import { buildBackupClasses } from './backup-classes.js';
import { buildWebDefence } from './web-defence.js';

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
        // The audit log is mostly MACHINE bookkeeping. Over seven days on
        // production: 1006 `snapshot-last-run`, 556 `event`, 528 `file`,
        // 309 `auth`. Taking the six most recent rows meant the tile showed
        // that noise, every row `create`, every row green — which is exactly
        // the "no informational value" an operator reported.
        //
        // So: a human actor, a mutating method, and none of the bookkeeping
        // resource types. What is left is the administrative change an
        // operator console is for — a domain added, a deployment updated, a
        // mailbox deleted, an upgrade applied.
        const r = await db.execute<{
          action_type: string; resource_type: string | null; actor: string | null;
          tenant_name: string | null; at: string; http_status: number | null;
        }>(sql`
          SELECT a.action_type, a.resource_type, u.email AS actor,
                 COALESCE(rt.name, t.name) AS tenant_name,
                 a.created_at AS at, a.http_status
            FROM audit_logs a
            JOIN users u ON u.id = a.actor_id
            LEFT JOIN tenants rt ON rt.id = a.resource_type
            LEFT JOIN tenants t  ON t.id = a.tenant_id
           WHERE a.http_method IN ('POST', 'PUT', 'PATCH', 'DELETE')
             AND COALESCE(a.resource_type, '') NOT IN (
               'snapshot-last-run', 'event', 'audit', 'login', 'auth', 'session',
               'passkey', 'notification', 'file', 'email', 'resource-metric'
             )
           ORDER BY a.created_at DESC
           LIMIT 6
        `);
        return (r.rows ?? []).map((row) => ({
          severity: (row.http_status != null && row.http_status >= 500
            ? 'critical'
            : row.http_status != null && row.http_status >= 400 ? 'warning' : 'ok') as 'ok' | 'warning' | 'critical',
          label: describeChange(row.action_type, row.resource_type, row.tenant_name),
          actor: row.actor ?? 'system',
          at: String(row.at),
        }));
      }, { logger }),
    ]);

  const nodeLabels = await loadNodeLabels(db).catch(() => null);
  return {
    generatedAt: new Date().toISOString(),
    alerts: aliasAlertSection(alerts, nodeLabels), tenants, backups, certificates,
    // WAL health needs the cluster, so the fast endpoint reports it unknown
    // rather than pretending. The live endpoint fills it in.
    database: { state: 'stale', reason: 'read on the slow refresh', observedAt: null, data: null },
    updates, scheduledTasks, recentChanges,
  } as AdminDashboardSummary;
}


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "create" on its own tells an operator nothing. Name the thing.
 *
 * Two quirks of the existing audit rows are handled rather than papered over:
 * `resource_type` sometimes holds a TENANT ID instead of a type (so the
 * tenant's name is used), and the plural-stripping that produced `mailboxe`
 * is corrected on the way out. Neither is worth a migration; both are worth
 * not showing to a human.
 */
export function describeChange(
  action: string,
  resourceType: string | null,
  tenantName: string | null,
): string {
  const verb = action.includes('.') ? action.split('.').slice(1).join(' ') : action;
  if (resourceType && UUID_RE.test(resourceType)) {
    return tenantName ? `${verb} · ${tenantName}` : verb;
  }
  const noun = (resourceType ?? '').replace(/e$/, (m, i: number, str: string) =>
    str.endsWith('boxe') ? '' : m);
  if (!noun) return verb;
  return tenantName ? `${verb} ${noun} · ${tenantName}` : `${verb} ${noun}`;
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

export interface AdminLiveDeps {
  /** The Banned IPs list's own count — security-hardening/crowdsec-ban-list.ts. */
  readonly countActiveBans: () => Promise<number>;
}

export async function buildAdminLive(
  db: Database,
  k8s: K8sClients,
  deps: AdminLiveDeps,
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
          // null when this node has no metrics sample: `?? 0` made an
          // unmeasured node indistinguishable from a silent one, and the tile
          // then had to guess which it was looking at.
          inUse: u ? Math.round(u.cpu * 1_000_000) / 1_000_000 : null,
          committed: Math.round(req.cpuReq * 1000) / 1000,
          total: cpuToCores(n.status?.allocatable?.cpu), unit: 'cores', kind: 'reserve',
        },
        memory: {
          inUse: u ? Math.round(u.mem * 100) / 100 : null,
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
    let storageBreakdown: {
      tenants: number; mail: number; system: number; imagesAndOther: number;
    } | null = null;
    try {
      const num = (v: string | number | undefined): number =>
        typeof v === 'number' ? v : Number(v ?? 0) || 0;
      const gb = (bytes: number): number => Math.round((bytes / 1e9) * 10) / 10;

      // TOTAL is the node's disk, not the sum of volume requests.
      //
      // It used to be the requests, which made `total` and `committed` the
      // same number and "free" the gap between requested and written — never
      // free disk. On production that reported a 160 GB cluster with 36 GB
      // used, on a node holding 540 GB with 101 GB used.
      //
      // Longhorn's node diskStatus is the right source: storageMaximum is the
      // filesystem, storageAvailable what is left on it, storageScheduled the
      // sum of what volumes have claimed. Used = maximum - available, which
      // counts everything on the disk including images and logs, not just
      // what Longhorn put there.
      const lhNodes = await k8s.custom.listNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'nodes',
      }) as { items?: Array<{ status?: { diskStatus?: Record<string, {
        storageMaximum?: number; storageAvailable?: number; storageScheduled?: number;
      }> } }> };

      let max = 0, avail = 0, scheduled = 0;
      for (const n of lhNodes.items ?? []) {
        for (const d of Object.values(n.status?.diskStatus ?? {})) {
          max += num(d.storageMaximum);
          avail += num(d.storageAvailable);
          scheduled += num(d.storageScheduled);
        }
      }
      const usedBytes = Math.max(0, max - avail);

      storageTriad = {
        inUse: gb(usedBytes),
        committed: gb(scheduled),
        total: gb(max),
        unit: 'GB', kind: 'consume' as const,
      };

      // Breakdown. Longhorn volumes split by namespace; mail comes from the
      // platform's own mailbox accounting because the mail stack sits on a
      // node-pinned local-path PVC that Longhorn cannot see at all — a "Mail"
      // line fed from Longhorn would read 0 on a cluster holding 38 GB of it.
      const vols = await k8s.custom.listNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'volumes',
      }) as { items?: Array<{
        status?: { actualSize?: string | number; kubernetesStatus?: { namespace?: string } };
      }> };

      let tenantBytes = 0, systemBytes = 0;
      for (const v of vols.items ?? []) {
        const ns = v.status?.kubernetesStatus?.namespace ?? '';
        const actual = num(v.status?.actualSize);
        if (ns.startsWith('tenant-')) tenantBytes += actual;
        else systemBytes += actual;
      }

      const mailRow = await db.execute<{ mb: number | string | null }>(sql`
        SELECT COALESCE(SUM(used_mb), 0) AS mb FROM mailboxes
      `);
      const mailBytes = Number((mailRow.rows ?? [])[0]?.mb ?? 0) * 1024 * 1024;

      storageBreakdown = {
        tenants: gb(tenantBytes),
        mail: gb(mailBytes),
        system: gb(systemBytes),
        // A remainder, and named as one: container images, logs and anything
        // else on the disk. Clamped at zero so a mail figure that runs ahead
        // of the disk sample cannot render a negative slice.
        imagesAndOther: Math.max(0, gb(usedBytes - tenantBytes - systemBytes - mailBytes)),
      };
    } catch (err) {
      logger?.warn?.(
        { err: err instanceof Error ? err.message : String(err) },
        'dashboard: Longhorn unreadable — storage will read as zero',
      );
    }

    const sum = (f: (n: AdminNode) => number): number =>
      Math.round(nodes.reduce((s, n) => s + f(n), 0) * 100) / 100;
    const cpuTotal = sum((n) => n.cpu.total);
    const cpuReq = sum((n) => n.cpu.committed);
    /**
     * One unmeasured node makes the CLUSTER figure unknown, not smaller.
     * Summing the nodes that did answer and presenting the result as the
     * cluster's usage understates it by exactly the part nobody measured —
     * and understated usage is the direction that reads as healthy.
     */
    const sumUsage = (pick: (n: AdminNode) => number | null): number | null => {
      let acc = 0;
      for (const n of nodes) {
        const v = pick(n);
        if (v === null) return null;
        acc += v;
      }
      return acc;
    };
    const biggest = nodes.reduce<AdminNode | null>(
      (a, b) => (a === null || b.cpu.total > a.cpu.total ? b : a), null);
    return {
      cpu: {
        inUse: sumUsage((n) => n.cpu.inUse), committed: cpuReq,
        total: cpuTotal, unit: 'cores', kind: 'reserve' as const,
      },
      memory: {
        inUse: sumUsage((n) => n.memory.inUse),
        committed: sum((n) => n.memory.committed),
        total: sum((n) => n.memory.total), unit: 'GiB', kind: 'reserve' as const,
      },
      storage: storageTriad,
      storageBreakdown,
      nodeCount: nodes.length,
      // One node cannot survive losing one node. Stating that plainly beats
      // rendering a headroom percentage that means nothing at n=1.
      survivesSingleNodeLoss: nodes.length > 1
        && (cpuTotal - (biggest?.cpu.total ?? 0)) >= cpuReq,
      worstNode: biggest?.name ?? null,
    };
  }, { logger });

  const clusterAlerts = await collect('clusterAlerts', async () => {
    // Resolved once and shared: every storage alert has to be able to name the
    // tenant behind a volume, and "Volume nearly full" without a customer next
    // to it is not something an operator can act on.
    const tenantsByNs = await loadTenantsByNamespace(db).catch(() => new Map());
    const [vol, orphanVolumes, orphanPods, cpuReservation] = await Promise.all([
      buildVolumeAlert(k8s, tenantsByNs).catch(() => null),
      buildOrphanedVolumeAlert(k8s, tenantsByNs).catch(() => null),
      buildOrphanedPodAlert(k8s).catch(() => null),
      // ADR-062 R1. Reads the node's reserved-vs-used gap — the condition that
      // makes a mostly-idle node refuse work, and whose symptoms always show
      // up somewhere else.
      readCpuReservation(k8s, logger)
        .then(async ({ nodes, pods }) => {
          const a = buildCpuReservationAlert(nodes, pods);
          // Emit as well as render. The condition this reports went entirely
          // unalerted through a real incident — the tile alone would repeat
          // that for anyone not looking at the dashboard. dedupeKey is the
          // node, so a standing condition is one alarm, not one per tick.
          const notice = buildCpuReservationNotice(nodes, pods);
          if (notice) {
            const { notifyAdminCpuReservation } = await import('../notifications/events.js');
            await notifyAdminCpuReservation(
              db, { ...notice, occurredAt: new Date().toISOString() },
              `cpu-reservation:${notice.nodeName}`,
            ).catch(() => undefined);
          }
          return a;
        })
        .catch(() => null),
    ]);
    return rankAlerts(
      [vol, orphanVolumes, orphanPods, cpuReservation]
        .filter((a): a is NonNullable<typeof a> => a != null),
    );
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

  // Above the ban count's own deadline, so a slow LAPI costs the tile its ban
  // figure rather than the whole tile (web-defence.ts).
  const webDefence = await collect(
    'webDefence',
    () => buildWebDefence(db, deps.countActiveBans, logger),
    { logger, timeoutMs: 4_000 },
  );

  return {
    generatedAt: new Date().toISOString(),
    cluster,
    nodes: nodesSection,
    mail,
    webDefence,
    // Surfaced alongside the fast band; the UI concatenates the two.
    clusterAlerts: aliasAlertSection(clusterAlerts, await loadNodeLabels(db).catch(() => null)),
  };
}

/** Unit conversions, exported for test. Wrong by a factor of a billion is
 *  still a plausible-looking number, so these are pinned. */
export const __testing = { cpuToCores, memToGiB };
