/**
 * Phase 1 of tenant-panel email parity round 2: plan-based mailbox
 * limit helpers.
 *
 * The platform caps the total number of mailboxes a tenant can
 * create via their hosting plan (hosting_plans.max_mailboxes),
 * with an optional per-tenant override
 * (tenants.max_mailboxes_override).
 *
 *   null or <= 0 override → inherit from plan
 *   numeric override > 0  → use override (may be higher or lower)
 *
 * `getTenantMailboxCount` sums mailboxes across ALL the tenant's
 * email domains — not per-domain — so a tenant with 3 domains and
 * 10 mailboxes each hits the 25 cap at total=25, not per-domain.
 */

import { eq, sql } from 'drizzle-orm';
import { tenants, hostingPlans, mailboxes } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';

export type MailboxLimitSource = 'plan' | 'tenant_override';

export interface EffectiveMailboxLimit {
  readonly limit: number;
  readonly source: MailboxLimitSource;
}

export interface ComputeLimitInput {
  readonly planLimit: number;
  readonly override: number | null;
}

/**
 * Pure function — decide the effective mailbox limit given the
 * plan limit and an optional per-tenant override. Zero, negative,
 * and null overrides fall through to the plan limit.
 */
export function computeTenantMailboxLimit(input: ComputeLimitInput): EffectiveMailboxLimit {
  if (typeof input.override === 'number' && input.override > 0) {
    return { limit: input.override, source: 'tenant_override' };
  }
  return { limit: input.planLimit, source: 'plan' };
}

/**
 * Count mailboxes for a tenant across ALL their email domains.
 * Uses a direct filter on mailboxes.tenant_id (denormalized into
 * the mailboxes table at creation time) so we avoid joining
 * through email_domains.
 */
export async function getTenantMailboxCount(
  db: Database,
  tenantId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(mailboxes)
    .where(eq(mailboxes.tenantId, tenantId));
  return Number(row?.count ?? 0);
}

/**
 * Fetch the plan + override for a tenant and compute the
 * effective limit. Throws CLIENT_NOT_FOUND if the tenant row
 * doesn't exist.
 */
export async function getTenantMailboxLimit(
  db: Database,
  tenantId: string,
): Promise<EffectiveMailboxLimit> {
  const [row] = await db
    .select({
      planLimit: hostingPlans.maxMailboxes,
      override: tenants.maxMailboxesOverride,
    })
    .from(tenants)
    .innerJoin(hostingPlans, eq(tenants.planId, hostingPlans.id))
    .where(eq(tenants.id, tenantId));
  if (!row) {
    throw new ApiError('CLIENT_NOT_FOUND', `Client '${tenantId}' not found`, 404);
  }
  return computeTenantMailboxLimit({
    planLimit: row.planLimit,
    override: row.override,
  });
}
