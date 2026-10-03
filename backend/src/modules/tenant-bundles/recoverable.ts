/**
 * Tenants that can be restored from their off-site bundles — deleted ones
 * included, by name.
 *
 * Deleting a tenant keeps its bundles for the deleted-tenant retention window
 * (backup_jobs has a loose FK; the reaper expires them later), so the DR
 * "Recover Tenant" flow can re-create it. But every list the operator had
 * read either the `tenants` table (where a deleted tenant no longer is) or the
 * newest 50 bundles across ALL tenants — with ~30 tenants backed up nightly, a
 * deleted tenant's bundles fell out of that window within a night or two, and
 * where it did appear it was an unnamed "deleted tenant". Recoverable, but
 * unfindable.
 *
 * This reads straight from backup_jobs, grouped per tenant, and names a
 * deleted tenant from its `deleted` lifecycle transition: the name recorded
 * there (cascades.ts applyDeleted), or — for a tenant deleted before that was
 * recorded — the slug of the namespace the transition kept.
 */
import { sql } from 'drizzle-orm';
import type { RecoverableTenant } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';

/** `tenant-moodle-elearning-362f3d17` → `moodle-elearning`. Pure. */
export function slugFromNamespace(namespace: string | null): string | null {
  if (!namespace) return null;
  const m = /^tenant-(.+)-[0-9a-f]{8}$/.exec(namespace);
  return m ? m[1]! : namespace;
}

export interface RecoverableRow {
  readonly tenant_id: string;
  readonly bundle_count: number | string;
  readonly newest_at: Date | string;
  readonly newest_completed_id: string | null;
  readonly kept_until: Date | string | null;
  readonly keep_forever: boolean;
  readonly live_name: string | null;
  readonly deleted_at: Date | string | null;
  readonly deleted_name: string | null;
  readonly deleted_ns: string | null;
}

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

/** One row per tenant, deleted ones named as well as we can. Pure. */
export function toRecoverable(r: RecoverableRow): RecoverableTenant {
  const deleted = r.live_name === null;
  const name = r.live_name
    ?? r.deleted_name
    ?? slugFromNamespace(r.deleted_ns)
    ?? `tenant ${r.tenant_id.slice(0, 8)}`;
  return {
    tenantId: r.tenant_id,
    name,
    deleted,
    deletedAt: deleted ? iso(r.deleted_at) : null,
    bundleCount: Number(r.bundle_count),
    newestBundleAt: iso(r.newest_at)!,
    newestCompletedBundleId: r.newest_completed_id,
    keptUntil: r.keep_forever ? null : iso(r.kept_until),
  };
}

export async function listRecoverableTenants(db: Database): Promise<RecoverableTenant[]> {
  const res = await db.execute(sql`
    WITH b AS (
      SELECT tenant_id,
             count(*)                                                              AS bundle_count,
             max(created_at)                                                       AS newest_at,
             (array_agg(id ORDER BY created_at DESC, id DESC)
                FILTER (WHERE status = 'completed'))[1]                            AS newest_completed_id,
             max(expires_at)                                                       AS kept_until,
             bool_or(expires_at IS NULL)                                           AS keep_forever
        FROM backup_jobs
       WHERE status IN ('completed', 'partial')
         AND (expires_at IS NULL OR expires_at > now())
       GROUP BY tenant_id
    )
    SELECT b.*, t.name AS live_name,
           d.started_at AS deleted_at, d.detail->>'tenantName' AS deleted_name, d.namespace AS deleted_ns
      FROM b
      LEFT JOIN tenants t ON t.id = b.tenant_id
      LEFT JOIN LATERAL (
        SELECT l.started_at, l.detail, l.namespace
          FROM tenant_lifecycle_transitions l
         WHERE l.tenant_id = b.tenant_id AND l.transition_kind = 'deleted'
         ORDER BY l.started_at DESC
         LIMIT 1
      ) d ON t.id IS NULL
  `) as unknown as { rows?: RecoverableRow[] };
  return (res.rows ?? [])
    .map(toRecoverable)
    // Deleted first (the ones that are otherwise unfindable), newest delete first; then live by name.
    .sort((a, b) => (a.deleted === b.deleted
      ? (a.deleted ? (b.deletedAt ?? '').localeCompare(a.deletedAt ?? '') : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      : a.deleted ? -1 : 1));
}

/** The newest completed, unexpired bundle of a tenant — what a recover of a deleted tenant uses by default. */
export async function newestRecoverableBundleId(db: Database, tenantId: string): Promise<string | null> {
  const res = await db.execute(sql`
    SELECT id FROM backup_jobs
     WHERE tenant_id = ${tenantId} AND status = 'completed'
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  `) as unknown as { rows?: Array<{ id: string }> };
  return res.rows?.[0]?.id ?? null;
}
