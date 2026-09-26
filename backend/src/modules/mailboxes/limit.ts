/**
 * Phase 1 of tenant-panel email parity round 2: plan-based mailbox
 * limit helpers.
 *
 * The platform caps the total number of mailboxes a tenant can
 * create via their hosting plan (hosting_plans.max_mailboxes),
 * with an optional per-tenant override
 * (tenants.max_mailboxes_override).
 *
 *   null override      → inherit from plan
 *   override >= 0      → use override (may be higher or lower, and 0
 *                        is a real answer: mail off for this tenant)
 *   negative override  → inherit from plan (defensive; the column has
 *                        no CHECK constraint and the contract rejects
 *                        negatives, so this is unreachable data)
 *
 * `getTenantMailboxCount` sums mailboxes across ALL the tenant's
 * email domains — not per-domain — so a tenant with 3 domains and
 * 10 mailboxes each hits the 25 cap at total=25, not per-domain.
 */

import { and, eq, sql } from 'drizzle-orm';
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
 * Pure function — decide the effective mailbox limit given the plan
 * limit and an optional per-tenant override.
 *
 * ★ An override of 0 means ZERO, not "unset". Operators disable mail for
 * a single tenant by setting the override to 0; reading that as "inherit
 * the plan" silently handed the tenant the plan's full allowance, so the
 * UI accepted the setting and nothing changed. Only `null` inherits.
 * (Negatives still inherit — see the note at the top of the file.)
 */
export function computeTenantMailboxLimit(input: ComputeLimitInput): EffectiveMailboxLimit {
  if (typeof input.override === 'number' && input.override >= 0) {
    return { limit: input.override, source: 'tenant_override' };
  }
  return { limit: input.planLimit, source: 'plan' };
}

/**
 * Count BILLABLE mailboxes for a tenant across ALL their email domains.
 * Uses a direct filter on mailboxes.tenant_id (denormalized into
 * the mailboxes table at creation time) so we avoid joining
 * through email_domains.
 *
 * Platform-managed rows (migration 0123 — the `dmarc@`/`postmaster@` intake
 * mailboxes the report-intake reconciler owns) are excluded. They are created
 * BY the platform on the tenant's domain, so counting them charged the tenant
 * for capacity they never requested AND made the reconciler fight the cap: on
 * production it was rejected 9 times every 5 minutes, and each rejection
 * emailed the tenant "remove a mailbox or upgrade your plan" about an action
 * no tenant had taken.
 */
export async function getTenantMailboxCount(
  db: Database,
  tenantId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(mailboxes)
    .where(and(
      eq(mailboxes.tenantId, tenantId),
      eq(mailboxes.platformManaged, false),
    ));
  return Number(row?.count ?? 0);
}

/**
 * Fetch the plan + override for a tenant and compute the
 * effective limit. Throws TENANT_NOT_FOUND if the tenant row
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
    throw new ApiError('TENANT_NOT_FOUND', `Tenant '${tenantId}' not found`, 404);
  }
  return computeTenantMailboxLimit({
    planLimit: row.planLimit,
    override: row.override,
  });
}

// ── Per-mailbox SIZE cap ─────────────────────────────────────────────
//
// Sibling of the count cap above. The platform caps an INDIVIDUAL
// mailbox's size (quota_mb) via the hosting plan
// (hosting_plans.max_mailbox_size_mb), with an optional per-tenant
// override (tenants.max_mailbox_size_mb_override). Precedence:
//
//   null or <= 0 override → inherit from plan
//   numeric override > 0  → use override (may be higher or lower)
//
// ★ Deliberately NOT the same rule as the COUNT cap above, which treats 0
// as a real limit. A 0-byte mailbox is not a thing an operator can want;
// "no mail for this tenant" is expressed by the count cap. Don't align
// these two for symmetry's sake.
//
// This bounds each mailbox individually; it does NOT make total mail
// storage count against the subscription storage_limit.

export type MailboxSizeLimitSource = 'plan' | 'tenant_override';

export interface EffectiveMailboxSizeLimit {
  /** Max size of one mailbox, in MB. */
  readonly limit: number;
  readonly source: MailboxSizeLimitSource;
}

/**
 * Pure function — decide the effective per-mailbox size limit (MB) given
 * the plan limit and an optional per-tenant override. Zero, negative, and
 * null overrides fall through to the plan limit.
 */
export function computeTenantMailboxSizeLimit(input: ComputeLimitInput): EffectiveMailboxSizeLimit {
  if (typeof input.override === 'number' && input.override > 0) {
    return { limit: input.override, source: 'tenant_override' };
  }
  return { limit: input.planLimit, source: 'plan' };
}

/**
 * Fetch the plan size cap + per-tenant override and compute the effective
 * per-mailbox size limit. Throws TENANT_NOT_FOUND if the tenant row
 * doesn't exist.
 */
export async function getTenantMailboxSizeLimit(
  db: Database,
  tenantId: string,
): Promise<EffectiveMailboxSizeLimit> {
  const [row] = await db
    .select({
      planLimit: hostingPlans.maxMailboxSizeMb,
      override: tenants.maxMailboxSizeMbOverride,
    })
    .from(tenants)
    .innerJoin(hostingPlans, eq(tenants.planId, hostingPlans.id))
    .where(eq(tenants.id, tenantId));
  if (!row) {
    throw new ApiError('TENANT_NOT_FOUND', `Tenant '${tenantId}' not found`, 404);
  }
  return computeTenantMailboxSizeLimit({
    planLimit: row.planLimit,
    override: row.override,
  });
}
