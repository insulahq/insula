/**
 * F4 — WAF rule exclusion CRUD service.
 *
 * Operator-managed surgical exclusions to suppress CRS false-positives
 * on a per-(rule_id, hostname) basis. Rows are rendered by reconciler.ts
 * into the modsec-crs-exclusions-dynamic ConfigMap and the modsec-crs
 * Deployment is rolled. See renderer.ts for the .conf format.
 *
 * Concurrency: every mutation (create/update/delete) takes a row-level
 * pg advisory lock to serialise with the reconciler's read-and-render
 * pass — operators editing rapidly won't cause the reconciler to render
 * a half-applied state. The reconciler holds the same lock during its
 * SELECT.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  type CreateTenantWafRuleExclusionRequest,
  type CreateWafRuleExclusionRequest,
  type UpdateWafRuleExclusionRequest,
  type WafRuleExclusion,
} from '@k8s-hosting/api-contracts';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { domains, ingressRoutes, tenants, wafRuleExclusions } from '../../db/schema.js';

// Loose Db alias — matches `deps.db: NodePgDatabase<any>` used by the
// route module so callers don't need to launder schema types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NodePgDatabase<any>;

const ADVISORY_LOCK_ID = 0x77616665_78636c75n; // 'wafe_xclu' as bigint
const MAX_ENABLED = 1000; // matches renderer.DYNAMIC_RULE_ID_MAX range

export class WafRuleExclusionError extends Error {
  constructor(
    public readonly code:
      | 'DUPLICATE'
      | 'NOT_FOUND'
      | 'OVER_CAPACITY'
      | 'INVALID_REGEX'
      // B2: tenant-scoped operations.
      | 'ROUTE_NOT_FOUND'
      | 'NOT_TENANT_OWNED',
    message: string,
  ) {
    super(message);
    this.name = 'WafRuleExclusionError';
  }
}

/**
 * B2 (2026-05-26): turn a hostname into a SecRule-safe anchored regex.
 * `^foo\.bar\.com$` matches X-Forwarded-Host exactly; metacharacter
 * escape blocks the operator-IP-trust class of footgun where a stray
 * `.` matches more than the tenant's domain. Mirrors the helper used
 * by the admin WhitelistRuleModal pre-fill, but lives server-side
 * here because tenants don't get to choose the regex — the server
 * derives it from the route they're operating on.
 */
const buildHostnameRegexFromHostname = (hostname: string): string => {
  const escaped = hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${escaped}$`;
};

/**
 * B2: load a route AND verify it belongs to the named tenant. Returns
 * the row (caller wants .hostname for hostnameRegex derivation). Throws
 * ROUTE_NOT_FOUND if either the route doesn't exist or it isn't owned
 * by the tenant — same error in both cases so tenants can't probe
 * other tenants' route IDs.
 */
const loadTenantRoute = async (
  db: Db,
  tenantId: string,
  routeId: string,
): Promise<{ id: string; hostname: string }> => {
  const rows = await db
    .select({
      id: ingressRoutes.id,
      hostname: ingressRoutes.hostname,
      domainTenantId: domains.tenantId,
    })
    .from(ingressRoutes)
    .innerJoin(domains, eq(domains.id, ingressRoutes.domainId))
    .where(eq(ingressRoutes.id, routeId))
    .limit(1);
  const row = rows[0];
  if (!row || row.domainTenantId !== tenantId) {
    throw new WafRuleExclusionError(
      'ROUTE_NOT_FOUND',
      `route ${routeId} not found for tenant ${tenantId}`,
    );
  }
  return { id: row.id, hostname: row.hostname };
};

const rowToContract = (row: typeof wafRuleExclusions.$inferSelect): WafRuleExclusion => ({
  id: row.id,
  ruleId: row.ruleId,
  hostnameRegex: row.hostnameRegex,
  scope: row.scope as WafRuleExclusion['scope'],
  reason: row.reason,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  disabled: row.disabled,
  // B2: tenant ownership columns are nullable; admin-scoped rows
  // surface as null/null, tenant-scoped rows as the IDs (both, by
  // the DB CHECK constraint).
  tenantId: row.tenantId ?? null,
  routeId: row.routeId ?? null,
});

export const listExclusions = async (
  db: Db,
  opts: { includeDisabled?: boolean } = {},
): Promise<WafRuleExclusion[]> => {
  const where = opts.includeDisabled ? undefined : eq(wafRuleExclusions.disabled, false);
  const rows = await db
    .select()
    .from(wafRuleExclusions)
    .where(where)
    .orderBy(asc(wafRuleExclusions.createdAt), asc(wafRuleExclusions.id));
  return rows.map(rowToContract);
};

/**
 * Admin-facing list enriched with the tenant's display name when the
 * row is tenant-owned. Admin-scoped rows surface tenantName=null.
 * LEFT JOIN so admin (tenantId IS NULL) rows still appear.
 */
export const listExclusionsForAdmin = async (
  db: Db,
  opts: { includeDisabled?: boolean } = {},
): Promise<Array<WafRuleExclusion & { tenantName: string | null }>> => {
  const where = opts.includeDisabled ? undefined : eq(wafRuleExclusions.disabled, false);
  const rows = await db
    .select({
      id: wafRuleExclusions.id,
      ruleId: wafRuleExclusions.ruleId,
      hostnameRegex: wafRuleExclusions.hostnameRegex,
      scope: wafRuleExclusions.scope,
      reason: wafRuleExclusions.reason,
      createdBy: wafRuleExclusions.createdBy,
      createdAt: wafRuleExclusions.createdAt,
      updatedAt: wafRuleExclusions.updatedAt,
      disabled: wafRuleExclusions.disabled,
      tenantId: wafRuleExclusions.tenantId,
      routeId: wafRuleExclusions.routeId,
      tenantName: tenants.name,
    })
    .from(wafRuleExclusions)
    .leftJoin(tenants, eq(tenants.id, wafRuleExclusions.tenantId))
    .where(where)
    .orderBy(asc(wafRuleExclusions.createdAt), asc(wafRuleExclusions.id));
  return rows.map((row) => ({
    id: row.id,
    ruleId: row.ruleId,
    hostnameRegex: row.hostnameRegex,
    scope: row.scope as WafRuleExclusion['scope'],
    reason: row.reason,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    disabled: row.disabled,
    tenantId: row.tenantId ?? null,
    routeId: row.routeId ?? null,
    tenantName: row.tenantName ?? null,
  }));
};

/**
 * Used by reconciler.ts — same advisory lock as the mutation paths so
 * a render never observes a half-committed mutation. Always returns
 * only enabled rows.
 */
export const listExclusionsForReconciler = async (
  db: Db,
): Promise<WafRuleExclusion[]> => {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_ID})`);
    const rows = await tx
      .select()
      .from(wafRuleExclusions)
      .where(eq(wafRuleExclusions.disabled, false))
      .orderBy(asc(wafRuleExclusions.createdAt), asc(wafRuleExclusions.id));
    return rows.map(rowToContract);
  });
};

export const createExclusion = async (
  db: Db,
  input: CreateWafRuleExclusionRequest,
  createdBy: string,
): Promise<WafRuleExclusion> => {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_ID})`);

    const countRows = await tx
      .select({ enabled: sql<number>`count(*)::int` })
      .from(wafRuleExclusions)
      .where(eq(wafRuleExclusions.disabled, false));
    const enabledCount = Number(countRows[0]?.enabled ?? 0);
    if (enabledCount >= MAX_ENABLED) {
      throw new WafRuleExclusionError(
        'OVER_CAPACITY',
        `cannot create more than ${MAX_ENABLED} enabled exclusions`,
      );
    }

    // Duplicate check — same (rule_id, hostname_regex, scope) enabled row.
    // The partial unique index will also catch this but the explicit
    // check yields a friendlier error code.
    const existing = await tx
      .select({ id: wafRuleExclusions.id })
      .from(wafRuleExclusions)
      .where(
        and(
          eq(wafRuleExclusions.ruleId, input.ruleId),
          eq(wafRuleExclusions.hostnameRegex, input.hostnameRegex),
          eq(wafRuleExclusions.scope, input.scope),
          eq(wafRuleExclusions.disabled, false),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      throw new WafRuleExclusionError(
        'DUPLICATE',
        `an enabled exclusion already exists for rule ${input.ruleId} on ${input.hostnameRegex} (${input.scope})`,
      );
    }

    const id = randomUUID();
    const now = new Date();
    await tx.insert(wafRuleExclusions).values({
      id,
      ruleId: input.ruleId,
      hostnameRegex: input.hostnameRegex,
      scope: input.scope,
      reason: input.reason,
      createdBy,
      createdAt: now,
      updatedAt: now,
      disabled: false,
    });

    const [row] = await tx.select().from(wafRuleExclusions).where(eq(wafRuleExclusions.id, id));
    return rowToContract(row!);
  });
};

export const updateExclusion = async (
  db: Db,
  id: string,
  input: UpdateWafRuleExclusionRequest,
): Promise<WafRuleExclusion> => {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_ID})`);

    const [current] = await tx
      .select()
      .from(wafRuleExclusions)
      .where(eq(wafRuleExclusions.id, id))
      .limit(1);
    if (!current) {
      throw new WafRuleExclusionError('NOT_FOUND', `exclusion ${id} not found`);
    }

    // If toggling disabled=false (re-enabling) check duplicate against
    // currently-enabled rows.
    const next = {
      hostnameRegex: input.hostnameRegex ?? current.hostnameRegex,
      scope: (input.scope ?? current.scope) as WafRuleExclusion['scope'],
      reason: input.reason ?? current.reason,
      disabled: input.disabled ?? current.disabled,
    };

    if (!next.disabled) {
      // Re-enabling a disabled row also counts against MAX_ENABLED — without
      // this gate an operator could PATCH disabled→false in sequence past
      // 1000, breaking the renderer (which throws beyond DYNAMIC_RULE_ID_MAX)
      // and stalling every future reconcile tick.
      if (current.disabled) {
        const countRows = await tx
          .select({ enabled: sql<number>`count(*)::int` })
          .from(wafRuleExclusions)
          .where(eq(wafRuleExclusions.disabled, false));
        const enabledCount = Number(countRows[0]?.enabled ?? 0);
        if (enabledCount >= MAX_ENABLED) {
          throw new WafRuleExclusionError(
            'OVER_CAPACITY',
            `cannot re-enable: already at ${MAX_ENABLED} enabled exclusions`,
          );
        }
      }

      const dupes = await tx
        .select({ id: wafRuleExclusions.id })
        .from(wafRuleExclusions)
        .where(
          and(
            eq(wafRuleExclusions.ruleId, current.ruleId),
            eq(wafRuleExclusions.hostnameRegex, next.hostnameRegex),
            eq(wafRuleExclusions.scope, next.scope),
            eq(wafRuleExclusions.disabled, false),
          ),
        );
      const otherDupe = dupes.find((d) => d.id !== id);
      if (otherDupe) {
        throw new WafRuleExclusionError(
          'DUPLICATE',
          `an enabled exclusion already exists for rule ${current.ruleId} on ${next.hostnameRegex} (${next.scope})`,
        );
      }
    }

    await tx
      .update(wafRuleExclusions)
      .set({
        hostnameRegex: next.hostnameRegex,
        scope: next.scope,
        reason: next.reason,
        disabled: next.disabled,
        updatedAt: new Date(),
      })
      .where(eq(wafRuleExclusions.id, id));

    const [row] = await tx.select().from(wafRuleExclusions).where(eq(wafRuleExclusions.id, id));
    return rowToContract(row!);
  });
};

export const deleteExclusion = async (db: Db, id: string): Promise<void> => {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_ID})`);
    const result = await tx.delete(wafRuleExclusions).where(eq(wafRuleExclusions.id, id));
    if ((result as unknown as { rowCount?: number }).rowCount === 0) {
      throw new WafRuleExclusionError('NOT_FOUND', `exclusion ${id} not found`);
    }
  });
};

// ─── B2 — Tenant-scoped variants ─────────────────────────────────────────
//
// Three thin wrappers that mirror list/create/delete but force tenant_id
// + route_id ownership at every step. The reconciler doesn't need to
// know about the new columns — listExclusionsForReconciler already
// returns every enabled row regardless of ownership, which is exactly
// what should happen (tenant rows render into the same ConfigMap with
// their auto-derived hostnameRegex).

/**
 * List exclusions for a single tenant route. Verifies tenant ownership;
 * returns ROUTE_NOT_FOUND for a route the tenant doesn't own (same
 * error as "doesn't exist" — don't leak route-ID enumeration).
 */
export const listExclusionsForTenantRoute = async (
  db: Db,
  tenantId: string,
  routeId: string,
  opts: { includeDisabled?: boolean } = {},
): Promise<WafRuleExclusion[]> => {
  await loadTenantRoute(db, tenantId, routeId);
  const baseWhere = and(
    eq(wafRuleExclusions.tenantId, tenantId),
    eq(wafRuleExclusions.routeId, routeId),
  );
  const where = opts.includeDisabled
    ? baseWhere
    : and(baseWhere, eq(wafRuleExclusions.disabled, false));
  const rows = await db
    .select()
    .from(wafRuleExclusions)
    .where(where)
    .orderBy(asc(wafRuleExclusions.createdAt), asc(wafRuleExclusions.id));
  return rows.map(rowToContract);
};

/**
 * Create a tenant-scoped exclusion. Server forces hostnameRegex =
 * `^<route.hostname>$` so tenants cannot whitelist a rule on any host
 * outside their domain.
 */
export const createExclusionForTenantRoute = async (
  db: Db,
  tenantId: string,
  routeId: string,
  input: CreateTenantWafRuleExclusionRequest,
  createdBy: string,
): Promise<WafRuleExclusion> => {
  return db.transaction(async (tx) => {
    // Take the advisory lock BEFORE the ownership check so a concurrent
    // route delete can't slip past loadTenantRoute and then fire a raw
    // FK violation during INSERT. loadTenantRoute reads via the
    // transaction so it sees the same snapshot as the insert.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_ID})`);
    const route = await loadTenantRoute(tx, tenantId, routeId);
    const hostnameRegex = buildHostnameRegexFromHostname(route.hostname);

    const countRows = await tx
      .select({ enabled: sql<number>`count(*)::int` })
      .from(wafRuleExclusions)
      .where(eq(wafRuleExclusions.disabled, false));
    const enabledCount = Number(countRows[0]?.enabled ?? 0);
    if (enabledCount >= MAX_ENABLED) {
      throw new WafRuleExclusionError(
        'OVER_CAPACITY',
        `cannot create more than ${MAX_ENABLED} enabled exclusions`,
      );
    }

    const dupes = await tx
      .select({ id: wafRuleExclusions.id })
      .from(wafRuleExclusions)
      .where(
        and(
          eq(wafRuleExclusions.ruleId, input.ruleId),
          eq(wafRuleExclusions.hostnameRegex, hostnameRegex),
          eq(wafRuleExclusions.scope, input.scope),
          eq(wafRuleExclusions.disabled, false),
        ),
      )
      .limit(1);
    if (dupes.length > 0) {
      throw new WafRuleExclusionError(
        'DUPLICATE',
        `an enabled exclusion already exists for rule ${input.ruleId} on ${route.hostname} (${input.scope})`,
      );
    }

    const id = randomUUID();
    const now = new Date();
    await tx.insert(wafRuleExclusions).values({
      id,
      ruleId: input.ruleId,
      hostnameRegex,
      scope: input.scope,
      reason: input.reason,
      createdBy,
      createdAt: now,
      updatedAt: now,
      disabled: false,
      tenantId,
      routeId,
    });

    const [row] = await tx.select().from(wafRuleExclusions).where(eq(wafRuleExclusions.id, id));
    return rowToContract(row!);
  });
};

/**
 * Delete a tenant-scoped exclusion. Requires the row to be tenant-owned
 * AND the tenant_id + route_id match the path. Returns NOT_TENANT_OWNED
 * if the row exists but doesn't belong to (tenant, route) — distinct
 * from NOT_FOUND so the route can map that to 403 vs 404. Admin-owned
 * rows (tenant_id IS NULL) are never reachable from this path.
 */
export const deleteExclusionForTenantRoute = async (
  db: Db,
  tenantId: string,
  routeId: string,
  id: string,
): Promise<void> => {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_ID})`);
    // Ownership check inside the same transaction as the delete so a
    // concurrent route delete + admin row create can't race past the
    // pairing check. tx is passed through (loadTenantRoute accepts a Db
    // alias which includes the tx type).
    await loadTenantRoute(tx, tenantId, routeId);
    const [row] = await tx
      .select({
        id: wafRuleExclusions.id,
        tenantId: wafRuleExclusions.tenantId,
        routeId: wafRuleExclusions.routeId,
      })
      .from(wafRuleExclusions)
      .where(eq(wafRuleExclusions.id, id))
      .limit(1);
    if (!row) {
      throw new WafRuleExclusionError('NOT_FOUND', `exclusion ${id} not found`);
    }
    if (row.tenantId !== tenantId || row.routeId !== routeId) {
      throw new WafRuleExclusionError(
        'NOT_TENANT_OWNED',
        `exclusion ${id} is not owned by tenant ${tenantId} route ${routeId}`,
      );
    }
    await tx.delete(wafRuleExclusions).where(eq(wafRuleExclusions.id, id));
  });
};
