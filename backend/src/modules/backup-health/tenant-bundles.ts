/**
 * Tenant bundles in the backup-health roll-up (`GET /admin/backup-health`).
 *
 * The roll-up's other rows come from Kubernetes Jobs labelled
 * `insula.host/backup-health-watch=true` (service.ts). Tenant backups are not
 * such Jobs: a bundle is run by the in-process orchestrator and recorded as one
 * `backup_jobs` row; the per-component Jobs it starts carry no health label and
 * are deleted ten minutes after they finish. With the Job listing as the only
 * source, no row was ever `category: 'tenant'`, and the Backups dashboard's
 * Tenants card read "0 · no jobs registered" beside hundreds of bundles.
 *
 * So tenant rows are read from the bundle ledger — the same source as the
 * Backups & DR card on the admin dashboard (dashboard/backup-classes.ts):
 *
 *   - one row per tenant that has a finished bundle on record, plus one per
 *     tenant the nightly wave covers that has none yet (`never_run` — a
 *     tenant with no backup must not hide behind its healthy neighbours);
 *   - success = a `completed` bundle; failure = `partial` or `failed` (a
 *     partial bundle "did not complete", as its notification says);
 *   - the NEWEST finished bundle decides the state, judged by when each
 *     started, exactly as a Job group is judged by its newest run.
 *
 * Archived tenants are gone and are left out. `expired` bundles were pruned
 * by retention and say nothing about the tenant's current protection.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { BackupHealthSummary } from './service.js';

/** groupKey prefix — a CronJob name cannot contain '/', so no collision. */
export const TENANT_BUNDLE_GROUP_PREFIX = 'tenant-bundles/';

/** Same cap the failure notifications apply to a Job's failure message. */
const REASON_MAX_CHARS = 500;

/** One tenant's bundle ledger, reduced to what a health row needs. */
export interface TenantBundleLedger {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly namespace: string;
  /** Finished bundles on record: completed, partial or failed. */
  readonly runs: number;
  /** Newest completed bundle — when it started, and when it finished. */
  readonly lastSuccessStartedAt: Date | null;
  readonly lastSuccessAt: Date | null;
  /** Newest partial or failed bundle. */
  readonly lastFailedStartedAt: Date | null;
  readonly lastFailedAt: Date | null;
  readonly lastFailedReason: string | null;
}

export function summariseTenantBundles(
  ledgers: ReadonlyArray<TenantBundleLedger>,
): BackupHealthSummary[] {
  return ledgers.map((l) => ({
    groupKey: `${TENANT_BUNDLE_GROUP_PREFIX}${l.tenantId}`,
    displayName: l.tenantName,
    namespace: l.namespace,
    category: 'tenant',
    severity: 'warning',
    tenantId: l.tenantId,
    state: stateOf(l),
    lastSuccessAt: l.lastSuccessAt,
    lastFailedAt: l.lastFailedAt,
    lastFailedReason: l.lastFailedReason ? l.lastFailedReason.slice(0, REASON_MAX_CHARS) : null,
    recentRuns: l.runs,
  }));
}

function stateOf(l: TenantBundleLedger): BackupHealthSummary['state'] {
  const failedStart = l.lastFailedStartedAt?.getTime() ?? null;
  const successStart = l.lastSuccessStartedAt?.getTime() ?? null;
  if (failedStart === null && successStart === null) return 'never_run';
  if (failedStart !== null && (successStart === null || failedStart > successStart)) return 'failing';
  return 'healthy';
}

// A type alias, not an interface: db.execute<T> wants Record<string, unknown>.
type LedgerRow = {
  readonly tenant_id: string;
  readonly tenant_name: string;
  readonly namespace: string;
  readonly runs: number | null;
  readonly ok_started: Date | string | null;
  readonly ok_at: Date | string | null;
  readonly bad_started: Date | string | null;
  readonly bad_at: Date | string | null;
  readonly bad_reason: string | null;
};

const toDate = (v: Date | string | null): Date | null => (v == null ? null : new Date(v));

/**
 * Health rows for every tenant with a finished bundle, plus every tenant the
 * nightly wave covers (selectWaveTenants — the wave's own predicate, so the
 * two cannot drift) that has none.
 */
export async function loadTenantBundleHealth(db: Database): Promise<BackupHealthSummary[]> {
  const res = await db.execute<LedgerRow>(sql`
    WITH finished AS (
      SELECT tenant_id, status, created_at, COALESCE(finished_at, created_at) AS ended_at, last_error
        FROM backup_jobs
       WHERE status IN ('completed', 'partial', 'failed')
    ), agg AS (
      SELECT tenant_id,
             COUNT(*)::int AS runs,
             MAX(created_at) FILTER (WHERE status = 'completed') AS ok_started,
             MAX(ended_at)   FILTER (WHERE status = 'completed') AS ok_at,
             MAX(created_at) FILTER (WHERE status <> 'completed') AS bad_started,
             MAX(ended_at)   FILTER (WHERE status <> 'completed') AS bad_at
        FROM finished
       GROUP BY tenant_id
    ), newest_bad AS (
      SELECT DISTINCT ON (tenant_id) tenant_id, last_error
        FROM finished
       WHERE status <> 'completed'
       ORDER BY tenant_id, created_at DESC
    )
    SELECT t.id AS tenant_id, t.name AS tenant_name, t.kubernetes_namespace AS namespace,
           agg.runs, agg.ok_started, agg.ok_at, agg.bad_started, agg.bad_at,
           newest_bad.last_error AS bad_reason
      FROM tenants t
      LEFT JOIN agg ON agg.tenant_id = t.id
      LEFT JOIN newest_bad ON newest_bad.tenant_id = t.id
     WHERE t.status <> 'archived'
  `);

  const { selectWaveTenants } = await import('../tenant-bundles/global-scheduler.js');
  const wave = new Set((await selectWaveTenants(db)).map((t) => t.id));

  const ledgers: TenantBundleLedger[] = (res.rows ?? [])
    .filter((r) => (r.runs ?? 0) > 0 || wave.has(r.tenant_id))
    .map((r) => ({
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      namespace: r.namespace,
      runs: r.runs ?? 0,
      lastSuccessStartedAt: toDate(r.ok_started),
      lastSuccessAt: toDate(r.ok_at),
      lastFailedStartedAt: toDate(r.bad_started),
      lastFailedAt: toDate(r.bad_at),
      lastFailedReason: r.bad_reason,
    }));
  return summariseTenantBundles(ledgers);
}
