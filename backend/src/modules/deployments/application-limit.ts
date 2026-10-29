/**
 * The subscription's application limit — `hosting_plans.max_applications`,
 * overridden per tenant by `tenants.max_applications_override`.
 *
 * What counts is exactly what the tenant's Applications page lists: every
 * row of `deployments` (catalog apps, custom containers, compose stacks) that
 * is not deleted, and every private worker that is not revoked. Stopped ones
 * count — they keep their volume, their name and their place, and starting
 * one again needs no free slot. A revoked worker is the worker's "deleted":
 * its tunnel is closed for good and nothing brings it back. Platform pods in
 * the namespace (file manager, the private-worker server, auth and mesh
 * proxies) are not applications and are in neither table.
 *
 * Enforced where an application comes INTO existence or back from the
 * deleted list: catalog deploy, custom create (simple and compose), a new
 * private worker, restore from Recently Deleted, and a tenant's restore cart
 * that brings deployments back (bundles never carry workers). A tenant
 * already over its limit (a plan lowered, a limit introduced) keeps
 * everything it runs; it only cannot add.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import type { ApplicationLimitSource, ApplicationUsage } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import { deployments, hostingPlans, privateWorkers, tenants } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';

export interface EffectiveApplicationLimit {
  readonly limit: number;
  readonly source: ApplicationLimitSource;
}

/**
 * Plan limit, unless the tenant has an override. An override of 0 means
 * zero (no applications), not "unset" — only null inherits the plan.
 */
export function computeTenantApplicationLimit(input: {
  readonly planLimit: number;
  readonly override: number | null | undefined;
}): EffectiveApplicationLimit {
  if (typeof input.override === 'number' && input.override >= 0) {
    return { limit: input.override, source: 'tenant_override' };
  }
  return { limit: input.planLimit, source: 'plan' };
}

export async function getTenantApplicationLimit(db: Database, tenantId: string): Promise<EffectiveApplicationLimit> {
  const [row] = await db
    .select({ planLimit: hostingPlans.maxApplications, override: tenants.maxApplicationsOverride })
    .from(tenants)
    .innerJoin(hostingPlans, eq(tenants.planId, hostingPlans.id))
    .where(eq(tenants.id, tenantId));
  if (!row) throw new ApiError('TENANT_NOT_FOUND', `Tenant '${tenantId}' not found`, 404);
  return computeTenantApplicationLimit(row);
}

export interface TenantApplicationCount {
  /** Deployments not deleted. */
  readonly deployments: number;
  /** Private workers not revoked. */
  readonly privateWorkers: number;
}

/**
 * Applications as the Applications page lists them: deployments not deleted, workers not revoked.
 * One query after the other, never in parallel: under withApplicationSlot `db` is a transaction —
 * one connection — and pg refuses (from v9) a query issued while another is still running on it.
 */
export async function countTenantApplications(db: Database, tenantId: string): Promise<TenantApplicationCount> {
  const [apps] = await db
    .select({ count: sql<number>`count(*)` })
    .from(deployments)
    .where(and(eq(deployments.tenantId, tenantId), ne(deployments.status, 'deleted')));
  const [workers] = await db
    .select({ count: sql<number>`count(*)` })
    .from(privateWorkers)
    .where(and(eq(privateWorkers.tenantId, tenantId), ne(privateWorkers.status, 'revoked')));
  return { deployments: Number(apps?.count ?? 0), privateWorkers: Number(workers?.count ?? 0) };
}

export async function getApplicationUsage(db: Database, tenantId: string): Promise<ApplicationUsage> {
  const effective = await getTenantApplicationLimit(db, tenantId);
  const counted = await countTenantApplications(db, tenantId);
  const current = counted.deployments + counted.privateWorkers;
  return {
    limit: effective.limit,
    current,
    privateWorkers: counted.privateWorkers,
    remaining: Math.max(0, effective.limit - current),
    source: effective.source,
  };
}

export type ApplicationLimitAction = 'deploy' | 'restore' | 'worker';

/** The refusal the tenant reads. One wording for every path that adds an application. Pure. */
export function applicationLimitError(
  usage: Pick<ApplicationUsage, 'limit' | 'current' | 'source'>,
  action: ApplicationLimitAction,
  adding = 1,
): ApiError {
  const details = { limit: usage.limit, current: usage.current, source: usage.source, adding };
  if (usage.limit === 0) {
    return new ApiError(
      'APPLICATION_LIMIT_REACHED',
      'Your subscription does not include applications.',
      409,
      details,
      'Ask your administrator to add applications to your subscription.',
    );
  }
  const what = action === 'restore'
    ? (adding === 1 ? 'Restoring this application' : `Restoring ${adding} applications`)
    : action === 'worker'
      ? 'Creating another private worker'
      : (adding === 1 ? 'Deploying another application' : `Deploying ${adding} applications`);
  return new ApiError(
    'APPLICATION_LIMIT_REACHED',
    `${what} would exceed your subscription's limit of ${usage.limit} application${usage.limit === 1 ? '' : 's'}: `
      + `${usage.current} ${usage.current === 1 ? 'is' : 'are'} deployed, stopped ones and private workers included.`,
    409,
    details,
    'Delete an application or private worker you no longer need, or upgrade your plan, then try again.',
  );
}

/** Refuse when `adding` more would not fit. Not race-safe alone — see withApplicationSlot. */
export async function assertApplicationRoom(
  db: Database,
  tenantId: string,
  action: ApplicationLimitAction,
  adding = 1,
): Promise<void> {
  if (adding <= 0) return;
  const usage = await getApplicationUsage(db, tenantId);
  if (usage.current + adding > usage.limit) throw applicationLimitError(usage, action, adding);
}

/**
 * Check and write under one per-tenant lock, so two deploys racing for the
 * last slot cannot both see it free. `write` must be the statement that
 * creates (or revives) the rows, and nothing slow — the lock is held for it.
 */
export async function withApplicationSlot<T>(
  db: Database,
  tenantId: string,
  action: ApplicationLimitAction,
  write: (tx: Database) => Promise<T>,
  adding = 1,
): Promise<T> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Database;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`application-limit/${tenantId}`}, 0))`);
    await assertApplicationRoom(tx, tenantId, action, adding);
    return write(tx);
  });
}

/**
 * A deleted application comes back through ONE door — restore, which checks
 * the application limit. Starting, redeploying, upgrading or PATCHing the
 * status of a deleted row used to revive it past that check (and left
 * `deleted_at` set on a running application). Pure.
 */
export function refuseDeleted(row: { readonly id: string; readonly name: string; readonly status: string }, action: string): void {
  if (row.status !== 'deleted') return;
  throw new ApiError(
    'DEPLOYMENT_DELETED',
    `'${row.name}' is deleted. Restore it from Recently Deleted on the Applications page before you ${action} it.`,
    409,
    { deployment_id: row.id, name: row.name },
    'Restore the application first; restoring checks your subscription has room for it.',
  );
}
