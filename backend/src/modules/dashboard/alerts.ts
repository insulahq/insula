import { sql } from 'drizzle-orm';
import type { DashboardAlert } from '@insula/api-contracts';
import { ALL_CATEGORIES } from '../notifications/categories/seed.js';
// The grace window and the heal gate are OWNED by the reconciler. Importing them
// keeps the two consoles from drifting away from the state machine that writes
// the rows they render — the whole point of both panels reading one table.
import { GRACE_INTERVAL_SQL, isHealable, type HealReason } from '../storage-lifecycle/workload-health.js';
import type { Database } from '../../db/index.js';

/**
 * The alert band, derived from notification categories.
 *
 * The rule this file exists to enforce: a dashboard alert tile may only exist
 * where a notification category exists to raise it. An earlier draft grew a
 * "low free memory" warning and a "mailbox count near plan limit" warning —
 * both reasonable-sounding, neither backed by any category, so no code path
 * could ever have raised them. They would have been decoration that looked
 * like monitoring.
 *
 * `assertKnownCategory` is the guard. Everything below goes through it.
 */

const KNOWN = new Set(ALL_CATEGORIES.map((c) => c.id));

/** Categories that are actionable — the only classes that justify a tile. */
const ACTIONABLE_CLASSES = new Set(['incident', 'action', 'availability', 'security']);
const ACTIONABLE = new Set(
  ALL_CATEGORIES.filter((c) => ACTIONABLE_CLASSES.has(c.cls)).map((c) => c.id),
);

export function assertKnownCategory(categoryId: string): void {
  if (!KNOWN.has(categoryId)) {
    throw new Error(
      `dashboard alert references unknown notification category "${categoryId}". `
      + 'An alert tile with no category is a tile nothing can raise.',
    );
  }
  if (!ACTIONABLE.has(categoryId)) {
    throw new Error(
      `dashboard alert references non-actionable category "${categoryId}". `
      + 'Record/ambient categories are history, not something to act on.',
    );
  }
}

export function alert(a: DashboardAlert): DashboardAlert {
  assertKnownCategory(a.categoryId);
  return a;
}

/** critical first, then by headline value descending — worst thing on the left. */
export function rankAlerts(alerts: readonly DashboardAlert[]): DashboardAlert[] {
  const num = (v: string): number => Number(v.replace(/[^0-9.]/g, '')) || 0;
  return [...alerts].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
    return num(b.value) - num(a.value);
  });
}

// ─────────────────────────────────────────────────────────────────────
// admin
// ─────────────────────────────────────────────────────────────────────

interface MailboxRow extends Record<string, unknown> {
  full_address: string; pct: number; used_mb: number; quota_mb: number; total?: number;
}

export async function buildAdminAlerts(db: Database): Promise<DashboardAlert[]> {
  const out: DashboardAlert[] = [];

  // Certificates — admin.cert_expiring.
  // Table and columns verified against the live schema: `ssl_certificates`
  // holds expires_at/status; there is no certificate_health table.
  const certs = await db.execute<{
    n: number; soonest: number | null; name: string | null;
    domain_id: string | null; tenant_id: string | null;
  }>(sql`
    SELECT COUNT(*)::int AS n,
           MIN(EXTRACT(DAY FROM (c.expires_at - NOW())))::int AS soonest,
           MIN(d.domain_name) AS name,
           -- Only meaningful when exactly one certificate is expiring; the
           -- alert checks that before using them to build a deep link.
           MIN(d.id) AS domain_id,
           MIN(d.tenant_id) AS tenant_id
      FROM ssl_certificates c
      LEFT JOIN domains d ON d.id = c.domain_id
     WHERE c.expires_at IS NOT NULL
       AND c.expires_at < NOW() + INTERVAL '14 days'
       AND COALESCE(c.status, '') <> 'revoked'
  `);
  const cert = (certs.rows ?? [])[0];
  if (cert && Number(cert.n) > 0) {
    const soonest = cert.soonest ?? 0;
    out.push(alert({
      categoryId: 'admin.cert_expiring',
      severity: soonest <= 3 ? 'critical' : 'warning',
      value: String(cert.n),
      title: Number(cert.n) === 1 ? 'Certificate expiring' : 'Certificates expiring',
      subtitle: `${cert.name ?? 'a domain'} · soonest in ${soonest} days`,
      // When the alert names ONE certificate, go to that domain rather than
      // making the operator find it in a list. Several expiring is a list
      // problem, so the list is the right answer then.
      href: Number(cert.n) === 1 && cert.tenant_id && cert.domain_id
        ? `/tenants/${cert.tenant_id}/domains/${cert.domain_id}`
        : '/domains',
      detail: [['Expiring within 14 days', String(cert.n)],
               ['Soonest', `${soonest} days`]],
      note: 'A certificate that fails to renew keeps serving until it expires — this is the last warning.',
    }));
  }

  // Tenant workloads down and auto-heal failed — admin.tenant_workloads_down.
  //
  // Reads the SAME episode table the reconciler writes and the tenant panel
  // renders, so the two consoles cannot disagree about whether a tenant is up.
  // Gated on the grace window AND on auto-heal having been attempted: a tile
  // that lights up during a 20-second rollout is a tile operators learn to
  // ignore.
  const downWork = await db.execute<{
    total: number; tenant_id: string; tenant_name: string; workload: string;
    reason: string; down_minutes: number; heal_attempts: number; healed: number;
    heal_failed: number;
  }>(sql`
    SELECT COUNT(*) OVER ()::int AS total,
           e.tenant_id, t.name AS tenant_name, e.workload, e.reason,
           FLOOR(EXTRACT(EPOCH FROM (now() - e.first_seen_at)) / 60)::int AS down_minutes,
           e.heal_attempts,
           (e.healed_at IS NOT NULL)::int AS healed,
           -- heal_attempts is incremented when an attempt is CLAIMED, so it
           -- counts in-flight attempts too. Only a failure writes
           -- last_heal_error, so that is the field that can honestly say
           -- "tried and failed" -- decide and caption from the same field.
           (e.last_heal_error IS NOT NULL)::int AS heal_failed
      FROM tenant_workload_health_events e
      JOIN tenants t ON t.id = e.tenant_id
     WHERE e.cleared_at IS NULL
       AND t.status = 'active'
       -- An operator running their own resize / restore / fsck quiesces the
       -- namespace on purpose. The reconciler stops refreshing the episode for
       -- the duration, so without this the operator watches a stale
       -- "auto-heal failed" tile age through their whole maintenance window.
       AND t.active_storage_op_id IS NULL
       AND e.first_seen_at < now() - ${GRACE_INTERVAL_SQL}::interval
     ORDER BY e.first_seen_at ASC
     LIMIT 5
  `);
  const downRows = downWork.rows ?? [];
  if (downRows.length > 0) {
    const w = downRows[0];
    const downTotal = Number(w.total ?? downRows.length);
    const triedAndFailed = downRows.filter(
      (r) => Number(r.heal_failed) === 1 && Number(r.heal_attempts) > 0,
    ).length;
    const healing = downRows.filter((r) => Number(r.heal_failed) === 0 && Number(r.heal_attempts) > 0).length;
    const notHealable = downRows.filter((r) => !isHealable(r.reason as HealReason)).length;
    out.push(alert({
      categoryId: 'admin.tenant_workloads_down',
      severity: 'critical',
      value: String(downTotal),
      title: downTotal === 1 ? 'Tenant workload down' : 'Tenant workloads down',
      subtitle: `${w.tenant_name} · ${w.workload} · ${w.down_minutes} min`
        + (downTotal > 1 ? ` · ${downTotal - 1} more` : ''),
      // One subject → deep-link to that tenant. Several is a list problem.
      href: downTotal === 1 ? `/tenants/${w.tenant_id}` : '/tenants',
      detail: downRows.map((r) => [
        `${r.tenant_name} / ${r.workload}`,
        `${r.down_minutes} min · ${r.reason}`
        // Require BOTH a recorded failure and a counted attempt before saying
        // "failed" — the two columns describe the same episode and a caption
        // that trusts only one of them can render "0 heal attempt(s) failed".
        + (Number(r.heal_failed) === 1 && Number(r.heal_attempts) > 0
          ? ` · ${r.heal_attempts} heal attempt(s) failed`
          : Number(r.heal_attempts) > 0 ? ` · heal attempt ${r.heal_attempts} in progress` : ' · heal pending'),
      ] as [string, string]),
      // `notHealable` rows will NEVER be auto-healed — a bad image, a
      // crash-loop and an unschedulable pod all come back identical, so the
      // reconciler deliberately does not try. Promising recovery that is never
      // coming is worse than saying nothing.
      note: notHealable === downRows.length
        ? 'Automatic recovery cannot fix these causes — they need a human. The tenant is down right now.'
        : triedAndFailed > 0
          ? 'Automatic recovery has already been tried and failed on '
            + `${triedAndFailed} of these — they need a human. The tenant's site is down right now.`
          : healing > 0
            ? 'Automatic recovery is running right now. If these clear on their own, no action is needed.'
            : notHealable > 0
              ? `${notHealable} of these cannot be auto-healed and need a human; the rest start once the outage outlives the grace window.`
              : 'Automatic recovery has not started yet — it begins once the outage outlives the grace window.',
    }));
  }

  // Mailboxes at or above quota — admin.mailbox_quota_fleet.
  // Per-mailbox storage, which is the number that actually refuses mail;
  // the COUNT of mailboxes against a plan limit is not an alert and has no
  // category, so it deliberately does not appear here.
  const boxes = await db.execute<MailboxRow>(sql`
    SELECT COUNT(*) OVER ()::int AS total, m.full_address,
           ROUND((m.used_mb::numeric / NULLIF(m.quota_mb,0)) * 100)::int AS pct,
           m.used_mb::float8, m.quota_mb::float8
      FROM mailboxes m
     WHERE m.status = 'active' AND m.quota_mb > 0
       AND m.platform_managed = FALSE
       AND (m.used_mb::numeric / m.quota_mb) >= 0.90
     ORDER BY (m.used_mb::numeric / m.quota_mb) DESC
     LIMIT 5
  `);
  const boxRows = boxes.rows ?? [];
  if (boxRows.length > 0) {
    const boxTotal = Number(boxRows[0].total ?? boxRows.length);
    const full = boxRows.filter((b) => b.pct >= 100).length;
    out.push(alert({
      categoryId: 'admin.mailbox_quota_fleet',
      severity: full > 0 ? 'critical' : 'warning',
      value: String(boxTotal),
      title: full > 0 ? 'Mailboxes over quota' : 'Mailboxes nearly full',
      subtitle: `${boxRows[0].full_address} · ${boxRows[0].pct}%`
        + (boxTotal > 1 ? ` · ${boxTotal - 1} more` : ''),
      // /email/operations is queue and delivery tooling — it says nothing
      // about a mailbox's quota. The accounts page is where the mailbox and
      // its quota can actually be seen and raised.
      href: '/tenants/email-accounts',
      detail: boxRows.map((b) => [b.full_address, `${b.used_mb} / ${b.quota_mb} MB · ${b.pct}%`] as [string, string]),
      note: 'At 100% inbound mail is rejected at RCPT TO — the sender gets a bounce.',
    }));
  }

  // Tenants at a resource limit — admin.tenant_resource_saturation_*
  const sat = await db.execute<{
    tenant: string; tenant_id: string; resource: string; level: string; used_pct: number;
  }>(sql`
    SELECT t.name AS tenant, t.id AS tenant_id, e.resource, e.level, e.used_pct
      FROM tenant_saturation_events e
      JOIN tenants t ON t.id = e.tenant_id
     WHERE e.cleared_at IS NULL
     ORDER BY e.used_pct DESC
     LIMIT 5
  `);
  const satRows = sat.rows ?? [];
  if (satRows.length > 0) {
    const worst = satRows[0];
    const critical = satRows.some((r) => r.level === 'critical');
    out.push(alert({
      categoryId: critical
        ? 'admin.tenant_resource_saturation_critical'
        : 'admin.tenant_resource_saturation_warning',
      severity: critical ? 'critical' : 'warning',
      value: `${worst.used_pct}%`,
      title: satRows.length === 1 ? 'Tenant at a resource limit' : 'Tenants at a resource limit',
      subtitle: `${worst.tenant} · ${worst.resource} ${worst.used_pct}%`,
      // The subtitle names a tenant; the link used to drop the operator on a
      // list of every tenant to find it again. One affected tenant goes
      // straight there.
      href: new Set(satRows.map((r) => r.tenant_id)).size === 1 && worst.tenant_id
        ? `/tenants/${worst.tenant_id}`
        : '/tenants',
      detail: satRows.map((r) => [`${r.tenant} · ${r.resource}`, `${r.used_pct}% · ${r.level}`] as [string, string]),
      note: 'Reminders widen to 1h, then 6h, then daily while it persists.',
    }));
  }

  // Firing SLO rules — admin.slo_alert_*. Table is `alert_state`.
  const slo = await db.execute<{ severity: string; n: number; subject: string | null }>(sql`
    SELECT severity, COUNT(*)::int AS n, MIN(subject_key) AS subject
      FROM alert_state
     WHERE state = 'firing'
     GROUP BY severity
  `);
  for (const row of slo.rows ?? []) {
    const critical = row.severity === 'critical';
    out.push(alert({
      categoryId: critical ? 'admin.slo_alert_critical' : 'admin.slo_alert_warning',
      severity: critical ? 'critical' : 'warning',
      value: String(row.n),
      title: critical ? 'Monitoring rules firing' : 'Monitoring warnings',
      subtitle: row.subject && row.subject.length > 0 ? row.subject : 'see Monitoring → SLOs',
      href: '/monitoring/slo',
      detail: [['Firing', String(row.n)], ['Severity', row.severity]],
      note: null,
    }));
  }

  return rankAlerts(out);
}

// ─────────────────────────────────────────────────────────────────────
// tenant
// ─────────────────────────────────────────────────────────────────────

export async function buildTenantAlerts(
  db: Database,
  tenantId: string,
): Promise<DashboardAlert[]> {
  const out: DashboardAlert[] = [];

  // Resource at its limit — tenant.resource_saturation_*.
  // Reads the SAME episode table the operator sees, so the two panels cannot
  // disagree about whether a tenant is in trouble.
  const sat = await db.execute<{ resource: string; level: string; used_pct: number }>(sql`
    SELECT resource, level, used_pct FROM tenant_saturation_events
     WHERE tenant_id = ${tenantId} AND cleared_at IS NULL
     ORDER BY used_pct DESC
  `);
  for (const r of sat.rows ?? []) {
    const critical = r.level === 'critical';
    out.push(alert({
      categoryId: critical ? 'tenant.resource_saturation_critical' : 'tenant.resource_saturation_warning',
      severity: critical ? 'critical' : 'warning',
      value: `${r.used_pct}%`,
      title: critical ? `${cap(r.resource)} limit reached` : `${cap(r.resource)} filling up`,
      subtitle: `${r.used_pct}% of your plan's ${r.resource}`,
      href: '/resource-usage',
      detail: [['Resource', r.resource], ['Used', `${r.used_pct}%`]],
      note: r.resource === 'storage'
        ? 'Writes are refused at 95%. Clearing old uploads or logs is usually the quickest win.'
        : 'A new app must fit in what is left, not in what is currently idle.',
    }));
  }

  // An application of theirs is not running — tenant.workloads_down.
  //
  // Same episode table as the admin tile. The tenant gets the honest answer to
  // "why is my site down" the moment they look, plus the fact that the operator
  // already knows — which is the difference between a support ticket and none.
  const downWork = await db.execute<{
    total: number; workload: string; down_minutes: number; reason: string;
    heal_attempts: number; heal_failed: number;
  }>(sql`
    SELECT
           -- COUNT(*) OVER () BEFORE the LIMIT clips the rows. Deriving the
           -- badge from downRows.length would report "3" for a tenant with six
           -- workloads down, which reads as partial data loss rather than a
           -- page size.
           COUNT(*) OVER ()::int AS total,
           e.workload,
           FLOOR(EXTRACT(EPOCH FROM (now() - e.first_seen_at)) / 60)::int AS down_minutes,
           e.reason, e.heal_attempts,
           -- See the admin card: heal_attempts counts CLAIMED attempts, so only
           -- last_heal_error can say an attempt actually failed.
           (e.last_heal_error IS NOT NULL)::int AS heal_failed
      FROM tenant_workload_health_events e
      JOIN tenants t ON t.id = e.tenant_id
     WHERE e.tenant_id = ${tenantId}
       AND e.cleared_at IS NULL
       AND t.active_storage_op_id IS NULL
       AND e.first_seen_at < now() - ${GRACE_INTERVAL_SQL}::interval
     ORDER BY e.first_seen_at ASC
     LIMIT 3
  `);
  const downRows = downWork.rows ?? [];
  if (downRows.length > 0) {
    const d = downRows[0];
    const downTotal = Number(d.total ?? downRows.length);
    out.push(alert({
      categoryId: 'tenant.workloads_down',
      severity: 'critical',
      value: String(downTotal),
      title: downTotal === 1 ? 'An application is not running' : 'Applications are not running',
      subtitle: `${d.workload} · down ${d.down_minutes} min`,
      href: '/applications',
      detail: downRows.map((r) => [r.workload, `down ${r.down_minutes} min`] as [string, string]),
      // Deliberately says nothing about quotas, nodes or volumes: the causes are
      // the operator's to act on, and a tenant reading "ResourceQuota refused to
      // admit the pod" learns only that something is wrong in a language they
      // cannot use.
      note: !isHealable(d.reason as HealReason)
        // Still no jargon: the tenant does not need to know it was a quota, an
        // image or a node — only that waiting will not fix it and that somebody
        // who can fix it already knows.
        ? 'This needs one of our operators, who have already been alerted — you do not need to report it.'
        : Number(d.heal_failed) === 1 && Number(d.heal_attempts) > 0
          ? 'Automatic restart did not succeed and our operators have been alerted — you do not need to report this.'
          : 'The platform is trying to restart it automatically.',
    }));
  }

  // A mailbox nearly full — mailbox.quota_threshold / quota_exceeded.
  // Per-mailbox STORAGE. The number of mailboxes against the plan is not an
  // alert: there is no category for it, and running a plan to its limit is
  // not a fault.
  const box = await db.execute<{ full_address: string; pct: number; used_mb: number; quota_mb: number }>(sql`
    SELECT full_address,
           ROUND((used_mb::numeric / NULLIF(quota_mb,0)) * 100)::int AS pct,
           used_mb::float8, quota_mb::float8
      FROM mailboxes
     WHERE tenant_id = ${tenantId} AND status = 'active' AND quota_mb > 0
       AND platform_managed = FALSE
       AND (used_mb::numeric / quota_mb) >= 0.90
     ORDER BY (used_mb::numeric / quota_mb) DESC
     LIMIT 3
  `);
  const boxRows = box.rows ?? [];
  if (boxRows.length > 0) {
    const b = boxRows[0];
    const exceeded = b.pct >= 100;
    out.push(alert({
      categoryId: exceeded ? 'mailbox.quota_exceeded' : 'mailbox.quota_threshold',
      severity: exceeded ? 'critical' : 'warning',
      value: `${b.pct}%`,
      title: exceeded ? 'A mailbox is full' : 'A mailbox is nearly full',
      subtitle: `${b.full_address} · ${fmtGb(b.used_mb)} of ${fmtGb(b.quota_mb)}`,
      href: '/email',
      detail: boxRows.map((r) => [r.full_address, `${fmtGb(r.used_mb)} / ${fmtGb(r.quota_mb)} · ${r.pct}%`] as [string, string]),
      note: exceeded
        ? 'New mail to this address is being refused. Archive or delete, or raise the quota.'
        : 'At 100% new mail to this address is refused.',
    }));
  }

  // Bandwidth — tenant.bandwidth_warning / bandwidth_exceeded.
  // Usage columns live on `tenants` (bandwidth_gb_used / bandwidth_capped);
  // the allowance is the tenant override or the plan's bandwidth_gb_limit.
  const bw = await db.execute<{ used_gb: number; limit_gb: number; capped: boolean }>(sql`
    SELECT COALESCE(t.bandwidth_gb_used, 0)::float8 AS used_gb,
           COALESCE(NULLIF(t.bandwidth_limit_override, 0), p.bandwidth_gb_limit, 0)::float8 AS limit_gb,
           COALESCE(t.bandwidth_capped, FALSE) AS capped
      FROM tenants t
      LEFT JOIN hosting_plans p ON p.id = t.plan_id
     WHERE t.id = ${tenantId}
     LIMIT 1
  `);
  const bwRow = (bw.rows ?? [])[0];
  if (bwRow && Number(bwRow.limit_gb) > 0) {
    const pct = Math.round((Number(bwRow.used_gb) / Number(bwRow.limit_gb)) * 100);
    if (pct >= 80) {
      out.push(alert({
        categoryId: pct >= 100 ? 'tenant.bandwidth_exceeded' : 'tenant.bandwidth_warning',
        severity: pct >= 100 ? 'critical' : 'warning',
        value: `${pct}%`,
        title: pct >= 100 ? 'Bandwidth limit reached' : 'Bandwidth running high',
        subtitle: `${Number(bwRow.used_gb).toFixed(1)} of ${bwRow.limit_gb} GB this cycle`,
        href: '/resource-usage',
        detail: [['Used', `${Number(bwRow.used_gb).toFixed(2)} GB`],
                 ['Allowance', `${bwRow.limit_gb} GB`],
                 ['Capped', bwRow.capped ? 'yes' : 'no']],
        note: 'Counted on traffic leaving your sites. Restores and backups are not counted.',
      }));
    }
  }

  // Scheduled task failing — tasks.scheduled_failure.
  // `lastRunStatus` is stored camelCase and MUST stay quoted; unquoted it
  // folds to lastrunstatus and the query errors rather than returning rows.
  const cron = await db.execute<{ name: string; total: number }>(sql`
    SELECT name, COUNT(*) OVER ()::int AS total FROM cron_jobs
     WHERE tenant_id = ${tenantId} AND enabled = 1 AND "lastRunStatus" = 'failed'
     LIMIT 5
  `);
  const cronRows = cron.rows ?? [];
  if (cronRows.length > 0) {
    const cronTotal = Number(cronRows[0].total);
    out.push(alert({
      categoryId: 'tasks.scheduled_failure',
      severity: 'warning',
      value: String(cronTotal),
      title: cronTotal === 1 ? 'Scheduled task failing' : 'Scheduled tasks failing',
      subtitle: cronRows.map((c) => c.name).join(', ').slice(0, 90),
      href: '/cron-jobs',
      detail: cronRows.map((c) => [c.name, 'last run failed'] as [string, string]),
      note: 'A job that keeps failing will not retry on its own — open it to see the output.',
    }));
  }

  // Domain not verified — tenant.domain_verification.
  //
  // This matched on `status <> 'active'` and so fired for EVERY domain a
  // tenant owned, verified ones included: `active` is a declared label on the
  // domain_status enum that nothing ever sets. The terminal state a verified
  // domain actually reaches is `verified`.
  //
  // Named positively — the states that genuinely mean "not verified yet" —
  // rather than as "anything but X". A new terminal label would silently
  // re-create the false alarm under the old form; under this one it simply
  // does not alert, which is the safer way to be wrong.
  //
  // `status` is the enum `domain_status`. Comparing it to '' asks Postgres to
  // cast an empty string into the enum, which errors rather than returning
  // nothing — so compare as text.
  // COUNT is taken over the whole set; the rows are a capped SAMPLE for the
  // hover card. Reporting rows.length after a LIMIT made the chip read "5"
  // next to a tile saying 0 of 6 verified — the page size posing as the total.
  const dom = await db.execute<{ domain_name: string; total: number }>(sql`
    SELECT domain_name, COUNT(*) OVER ()::int AS total FROM domains
     WHERE tenant_id = ${tenantId} AND status::text IN ('unverified', 'pending')
     LIMIT 5
  `);
  const domRows = dom.rows ?? [];
  if (domRows.length > 0) {
    const domTotal = Number(domRows[0].total);
    out.push(alert({
      categoryId: 'tenant.domain_verification',
      severity: 'warning',
      value: String(domTotal),
      title: domTotal === 1 ? 'Domain not verified' : 'Domains not verified',
      subtitle: domRows.map((d) => d.domain_name).join(', ').slice(0, 90)
        + (domTotal > domRows.length ? ` · ${domTotal - domRows.length} more` : ''),
      href: '/domains',
      detail: domRows.map((d) => [d.domain_name, 'awaiting DNS'] as [string, string]),
      note: 'Mail and certificates for the domain cannot be set up until it verifies.',
    }));
  }

  return rankAlerts(out);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function fmtGb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
