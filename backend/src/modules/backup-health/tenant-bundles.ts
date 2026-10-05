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
 *     started, exactly as a Job group is judged by its newest run. The last
 *     success and the last failure are each ONE bundle — the newest-started of
 *     its kind — so a time and an error are never taken from two bundles;
 *   - severity: `critical` when the newest bundle `failed` outright, or when a
 *     tenant the wave covers has gone two nightly runs (48 h) without a
 *     completed bundle; `warning` otherwise.
 *
 * Archived tenants are gone and are left out. `expired` bundles were pruned
 * by retention and say nothing about the tenant's current protection.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { BackupHealthSummary } from './service.js';

/** groupKey prefix — a CronJob name cannot contain '/', so no collision. */
export const TENANT_BUNDLE_GROUP_PREFIX = 'tenant-bundles/';

/** Two missed nightly runs: a covered tenant unprotected this long is critical. */
export const UNPROTECTED_CRITICAL_MS = 48 * 3_600_000;

/** Same cap the failure notifications apply to a Job's failure message. */
const REASON_MAX_CHARS = 500;

/** One tenant's bundle ledger, reduced to what a health row needs. */
export interface TenantBundleLedger {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly namespace: string;
  readonly tenantCreatedAt: Date;
  /** The nightly wave bundles this tenant (selectWaveTenants). */
  readonly waveCovered: boolean;
  /** Finished bundles on record: completed, partial or failed. */
  readonly runs: number;
  /** The newest-started completed bundle — when it started and finished. */
  readonly lastSuccessStartedAt: Date | null;
  readonly lastSuccessAt: Date | null;
  /** The newest-started partial or failed bundle — every field from it. */
  readonly lastFailedStartedAt: Date | null;
  readonly lastFailedAt: Date | null;
  readonly lastFailedReason: string | null;
  readonly lastFailedStatus: 'partial' | 'failed' | null;
}

export function summariseTenantBundles(
  ledgers: ReadonlyArray<TenantBundleLedger>,
  now: Date,
): BackupHealthSummary[] {
  return ledgers.map((l) => {
    const state = stateOf(l);
    return {
      groupKey: `${TENANT_BUNDLE_GROUP_PREFIX}${l.tenantId}`,
      displayName: l.tenantName,
      namespace: l.namespace,
      category: 'tenant',
      severity: severityOf(l, state, now),
      tenantId: l.tenantId,
      state,
      lastSuccessAt: l.lastSuccessAt,
      lastFailedAt: l.lastFailedAt,
      lastFailedReason: l.lastFailedReason ? l.lastFailedReason.slice(0, REASON_MAX_CHARS) : null,
      recentRuns: l.runs,
    };
  });
}

function stateOf(l: TenantBundleLedger): BackupHealthSummary['state'] {
  const failedStart = l.lastFailedStartedAt?.getTime() ?? null;
  const successStart = l.lastSuccessStartedAt?.getTime() ?? null;
  if (failedStart === null && successStart === null) return 'never_run';
  if (failedStart !== null && (successStart === null || failedStart > successStart)) return 'failing';
  return 'healthy';
}

function severityOf(
  l: TenantBundleLedger,
  state: BackupHealthSummary['state'],
  now: Date,
): BackupHealthSummary['severity'] {
  if (state === 'failing' && l.lastFailedStatus === 'failed') return 'critical';
  // Unprotected since the last completed bundle — or, never backed up, since
  // the tenant was created (a tenant made an hour ago has missed nothing yet).
  const unprotectedSince = (l.lastSuccessAt ?? l.tenantCreatedAt).getTime();
  if (l.waveCovered && now.getTime() - unprotectedSince > UNPROTECTED_CRITICAL_MS) return 'critical';
  return 'warning';
}

// A type alias, not an interface: db.execute<T> wants Record<string, unknown>.
type LedgerRow = {
  readonly tenant_id: string;
  readonly tenant_name: string;
  readonly namespace: string;
  readonly tenant_created_at: Date | string;
  readonly runs: number | null;
  readonly ok_started: Date | string | null;
  readonly ok_at: Date | string | null;
  readonly bad_started: Date | string | null;
  readonly bad_at: Date | string | null;
  readonly bad_reason: string | null;
  readonly bad_status: string | null;
};

const toDate = (v: Date | string | null): Date | null => (v == null ? null : new Date(v));

/**
 * Health rows for every tenant with a finished bundle, plus every tenant the
 * nightly wave covers (selectWaveTenants — the wave's own predicate, so the
 * two cannot drift) that has none.
 */
export async function loadTenantBundleHealth(
  db: Database,
  now: Date = new Date(),
): Promise<BackupHealthSummary[]> {
  const res = await db.execute<LedgerRow>(sql`
    WITH finished AS (
      SELECT id, tenant_id, status, created_at, COALESCE(finished_at, created_at) AS ended_at,
             last_error, (status = 'completed') AS ok
        FROM backup_jobs
       WHERE status IN ('completed', 'partial', 'failed')
    ), runs AS (
      SELECT tenant_id, COUNT(*)::int AS runs FROM finished GROUP BY tenant_id
    ), newest AS (
      -- The newest-started bundle of each kind (success / failure) per tenant:
      -- every field shown for "last success" / "last failure" is from it.
      SELECT DISTINCT ON (tenant_id, ok) tenant_id, ok, status, created_at, ended_at, last_error
        FROM finished
       ORDER BY tenant_id, ok, created_at DESC, id DESC
    )
    SELECT t.id AS tenant_id, t.name AS tenant_name, t.kubernetes_namespace AS namespace,
           t.created_at AS tenant_created_at, runs.runs,
           good.created_at AS ok_started, good.ended_at AS ok_at,
           bad.created_at AS bad_started, bad.ended_at AS bad_at,
           bad.last_error AS bad_reason, bad.status::text AS bad_status
      FROM tenants t
      LEFT JOIN runs ON runs.tenant_id = t.id
      LEFT JOIN newest good ON good.tenant_id = t.id AND good.ok
      LEFT JOIN newest bad ON bad.tenant_id = t.id AND NOT bad.ok
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
      tenantCreatedAt: new Date(r.tenant_created_at),
      waveCovered: wave.has(r.tenant_id),
      runs: r.runs ?? 0,
      lastSuccessStartedAt: toDate(r.ok_started),
      lastSuccessAt: toDate(r.ok_at),
      lastFailedStartedAt: toDate(r.bad_started),
      lastFailedAt: toDate(r.bad_at),
      lastFailedReason: r.bad_reason,
      lastFailedStatus: r.bad_status === 'failed' || r.bad_status === 'partial' ? r.bad_status : null,
    }));
  return summariseTenantBundles(ledgers, now);
}
