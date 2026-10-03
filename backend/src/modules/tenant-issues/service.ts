/**
 * Tenant issues — open, self-clearing conditions, derived not stored.
 *
 * An "issue" is the same threshold state a notification fires from, read back
 * as a current fact. Deriving rather than storing is the point: a banner and a
 * notification that share a source cannot disagree, and an issue disappears on
 * its own the moment the condition does — nobody has to remember to clear it.
 *
 * This replaces the instinct to build one admin page per subsystem. Tenant
 * state belongs on the surfaces that already carry tenants: a count in the
 * tenants-table status column, and a banner on tenant detail listing each
 * issue with its object, its value and its age.
 *
 * Cost: one query per source over the WHOLE fleet, not per tenant. The list
 * view asks once and indexes by tenant.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';

export type IssueSeverity = 'warning' | 'critical';

export interface TenantIssue {
  readonly tenantId: string;
  readonly kind: string;
  readonly severity: IssueSeverity;
  /** The thing that is wrong — a mailbox address, a resource name. */
  readonly objectLabel: string;
  /** One line a human can act on. */
  readonly detail: string;
  /**
   * Where this gets fixed, in the ADMIN panel — issues render on the admin
   * tenants list and tenant page, so the target is the tenant's own page/tab.
   */
  readonly actionPath: string;
  /** When the condition was first observed, ISO. Null when not tracked. */
  readonly since: string | null;
}

interface MailboxQuotaRow extends Record<string, unknown> {
  tenant_id: string;
  full_address: string;
  threshold: number;
  used_mb: number;
  quota_mb: number;
  first_seen_at: string | null;
}

interface TenantRow extends Record<string, unknown> {
  id: string;
  name: string;
  subscription_expires_at: string | null;
  bandwidth_capped: boolean | null;
}

/**
 * Mailbox quota: one issue per mailbox at its HIGHEST open threshold.
 *
 * A mailbox at 100% has open rows for 80, 90, 99 and 100 — showing four issues
 * for one mailbox would make the count meaningless, which is how an issue
 * badge becomes noise and then gets ignored.
 */
async function mailboxQuotaIssues(db: Database): Promise<TenantIssue[]> {
  const res = await db.execute<MailboxQuotaRow>(sql`
    SELECT DISTINCT ON (e.mailbox_id)
           m.tenant_id     AS tenant_id,
           m.full_address  AS full_address,
           e.threshold     AS threshold,
           m.used_mb       AS used_mb,
           m.quota_mb      AS quota_mb,
           e.first_seen_at AS first_seen_at
      FROM mailbox_quota_events e
      JOIN mailboxes m ON m.id = e.mailbox_id
     WHERE e.cleared_at IS NULL
       AND m.status = 'active'
     ORDER BY e.mailbox_id, e.threshold DESC
  `);
  return (res.rows ?? []).map((r) => ({
    tenantId: r.tenant_id,
    kind: 'mailbox_quota',
    severity: r.threshold >= 100 ? 'critical' : 'warning',
    objectLabel: r.full_address,
    detail: r.threshold >= 100
      ? `Mailbox full (${r.used_mb}/${r.quota_mb} MB) — new mail is being rejected`
      : `Mailbox ${r.threshold}% full (${r.used_mb}/${r.quota_mb} MB)`,
    actionPath: `/tenants/${r.tenant_id}/email`,
    since: r.first_seen_at,
  }));
}

/** Subscription expiry and bandwidth cap, both readable straight off the tenant row. */
async function tenantRowIssues(db: Database, horizonDays: number): Promise<TenantIssue[]> {
  const res = await db.execute<TenantRow>(sql`
    SELECT id, name, subscription_expires_at, bandwidth_capped
      FROM tenants
     WHERE status = 'active'
       AND is_system = FALSE
       AND (
         bandwidth_capped = TRUE
         OR (subscription_expires_at IS NOT NULL
             AND subscription_expires_at <= NOW() + (${horizonDays} * INTERVAL '1 day'))
       )
  `);
  const out: TenantIssue[] = [];
  for (const r of res.rows ?? []) {
    if (r.subscription_expires_at) {
      const expiry = new Date(r.subscription_expires_at);
      const days = Math.ceil((expiry.getTime() - Date.now()) / 86_400_000);
      out.push({
        tenantId: r.id,
        kind: 'subscription_expiring',
        severity: days <= 7 ? 'critical' : 'warning',
        objectLabel: r.name,
        detail: days <= 0
          ? `Subscription expired on ${expiry.toISOString().slice(0, 10)}`
          : `Subscription expires in ${days} day(s), on ${expiry.toISOString().slice(0, 10)}`,
        actionPath: `/tenants/${r.id}`,
        since: null,
      });
    }
    if (r.bandwidth_capped) {
      out.push({
        tenantId: r.id,
        kind: 'bandwidth_capped',
        severity: 'critical',
        objectLabel: r.name,
        detail: 'Monthly bandwidth cap reached — traffic is being refused',
        actionPath: `/tenants/${r.id}`,
        since: null,
      });
    }
  }
  return out;
}

interface PlacementRow extends Record<string, unknown> {
  tenant_id: string;
  name: string;
  primary_node: string | null;
  actual_nodes: string[] | null;
  reasons: string[] | null;
  misplaced_since: string | Date | null;
}

/**
 * Tenants running or keeping data away from their primary node, as last
 * observed by the placement reconciler (migration 0141). Admin-only, like
 * every issue here — a tenant has no say over which node it is on.
 *
 * Warning, not critical: the tenant is serving. The tenants-table placement
 * column turns red on its own; this puts the same fact in the status column
 * and on the detail page's banner, with how long it has been true.
 */
async function placementIssues(db: Database): Promise<TenantIssue[]> {
  const res = await db.execute<PlacementRow>(sql`
    SELECT p.tenant_id, t.name, p.primary_node, p.actual_nodes, p.reasons, p.misplaced_since
      FROM tenant_placement_state p
      JOIN tenants t ON t.id = p.tenant_id
     WHERE p.status = 'misplaced'
  `);
  return (res.rows ?? []).map((r) => {
    const where = (r.actual_nodes ?? []).join(', ') || 'another node';
    const why = (r.reasons ?? []).join(', ');
    return {
      tenantId: r.tenant_id,
      kind: 'placement_misplaced',
      severity: 'warning' as const,
      objectLabel: r.name,
      detail: `Not on its primary node ${r.primary_node ?? '—'}: ${why || `on ${where}`}`,
      actionPath: `/tenants/${r.tenant_id}`,
      since: r.misplaced_since ? new Date(r.misplaced_since).toISOString() : null,
    };
  });
}

export interface ListIssuesOptions {
  /** How far ahead a subscription expiry counts as an issue. */
  readonly expiryHorizonDays?: number;
}

/**
 * Every open issue across the fleet, indexed by tenant id.
 *
 * Never throws: a broken source must degrade the badge, not blank the tenants
 * table. Each source is guarded independently for the same reason the
 * retention pass is — one failure must not hide the others.
 */
export async function listTenantIssues(
  db: Database,
  opts: ListIssuesOptions = {},
): Promise<Map<string, TenantIssue[]>> {
  const horizon = opts.expiryHorizonDays ?? 35;
  const sources: Array<[string, Promise<TenantIssue[]>]> = [
    ['mailbox_quota', mailboxQuotaIssues(db)],
    ['tenant_row', tenantRowIssues(db, horizon)],
    ['placement', placementIssues(db)],
  ];

  const byTenant = new Map<string, TenantIssue[]>();
  for (const [label, promise] of sources) {
    try {
      for (const issue of await promise) {
        const list = byTenant.get(issue.tenantId);
        if (list) list.push(issue);
        else byTenant.set(issue.tenantId, [issue]);
      }
    } catch (err) {
      console.warn(`[tenant-issues] source ${label} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return byTenant;
}

export interface TenantIssueSummary {
  readonly count: number;
  readonly severity: IssueSeverity | null;
}

/** Collapse a tenant's issues into what the status column shows. */
export function summarise(issues: readonly TenantIssue[] | undefined): TenantIssueSummary {
  if (!issues || issues.length === 0) return { count: 0, severity: null };
  return {
    count: issues.length,
    // One critical makes the whole badge critical: the badge's job is to say
    // "look here", and averaging severity buries the thing worth looking at.
    severity: issues.some((i) => i.severity === 'critical') ? 'critical' : 'warning',
  };
}
