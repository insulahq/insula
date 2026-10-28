/**
 * A tenant's restore cart that brings applications back is held to the
 * subscription's application limit, like the Restore button on the
 * Applications page. An admin cart is not: an operator restoring a tenant
 * (or recovering it after a disaster) must get back exactly what the tenant
 * had, and can raise the tenant's override if that is more than its plan
 * allows today.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../../db/index.js';
import { deployments } from '../../../db/schema.js';
import { withApplicationSlot } from '../../deployments/application-limit.js';

/**
 * How many of these bundle rows would become applications the tenant does not
 * have now: rows the bundle holds as not deleted whose id is not a live,
 * non-deleted row. Pure.
 */
export function revivedApplicationCount(
  bundleRows: ReadonlyArray<Record<string, unknown>>,
  liveNotDeletedIds: ReadonlySet<string>,
): number {
  let n = 0;
  for (const row of bundleRows) {
    const id = typeof row.id === 'string' ? row.id : null;
    if (!id) continue;
    if (row.status === 'deleted') continue;
    if (liveNotDeletedIds.has(id)) continue;
    n += 1;
  }
  return n;
}

/**
 * Run `write` (the upsert that revives the rows) holding the tenant's
 * application slot when a tenant cart would add applications. The lock is
 * advisory and cross-connection, so `write` may use its own connection; a
 * deploy racing it waits until the restore has written.
 */
export async function withinApplicationLimitForCart<T>(args: {
  readonly app: FastifyInstance;
  readonly restoreJobId: string;
  readonly tenantCart: boolean;
  readonly bundleRows: ReadonlyArray<Record<string, unknown>>;
  readonly write: () => Promise<T>;
}): Promise<T> {
  const { app, restoreJobId, tenantCart, bundleRows, write } = args;
  if (!tenantCart || bundleRows.length === 0) return write();
  const ids = bundleRows.map((r) => r.id).filter((v): v is string => typeof v === 'string');
  if (ids.length === 0) return write();
  const db = app.db as Database;
  const job = await db.execute<{ tenant_id: string }>(sql`SELECT tenant_id FROM restore_jobs WHERE id = ${restoreJobId}`);
  const tenantId = job.rows?.[0]?.tenant_id;
  if (!tenantId) return write();
  const live = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(eq(deployments.tenantId, tenantId), inArray(deployments.id, ids), ne(deployments.status, 'deleted')));
  const adding = revivedApplicationCount(bundleRows, new Set(live.map((r) => r.id)));
  if (adding === 0) return write();
  return withApplicationSlot(db, tenantId, 'restore', () => write(), adding);
}
