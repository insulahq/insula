import { sql } from 'drizzle-orm';
import type { TenantDashboardSummary, TenantDashboardLive, TenantSite } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { collect } from './section.js';
import { buildTenantAlerts } from './alerts.js';

interface Logger { warn?(...a: unknown[]): void }

/**
 * The customer's half of the dashboard.
 *
 * Same two-endpoint split as the operator console, and the same rule about
 * alerts: a tile only exists where a notification category exists to raise it.
 * What differs is the question being answered. An operator asks "is the
 * platform broken"; a customer asks "are my sites up, and am I about to run
 * out of something I pay for". So there are no node names here, no Calico, no
 * cluster internals — and `reserved` is framed as what their own apps hold,
 * because that is the number that refuses their next deployment.
 */

export async function buildTenantSummary(
  db: Database,
  tenantId: string,
  logger?: Logger,
): Promise<TenantDashboardSummary> {
  const [alerts, plan, mail, domains, backups, scheduledTasks, recentChanges] = await Promise.all([
    collect('alerts', () => buildTenantAlerts(db, tenantId), { logger }),

    collect('plan', async () => {
      const r = await db.execute<Record<string, string | number | boolean | null>>(sql`
        SELECT COALESCE(p.name, 'Custom') AS plan_name,
               COALESCE(t.bandwidth_gb_used, 0)::float8 AS used_gb,
               COALESCE(NULLIF(t.bandwidth_limit_override, 0), p.bandwidth_gb_limit, 0)::float8 AS limit_gb,
               COALESCE(t.bandwidth_capped, FALSE) AS capped,
               t.bandwidth_cycle_start AS cycle_start
          FROM tenants t
          LEFT JOIN hosting_plans p ON p.id = t.plan_id
         WHERE t.id = ${tenantId}
      `);
      const x = (r.rows ?? [])[0] ?? {};
      // Cycles run a month from their start; a null start means the tenant has
      // not billed yet, and guessing a reset date would be worse than none.
      const start = x.cycle_start ? new Date(String(x.cycle_start)) : null;
      const resetDays = start
        ? Math.max(0, 30 - Math.floor((Date.now() - start.getTime()) / 86_400_000))
        : null;
      return {
        name: String(x.plan_name ?? 'Custom'),
        bandwidthUsedGb: Number(x.used_gb ?? 0),
        bandwidthLimitGb: Number(x.limit_gb ?? 0),
        bandwidthResetDays: resetDays,
        bandwidthCapped: Boolean(x.capped),
      };
    }, { logger }),

    collect('mail', async () => {
      const r = await db.execute<Record<string, number | string | null>>(sql`
        SELECT
          (SELECT COUNT(*)::int FROM mailboxes WHERE tenant_id = ${tenantId} AND status = 'active') AS boxes,
          (SELECT COALESCE(p.max_mailboxes, 0)::int FROM tenants t
             LEFT JOIN hosting_plans p ON p.id = t.plan_id WHERE t.id = ${tenantId}) AS max_boxes,
          (SELECT COALESCE(SUM(used_mb), 0)::float8 FROM mailboxes
            WHERE tenant_id = ${tenantId} AND status = 'active') AS used_mb,
          (SELECT COALESCE(SUM(quota_mb), 0)::float8 FROM mailboxes
            WHERE tenant_id = ${tenantId} AND status = 'active') AS quota_mb,
          (SELECT COALESCE(SUM(sent_count), 0)::int FROM email_send_counters
            WHERE tenant_id = ${tenantId} AND bucket_start > date_trunc('day', NOW())) AS sent_today,
          (SELECT COALESCE(p.email_daily_send_limit, 0)::int FROM tenants t
             LEFT JOIN hosting_plans p ON p.id = t.plan_id WHERE t.id = ${tenantId}) AS daily_limit
      `);
      const x = (r.rows ?? [])[0] ?? {};
      const fullest = await db.execute<{ full_address: string; pct: number }>(sql`
        SELECT full_address, ROUND((used_mb::numeric / NULLIF(quota_mb,0)) * 100)::int AS pct
          FROM mailboxes
         WHERE tenant_id = ${tenantId} AND status = 'active' AND quota_mb > 0
           AND platform_managed = FALSE
         ORDER BY (used_mb::numeric / NULLIF(quota_mb,0)) DESC NULLS LAST
         LIMIT 1
      `);
      const f = (fullest.rows ?? [])[0];
      return {
        mailboxes: Number(x.boxes ?? 0),
        maxMailboxes: Number(x.max_boxes ?? 0),
        storageUsedGb: Number(x.used_mb ?? 0) / 1024,
        storageLimitGb: Number(x.quota_mb ?? 0) / 1024,
        fullestMailboxPct: f ? Number(f.pct) : null,
        fullestMailboxAddress: f ? f.full_address : null,
        sentToday: Number(x.sent_today ?? 0),
        dailyLimit: Number(x.daily_limit ?? 0),
      };
    }, { logger }),

    collect('domains', async () => {
      const r = await db.execute<Record<string, number | null>>(sql`
        SELECT
          (SELECT COUNT(*)::int FROM domains WHERE tenant_id = ${tenantId}) AS total,
          (SELECT COUNT(*)::int FROM domains WHERE tenant_id = ${tenantId} AND status::text = 'active') AS verified,
          (SELECT COUNT(*)::int FROM ssl_certificates WHERE tenant_id = ${tenantId}
             AND COALESCE(status,'') <> 'revoked') AS certs,
          (SELECT MIN(EXTRACT(DAY FROM (expires_at - NOW())))::int FROM ssl_certificates
            WHERE tenant_id = ${tenantId} AND expires_at IS NOT NULL) AS nearest
      `);
      const x = (r.rows ?? [])[0] ?? {};
      return {
        domains: Number(x.total ?? 0), verified: Number(x.verified ?? 0),
        certificates: Number(x.certs ?? 0),
        nearestRenewalDays: x.nearest == null ? null : Number(x.nearest),
      };
    }, { logger }),

    collect('backups', async () => {
      const r = await db.execute<{ n: number; newest: string | null; oldest: string | null }>(sql`
        SELECT COUNT(*)::int AS n, MAX(created_at) AS newest, MIN(created_at) AS oldest
          FROM backup_jobs WHERE tenant_id = ${tenantId} AND status = 'completed'
      `);
      const x = (r.rows ?? [])[0];
      return {
        restorePoints: Number(x?.n ?? 0),
        newestAt: x?.newest ? String(x.newest) : null,
        oldestAt: x?.oldest ? String(x.oldest) : null,
        coversFiles: true, coversDatabases: true,
      };
    }, { logger }),

    collect('scheduledTasks', async () => {
      const r = await db.execute<Record<string, number | string | null>>(sql`
        SELECT COUNT(*)::int AS total,
               SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END)::int AS enabled,
               SUM(CASE WHEN "lastRunStatus" = 'failed' THEN 1 ELSE 0 END)::int AS failed
          FROM cron_jobs WHERE tenant_id = ${tenantId}
      `);
      const x = (r.rows ?? [])[0] ?? {};
      return {
        total: Number(x.total ?? 0), enabled: Number(x.enabled ?? 0),
        failed24h: Number(x.failed ?? 0), nextRunAt: null,
      };
    }, { logger }),

    collect('recentChanges', async () => {
      const r = await db.execute<{ action_type: string; actor: string | null; at: string; http_status: number | null }>(sql`
        SELECT action_type, actor_id AS actor, created_at AS at, http_status
          FROM audit_logs
         WHERE resource_id = ${tenantId} OR actor_id IN (
           SELECT id FROM users WHERE tenant_id = ${tenantId}
         )
         ORDER BY created_at DESC LIMIT 6
      `);
      return (r.rows ?? []).map((row) => ({
        severity: (row.http_status != null && row.http_status >= 500 ? 'critical'
          : row.http_status != null && row.http_status >= 400 ? 'warning' : 'ok') as 'ok' | 'warning' | 'critical',
        label: row.action_type, actor: row.actor ?? 'system', at: String(row.at),
      }));
    }, { logger }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    alerts, plan, mail, domains, backups, scheduledTasks, recentChanges,
  };
}

export async function buildTenantLive(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  namespace: string,
  planLimits: { cpuLimit: number; memoryLimitGi: number; storageLimitGi: number },
  logger?: Logger,
): Promise<TenantDashboardLive> {
  const resources = await collect('resources', async () => {
    const { collectTenantMetrics } = await import('../metrics/resource-metrics.js');
    const m = await collectTenantMetrics(db, k8s, tenantId, namespace, planLimits);
    return {
      cpu: { inUse: m.cpu.inUse, committed: m.cpu.reserved, total: m.cpu.available, unit: 'cores', kind: 'reserve' as const },
      memory: { inUse: m.memory.inUse, committed: m.memory.reserved, total: m.memory.available, unit: 'GiB', kind: 'reserve' as const },
      // Disk is CONSUMED, not reserved: a tenant's free storage is the limit
      // minus what is on disk, and there is no reserved band to show.
      storage: { inUse: m.storage.inUse, committed: m.storage.inUse, total: m.storage.available, unit: 'GiB', kind: 'consume' as const },
    };
  }, { logger, timeoutMs: 4_000 });

  const sites = await collect('sites', async () => {
    const r = await db.execute<Record<string, string | number | null>>(sql`
      SELECT r.hostname,
             COALESCE(d.name, 'Site') AS application,
             COALESCE(d.status::text, 'unknown') AS status,
             r.created_at,
             (SELECT COUNT(*)::int FROM waf_logs w
               WHERE w.route_id = r.id AND w.created_at > NOW() - INTERVAL '7 days') AS blocked,
             (SELECT COUNT(*)::int FROM cron_jobs c WHERE c.deployment_id = d.id) AS crons,
             (SELECT MIN(EXTRACT(DAY FROM (s.expires_at - NOW())))::int FROM ssl_certificates s
               WHERE s.domain_id = r.domain_id AND s.expires_at IS NOT NULL) AS tls_days
        FROM ingress_routes r
        LEFT JOIN domains dom ON dom.id = r.domain_id
        LEFT JOIN deployments d ON d.id = r.deployment_id
       WHERE dom.tenant_id = ${tenantId}
       ORDER BY r.hostname
       LIMIT 25
    `);
    return (r.rows ?? []).map((x): TenantSite => {
      const days = x.tls_days == null ? null : Number(x.tls_days);
      return {
        host: String(x.hostname ?? ''),
        application: String(x.application ?? 'Site'),
        status: String(x.status ?? 'unknown'),
        tlsState: days == null ? 'none' : days <= 0 ? 'expired' : 'valid',
        tlsDaysRemaining: days,
        trafficGb7d: 0, requests7d: null,
        blocked7d: Number(x.blocked ?? 0),
        diskGb: null,
        cronJobs: Number(x.crons ?? 0),
        lastDeployedAt: x.created_at ? String(x.created_at) : null,
      };
    });
  }, { logger });

  const blocked = await collect('blocked', async () => {
    const r = await db.execute<{ severity: string; message: string | null; hostname: string | null; request_uri: string | null; created_at: string }>(sql`
      SELECT severity, message, hostname, request_uri, created_at
        FROM waf_logs WHERE tenant_id = ${tenantId}
       ORDER BY created_at DESC LIMIT 6
    `);
    return (r.rows ?? []).map((x) => ({
      severity: (x.severity === 'critical' ? 'critical' : 'warning') as 'warning' | 'critical',
      label: x.message ?? x.request_uri ?? 'blocked request',
      host: x.hostname ?? '—',
      at: String(x.created_at),
    }));
  }, { logger });

  return { generatedAt: new Date().toISOString(), resources, sites, blocked };
}
