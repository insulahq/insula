/**
 * WAF trusted IPs of a tenant route — CRUD for the tenant, the per-route
 * lists the reconciler renders, and the lookup the WAF log scraper marks
 * events with. Contract and limits: @insula/api-contracts waf-trusted-ips.ts.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  isWildcardRouteHostname,
  WAF_TRUSTED_IPS_PER_ROUTE_MAX,
  type CreateWafTrustedIpRequest,
  type WafTrustedIp,
} from '@insula/api-contracts';
import { domains, ingressRoutes, wafTrustedIps } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { canonicalTrustedIp } from './ip-value.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NodePgDatabase<any>;

/** Serialises a route's create against its count check ('waf_trip' as bigint). */
const ADVISORY_LOCK_ID = 0x77616674_72697000n;

const toContract = (row: typeof wafTrustedIps.$inferSelect): WafTrustedIp => ({
  id: row.id,
  routeId: row.routeId,
  value: row.value,
  note: row.note ?? null,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});

/** The route's hostname; 404 ROUTE_NOT_FOUND unless its domain belongs to the tenant (also when it does not exist). */
async function assertOwnedRoute(db: Db, tenantId: string, routeId: string): Promise<{ hostname: string }> {
  const [row] = await db
    .select({ hostname: ingressRoutes.hostname })
    .from(ingressRoutes)
    .innerJoin(domains, eq(domains.id, ingressRoutes.domainId))
    .where(and(eq(ingressRoutes.id, routeId), eq(domains.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new ApiError('ROUTE_NOT_FOUND', `Ingress route '${routeId}' not found`, 404);
  return row;
}

export async function listTrustedIpsForRoute(db: Db, tenantId: string, routeId: string): Promise<WafTrustedIp[]> {
  await assertOwnedRoute(db, tenantId, routeId);
  const rows = await db
    .select()
    .from(wafTrustedIps)
    .where(and(eq(wafTrustedIps.routeId, routeId), eq(wafTrustedIps.tenantId, tenantId)))
    .orderBy(asc(wafTrustedIps.createdAt), asc(wafTrustedIps.id));
  return rows.map(toContract);
}

export async function createTrustedIpForRoute(
  db: Db,
  tenantId: string,
  routeId: string,
  input: CreateWafTrustedIpRequest,
  createdBy: string,
): Promise<WafTrustedIp> {
  const parsed = canonicalTrustedIp(input.value);
  if (!parsed.ok) throw new ApiError('INVALID_TRUSTED_IP', parsed.message, 400);
  const note = input.note?.replace(/[\r\n]+/g, ' ').trim() || null;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_ID})`);
    const route = await assertOwnedRoute(tx, tenantId, routeId);
    // No WAF host regex covers only what a wildcard route serves: it would
    // also cover a sibling host that has its own route (contracts
    // buildHostnameRegexForRoute). The renderer skips one too.
    if (isWildcardRouteHostname(route.hostname)) {
      throw new ApiError(
        'WILDCARD_ROUTE',
        `Trusted IPs cannot be set on the wildcard route ${route.hostname} — add them to a route with an exact hostname`,
        400,
      );
    }
    const existing = await tx
      .select({ id: wafTrustedIps.id, value: wafTrustedIps.value })
      .from(wafTrustedIps)
      .where(eq(wafTrustedIps.routeId, routeId));
    if (existing.some((e) => e.value === parsed.value)) {
      throw new ApiError('DUPLICATE', `${parsed.value} is already trusted on this route`, 409);
    }
    if (existing.length >= WAF_TRUSTED_IPS_PER_ROUTE_MAX) {
      throw new ApiError(
        'OVER_CAPACITY',
        `A route can trust at most ${WAF_TRUSTED_IPS_PER_ROUTE_MAX} addresses or networks — remove one first`,
        409,
      );
    }
    const id = randomUUID();
    await tx.insert(wafTrustedIps).values({
      id, tenantId, routeId, value: parsed.value, note, createdBy, createdAt: new Date(),
    });
    const [row] = await tx.select().from(wafTrustedIps).where(eq(wafTrustedIps.id, id));
    return toContract(row!);
  });
}

export async function deleteTrustedIpForRoute(db: Db, tenantId: string, routeId: string, id: string): Promise<void> {
  await assertOwnedRoute(db, tenantId, routeId);
  const deleted = await db
    .delete(wafTrustedIps)
    .where(and(eq(wafTrustedIps.id, id), eq(wafTrustedIps.routeId, routeId), eq(wafTrustedIps.tenantId, tenantId)))
    .returning({ id: wafTrustedIps.id });
  if (deleted.length === 0) throw new ApiError('NOT_FOUND', `Trusted IP '${id}' not found`, 404);
}

/** One route's trusted values, with the hostname the rule is scoped to. */
export interface TrustedIpGroup {
  readonly routeId: string;
  readonly hostname: string;
  readonly values: readonly string[];
}

/**
 * Every route's list for the renderer, in a stable order (hostname, route id,
 * value) so the rendered file — and the hash that rolls the WAF — only
 * changes when a list does. The hostname is the route's CURRENT one, and only
 * routes whose domain still belongs to the entry's tenant are rendered.
 */
export async function listTrustedIpsForReconciler(db: Db): Promise<TrustedIpGroup[]> {
  const rows = await db
    .select({ routeId: wafTrustedIps.routeId, hostname: ingressRoutes.hostname, value: wafTrustedIps.value })
    .from(wafTrustedIps)
    .innerJoin(ingressRoutes, eq(ingressRoutes.id, wafTrustedIps.routeId))
    .innerJoin(domains, and(eq(domains.id, ingressRoutes.domainId), eq(domains.tenantId, wafTrustedIps.tenantId)))
    .orderBy(asc(ingressRoutes.hostname), asc(wafTrustedIps.routeId), asc(wafTrustedIps.value));
  const groups: Array<{ routeId: string; hostname: string; values: string[] }> = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.routeId === r.routeId) last.values.push(r.value);
    else groups.push({ routeId: r.routeId, hostname: r.hostname, values: [r.value] });
  }
  return groups;
}

/** The stored values of each of `routeIds` that has any. */
export async function trustedIpsByRoute(db: Db, routeIds: ReadonlyArray<string>): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (routeIds.length === 0) return out;
  const rows = await db
    .select({ routeId: wafTrustedIps.routeId, value: wafTrustedIps.value })
    .from(wafTrustedIps)
    .where(inArray(wafTrustedIps.routeId, [...routeIds]));
  for (const r of rows) out.set(r.routeId, [...(out.get(r.routeId) ?? []), r.value]);
  return out;
}
