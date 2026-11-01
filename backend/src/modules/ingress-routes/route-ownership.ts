/**
 * A tenant route's ownership check, for every handler that reads or changes
 * something under `/tenants/:tenantId/routes/:routeId` or
 * `/tenants/:tenantId/domains/:domainId/routes`.
 *
 * `requireTenantAccess` proves the caller may act for `:tenantId`. It says
 * nothing about `:routeId`: a handler that queried by the route id alone
 * served another tenant's data to anyone who put that tenant's route id under
 * their own tenant id. The route's domain must belong to the tenant.
 */
import { and, eq } from 'drizzle-orm';
import { domains, ingressRoutes } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';

/** The route, when its domain belongs to the tenant; 404 ROUTE_NOT_FOUND otherwise (also when it does not exist). */
export async function assertRouteOwnedByTenant(
  db: Database,
  routeId: string,
  tenantId: string,
): Promise<typeof ingressRoutes.$inferSelect> {
  const [route] = await db.select().from(ingressRoutes).where(eq(ingressRoutes.id, routeId));
  if (!route) {
    throw new ApiError('ROUTE_NOT_FOUND', `Ingress route '${routeId}' not found`, 404);
  }
  const [domain] = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.id, route.domainId), eq(domains.tenantId, tenantId)));
  if (!domain) {
    throw new ApiError('ROUTE_NOT_FOUND', `Ingress route '${routeId}' not found for tenant`, 404);
  }
  return route;
}

/** 404 DOMAIN_NOT_FOUND unless the domain belongs to the tenant (also when it does not exist). */
export async function assertDomainOwnedByTenant(db: Database, domainId: string, tenantId: string): Promise<void> {
  const [domain] = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.tenantId, tenantId)));
  if (!domain) {
    throw new ApiError('DOMAIN_NOT_FOUND', `Domain '${domainId}' not found`, 404);
  }
}

/**
 * The route, for handlers under `/tenants/:tenantId/domains/:domainId/routes/:routeId`:
 * it must belong to the tenant AND sit under the domain the URL names.
 */
export async function assertRouteInTenantDomain(
  db: Database,
  routeId: string,
  domainId: string,
  tenantId: string,
): Promise<typeof ingressRoutes.$inferSelect> {
  const route = await assertRouteOwnedByTenant(db, routeId, tenantId);
  if (route.domainId !== domainId) {
    throw new ApiError('ROUTE_NOT_FOUND', `Ingress route '${routeId}' not found for domain`, 404);
  }
  return route;
}
