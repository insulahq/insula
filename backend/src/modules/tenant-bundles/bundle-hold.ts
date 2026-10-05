/**
 * When a bundle outlives its `expires_at` — the ONE definition, shared by every
 * query that asks "is this bundle still a restore point?".
 *
 * A bundle past `expires_at` is HELD (not expired, not reclaimed) when:
 *   - its tenant is suspended — backups pause while suspended (suspension.ts),
 *     and a long suspension must not age the tenant out of every backup; or
 *   - it is a live tenant's newest restorable (completed/partial) bundle — kept
 *     until a newer one completes, so a tenant reactivated after a long
 *     suspension, or one whose nightly bundles keep failing, is never left
 *     with no restore point at all; or
 *   - it holds a live tenant's newest COMPLETED copy of some component — a
 *     newer partial bundle whose mail (or files, …) capture failed must not
 *     let the last good copy of that component age out.
 * Archived and deleted tenants (a deleted tenant has no `tenants` row) are not
 * held: their data must still age out.
 *
 * Why one module: several queries decide liveness independently — the expiry
 * sweep, the restic reconciler's keep-set, the recovery listings, the predump
 * pruner. When the expiry sweep learned to hold a bundle and the restic
 * keep-set did not, the reconciler would have forgotten the held bundle's
 * snapshots — destroying the data while the row still read `completed`. Every
 * such query uses {@link bundleIsLive} or {@link heldPastExpiry}, and
 * bundle-hold.integration.test.ts pins them against each other.
 */
import { sql, type SQL } from 'drizzle-orm';

/** `alias` is the backup_jobs alias in the caller's query (a fixed identifier, never input). */
export function heldPastExpiry(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`(
    EXISTS (SELECT 1 FROM tenants hold_t WHERE hold_t.id = ${a}.tenant_id AND hold_t.status = 'suspended')
    OR (
      ${a}.status IN ('completed', 'partial')
      AND EXISTS (SELECT 1 FROM tenants hold_t WHERE hold_t.id = ${a}.tenant_id AND hold_t.status IN ('active', 'pending'))
      AND (
        NOT EXISTS (
          SELECT 1 FROM backup_jobs hold_n
           WHERE hold_n.tenant_id = ${a}.tenant_id
             AND hold_n.status IN ('completed', 'partial')
             AND (hold_n.created_at, hold_n.id) > (${a}.created_at, ${a}.id)
        )
        -- Per component: a newer PARTIAL bundle can lack a component (its
        -- capture failed). The bundle holding the newest completed copy of any
        -- component stays a restore point until a newer bundle completes that
        -- component — otherwise the sweep expires the last mail (or files, …)
        -- copy while a newer bundle "covers" the tenant. A newer 'skipped'
        -- (nothing to capture) does not replace it: at most one bundle per
        -- component is held this way, and only while the tenant is live.
        OR EXISTS (
          SELECT 1 FROM backup_components hold_c
           WHERE hold_c.backup_job_id = ${a}.id
             AND hold_c.status = 'completed'
             AND NOT EXISTS (
               SELECT 1 FROM backup_jobs hold_m
                 JOIN backup_components hold_mc ON hold_mc.backup_job_id = hold_m.id
                WHERE hold_m.tenant_id = ${a}.tenant_id
                  AND hold_m.status IN ('completed', 'partial')
                  AND (hold_m.created_at, hold_m.id) > (${a}.created_at, ${a}.id)
                  AND hold_mc.component = hold_c.component
                  AND hold_mc.status = 'completed'
             )
        )
      )
    )
  )`;
}

/** A restore point: completed/partial and either unexpired or held. */
export function bundleIsLive(alias: string, now: Date | SQL = sql`now()`): SQL {
  const a = sql.raw(alias);
  return sql`(
    ${a}.status IN ('completed', 'partial')
    AND (${a}.expires_at IS NULL OR ${a}.expires_at > ${now} OR ${heldPastExpiry(alias)})
  )`;
}
