/**
 * The Platform and Operations status tiles of the operator console: what each
 * figure counts, and — for every figure that can turn amber or red — which
 * things it counts.
 *
 * Their hover cards used to repeat the figures: "Overdue for renewal 2",
 * "Failures, 24h 3", "Provisioning in flight 1". Each list here is capped at
 * DASHBOARD_SUBJECT_LIMIT; the figure beside it stays the total.
 */
import { sql } from 'drizzle-orm';
import type { AdminDashboardSummary, DashboardSubject } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import { autoRenewedSql, renewalOverdueSql } from '../certificates/renewal-policy-sql.js';
import { getAdminUpgradesOverview } from '../deployments/upgrade-version.js';
import { isNewer } from '../platform-updates/service.js';
import { queuedMessageCount } from '../stalwart-jmap/client.js';
import { DASHBOARD_SUBJECT_LIMIT, daysLeft, forHowLong } from './subjects.js';

type Data<K extends keyof AdminDashboardSummary> =
  NonNullable<AdminDashboardSummary[K] extends { data: infer D } ? D : never>;

export async function buildTenantsTile(db: Database): Promise<Data<'tenants'>> {
  const r = await db.execute<Record<string, number>>(sql`
    SELECT
      (SELECT COUNT(*)::int FROM tenants WHERE status = 'active') AS active,
      (SELECT COUNT(*)::int FROM tenants) AS total,
      (SELECT COUNT(*)::int FROM ingress_routes) AS routes,
      (SELECT COUNT(*)::int FROM domains) AS domains,
      (SELECT COUNT(*)::int FROM provisioning_tasks WHERE status IN ('pending','running')) AS provisioning
  `);
  const x = (r.rows ?? [])[0] ?? {};
  const inFlight = await db.execute<{ tenant: string; type: string; status: string; step: string | null; minutes: number }>(sql`
    SELECT t.name AS tenant, p.type::text AS type, p.status::text AS status, p.current_step AS step,
           FLOOR(EXTRACT(EPOCH FROM (now() - p.created_at)) / 60)::int AS minutes
      FROM provisioning_tasks p
      JOIN tenants t ON t.id = p.tenant_id
     WHERE p.status IN ('pending','running')
     ORDER BY p.created_at ASC
     LIMIT ${DASHBOARD_SUBJECT_LIMIT}
  `);
  return {
    active: Number(x.active ?? 0), total: Number(x.total ?? 0),
    routes: Number(x.routes ?? 0), domains: Number(x.domains ?? 0),
    provisioningInFlight: Number(x.provisioning ?? 0),
    provisioning: (inFlight.rows ?? []).map((p) => ({
      name: p.tenant,
      detail: `${p.type} · ${p.step ?? p.status} · ${forHowLong(Number(p.minutes ?? 0))}`,
    })),
  };
}

export async function buildCertificatesTile(db: Database): Promise<Data<'certificates'>> {
  // INNER join on domains, as in the expiring alert: a certificate row whose
  // domain is gone serves nothing, and until migration 0174 every deleted
  // domain left one behind.
  const overdue = renewalOverdueSql('s', autoRenewedSql('s', 'd'));
  const r = await db.execute<Record<string, number | null>>(sql`
    SELECT COUNT(*)::int AS issued,
           -- is_wildcard is an INTEGER flag, so it needs an explicit
           -- comparison: CASE WHEN requires a boolean predicate.
           SUM(CASE WHEN s.is_wildcard = 1 THEN 1 ELSE 0 END)::int AS wildcards,
           MIN(EXTRACT(DAY FROM (s.expires_at - NOW())))::int AS nearest_days,
           SUM(CASE WHEN s.last_error IS NOT NULL THEN 1 ELSE 0 END)::int AS failing,
           -- Overdue by the renewal policy (half the renewal window gone,
           -- or expired), measured against each certificate's lifetime.
           SUM(CASE WHEN ${overdue} THEN 1 ELSE 0 END)::int AS overdue,
           SUM(CASE WHEN s.last_error IS NOT NULL OR ${overdue} THEN 1 ELSE 0 END)::int AS attention
      FROM ssl_certificates s
      JOIN domains d ON d.id = s.domain_id
     WHERE COALESCE(s.status,'') <> 'revoked'
  `);
  const x = (r.rows ?? [])[0] ?? {};
  const attention = await db.execute<{
    name: string; tenant: string | null; days: number | null; last_error: string | null; overdue: boolean;
  }>(sql`
    SELECT COALESCE(NULLIF(s.subject, ''), d.domain_name) AS name, t.name AS tenant,
           EXTRACT(DAY FROM (s.expires_at - NOW()))::int AS days,
           s.last_error, (${overdue}) AS overdue
      FROM ssl_certificates s
      JOIN domains d ON d.id = s.domain_id
      LEFT JOIN tenants t ON t.id = d.tenant_id
     WHERE COALESCE(s.status,'') <> 'revoked'
       AND (s.last_error IS NOT NULL OR ${overdue})
     ORDER BY s.expires_at ASC NULLS LAST
     LIMIT ${DASHBOARD_SUBJECT_LIMIT}
  `);
  return {
    issued: Number(x.issued ?? 0), wildcards: Number(x.wildcards ?? 0),
    nearestExpiryDays: x.nearest_days == null ? null : Number(x.nearest_days),
    failing: Number(x.failing ?? 0),
    overdue: Number(x.overdue ?? 0),
    needsAttention: Number(x.attention ?? 0),
    attention: (attention.rows ?? []).map((c) => ({
      name: c.name,
      detail: [
        c.overdue ? `renewal overdue · ${c.days == null ? 'no expiry' : daysLeft(Number(c.days))}` : null,
        c.last_error ? `renewal failing: ${c.last_error.slice(0, 80)}` : null,
        c.tenant,
      ].filter(Boolean).join(' · '),
    })),
  };
}

export async function buildUpdatesTile(db: Database): Promise<Data<'updates'>> {
  // These figures were constants — "Current", 0 apps behind, 0 end-of-life —
  // so the tile could never warn. Each is now read from what already decides
  // it: the verified release the Updates page offers, the upgrade graph the
  // Upgrades page draws, and the catalog's end-of-life dates.
  const settings = await db.execute<{ key: string; value: string }>(sql`
    SELECT setting_key AS key, setting_value AS value FROM platform_settings
     WHERE setting_key IN ('installed_platform_version', 'available_version')
  `);
  const setting = (k: string): string | null =>
    (settings.rows ?? []).find((s) => s.key === k)?.value || null;
  const installed = setting('installed_platform_version');
  const available = setting('available_version');

  const auto = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM deployments WHERE auto_upgrade = TRUE AND deleted_at IS NULL
  `);

  const groups = await upgradeOverview(db);
  const behindAll = groups.flatMap((g) => g.deployments
    .filter((d) => d.availableUpgradeCount > 0 && d.latestReachable)
    .map((d) => ({
      name: `${d.tenantCompanyName ?? 'tenant'} · ${d.name}`,
      detail: `${g.name} ${d.installedVersion ?? '?'} → ${d.latestReachable}`,
    })));

  const eol = await db.execute<{ total: number; name: string; tenant: string; app: string; version: string; eol_date: string }>(sql`
    SELECT COUNT(*) OVER ()::int AS total, dep.name, t.name AS tenant, e.name AS app,
           v.version, v.eol_date
      FROM deployments dep
      JOIN tenants t ON t.id = dep.tenant_id
      JOIN catalog_entries e ON e.id = dep.catalog_entry_id
      JOIN catalog_entry_versions v
        ON v.catalog_entry_id = dep.catalog_entry_id AND v.version = dep.installed_version
     WHERE dep.deleted_at IS NULL
       AND v.eol_date IS NOT NULL
       -- eol_date is stored as text, YYYY-MM-DD, which sorts as a date.
       AND v.eol_date <= to_char(CURRENT_DATE, 'YYYY-MM-DD')
     ORDER BY v.eol_date ASC
     LIMIT ${DASHBOARD_SUBJECT_LIMIT}
  `);
  const eolRows = eol.rows ?? [];
  return {
    platformCurrent: !(installed && available && isNewer(available, installed)),
    platformInstalled: installed,
    platformAvailable: available,
    deploymentsBehind: behindAll.length,
    behind: behindAll.slice(0, DASHBOARD_SUBJECT_LIMIT),
    autoUpgradeEnabled: Number((auto.rows ?? [])[0]?.n ?? 0),
    eolRuntimes: Number(eolRows[0]?.total ?? 0),
    eol: eolRows.map((r) => ({
      name: `${r.tenant} · ${r.name}`,
      detail: `${r.app} ${r.version} · end of life ${r.eol_date}`,
    })),
  };
}

/**
 * The upgrade graph, at most every five minutes. It is one query per catalog
 * entry, and the summary it feeds is the console's fast, every-30-seconds
 * endpoint; which apps can be upgraded changes when the catalog syncs, not
 * by the second.
 */
const OVERVIEW_TTL_MS = 5 * 60_000;
let overviewCache: { at: number; value: Awaited<ReturnType<typeof getAdminUpgradesOverview>> } | null = null;
async function upgradeOverview(db: Database, now = Date.now()): Promise<Awaited<ReturnType<typeof getAdminUpgradesOverview>>> {
  if (overviewCache && now - overviewCache.at < OVERVIEW_TTL_MS) return overviewCache.value;
  const value = await getAdminUpgradesOverview(db);
  overviewCache = { at: now, value };
  return value;
}

/** Test seam: forget the cached upgrade graph. */
export function resetUpgradeOverviewCache(): void { overviewCache = null; }

export async function buildScheduledTasksTile(db: Database): Promise<Data<'scheduledTasks'>> {
  const r = await db.execute<Record<string, number>>(sql`
    SELECT COUNT(*)::int AS total,
           SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END)::int AS enabled,
           SUM(CASE WHEN "lastRunStatus" = 'failed'
                     AND last_run_at > NOW() - INTERVAL '24 hours'
                    THEN 1 ELSE 0 END)::int AS failed24h,
           SUM(CASE WHEN enabled = 1 AND last_run_at IS NULL THEN 1 ELSE 0 END)::int AS never_run
      FROM cron_jobs
  `);
  const x = (r.rows ?? [])[0] ?? {};
  const failed = await db.execute<{ name: string; tenant: string | null; minutes: number; code: number | null }>(sql`
    SELECT j.name, t.name AS tenant, j.last_run_response_code AS code,
           FLOOR(EXTRACT(EPOCH FROM (now() - j.last_run_at)) / 60)::int AS minutes
      FROM cron_jobs j
      LEFT JOIN tenants t ON t.id = j.tenant_id
     WHERE j."lastRunStatus" = 'failed' AND j.last_run_at > NOW() - INTERVAL '24 hours'
     ORDER BY j.last_run_at DESC
     LIMIT ${DASHBOARD_SUBJECT_LIMIT}
  `);
  const neverRun = await db.execute<{ name: string; tenant: string | null; schedule: string }>(sql`
    SELECT j.name, t.name AS tenant, j.schedule
      FROM cron_jobs j
      LEFT JOIN tenants t ON t.id = j.tenant_id
     WHERE j.enabled = 1 AND j.last_run_at IS NULL
     ORDER BY j.created_at ASC
     LIMIT ${DASHBOARD_SUBJECT_LIMIT}
  `);
  const job = (name: string, tenant: string | null): string => (tenant ? `${tenant} · ${name}` : name);
  return {
    total: Number(x.total ?? 0), enabled: Number(x.enabled ?? 0),
    failed24h: Number(x.failed24h ?? 0),
    failed: (failed.rows ?? []).map((j): DashboardSubject => ({
      name: job(j.name, j.tenant),
      detail: `failed ${forHowLong(Number(j.minutes ?? 0))} ago` + (j.code != null ? ` · HTTP ${j.code}` : ''),
    })),
    neverRun: Number(x.never_run ?? 0),
    // Deprecated, for the previous admin panel build during an upgrade only.
    overdue: 0,
    neverRunJobs: (neverRun.rows ?? []).map((j) => ({ name: job(j.name, j.tenant), detail: `schedule ${j.schedule}` })),
  };
}

/** The mailboxes at or over quota, fullest first — for the Mail tile's red figure. */
export async function listOverQuotaMailboxes(db: Database): Promise<DashboardSubject[]> {
  const r = await db.execute<{ address: string; used_mb: number; quota_mb: number }>(sql`
    SELECT full_address AS address, used_mb::float8, quota_mb::float8
      FROM mailboxes
     WHERE status = 'active' AND quota_mb > 0 AND platform_managed = FALSE
       AND (used_mb::numeric / quota_mb) >= 1
     ORDER BY (used_mb::numeric / quota_mb) DESC
     LIMIT ${DASHBOARD_SUBJECT_LIMIT}
  `);
  return (r.rows ?? []).map((m) => ({
    name: m.address,
    detail: `${Math.round(Number(m.used_mb))} / ${Math.round(Number(m.quota_mb))} MB`,
  }));
}

/**
 * The outbound queue, as the Mail tile reports it. It was the constant
 * "0, reachable", so a stuck queue or a mail server that stopped answering
 * never showed. One count call, the same probe the mail-health collector uses;
 * a slow or failed answer reads as unreachable rather than as an empty queue.
 */
// A mail server that did not answer is not asked again for a minute: every
// slow poll would otherwise wait out the full timeout while it is down.
const QUEUE_FAILURE_HOLD_MS = 60_000;
let queueFailedAt = 0;

/** Test seam: forget a remembered queue failure. */
export function resetMailQueueFailure(): void { queueFailedAt = 0; }

export async function readMailQueue(
  count: (p: { cap: number }) => Promise<number> = queuedMessageCount,
  timeoutMs = 3_000,
  now = Date.now(),
): Promise<{ depth: number; reachable: boolean }> {
  if (now - queueFailedAt < QUEUE_FAILURE_HOLD_MS) return { depth: 0, reachable: false };
  let timer: NodeJS.Timeout | undefined;
  try {
    const depth = await Promise.race([
      count({ cap: 2000 }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
    ]);
    queueFailedAt = 0;
    return { depth, reachable: true };
  } catch {
    queueFailedAt = now;
    return { depth: 0, reachable: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
