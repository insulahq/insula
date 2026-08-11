/**
 * Ingress route service.
 *
 * Manages per-hostname routing with CNAME-chain architecture.
 * Each route generates: hostname → {slug}.ingress.platform.net → node → IP
 */

import { eq, and } from 'drizzle-orm';
import { ingressRoutes, domains, platformSettings, dnsRecords, deployments, catalogEntries, privateWorkers } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { syncRecordToProviders } from '../dns-records/service.js';
import { resolveIngressBackend, NotIngressableError } from '../domains/k8s-ingress.js';
import type { Database } from '../../db/index.js';

// ─── Platform Ingress Settings ──────────────────────────────────────────────

const ENV_INGRESS_BASE_DOMAIN = process.env.INGRESS_BASE_DOMAIN;
const ENV_INGRESS_DEFAULT_IPV4 = process.env.INGRESS_DEFAULT_IPV4;

async function getSetting(db: Database, key: string): Promise<string | null> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, key));
  return row?.value ?? null;
}

/** Remove a setting so its resolution falls through to the next source. */
async function clearSetting(db: Database, key: string): Promise<void> {
  await db.delete(platformSettings).where(eq(platformSettings.key, key));
}

async function setSetting(db: Database, key: string, value: string): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
}

/**
 * Resolve the effective ingress addresses.
 *
 * Precedence — operator intent always wins:
 *   1. `ingress_default_ipv4/ipv6`     explicit operator override
 *   2. `ingress_discovered_ipv4/ipv6`  live cluster state, maintained by the
 *                                      ingress-nodes reconciler
 *   3. INGRESS_DEFAULT_IPV4 env        deployment fallback
 *   4. 127.0.0.1                       local-DinD convenience
 *
 * The override is kept separate from the discovered value rather than having
 * the reconciler write the same key, because an operator may deliberately
 * point tenant apexes at a load-balancer VIP or anycast address that is not
 * any node's ExternalIP. A reconciler that owned one key would quietly undo
 * that every tick.
 *
 * `ingressSource` is returned so the UI can say which of these is in effect —
 * "why is my apex pointing there?" should be answerable without reading code.
 */
export type IngressAddressSource = 'override' | 'discovered' | 'env' | 'fallback';

export async function getIngressSettings(db: Database) {
  const baseDomain = await getSetting(db, 'ingress_base_domain');
  const ipv4 = await getSetting(db, 'ingress_default_ipv4');
  const ipv6 = await getSetting(db, 'ingress_default_ipv6');
  const discoveredIpv4 = await getSetting(db, 'ingress_discovered_ipv4');
  const discoveredIpv6 = await getSetting(db, 'ingress_discovered_ipv6');
  const discoveredNodes = await getSetting(db, 'ingress_discovered_nodes');

  const hasOverride = Boolean(ipv4 || ipv6);
  const hasDiscovered = Boolean(discoveredIpv4 || discoveredIpv6);
  const ingressSource: IngressAddressSource = hasOverride
    ? 'override'
    : hasDiscovered
      ? 'discovered'
      : ENV_INGRESS_DEFAULT_IPV4
        ? 'env'
        : 'fallback';

  return {
    ingressBaseDomain: baseDomain ?? ENV_INGRESS_BASE_DOMAIN ?? 'ingress.localhost',
    ingressDefaultIpv4:
      ipv4 ?? (hasOverride ? null : discoveredIpv4) ?? ENV_INGRESS_DEFAULT_IPV4 ?? '127.0.0.1',
    ingressDefaultIpv6: ipv6 ?? (hasOverride ? null : discoveredIpv6) ?? null,
    ingressSource,
    /** Nodes that produced the discovered set, for operator-facing provenance. */
    ingressDiscoveredNodes: discoveredNodes ? discoveredNodes.split(',').filter(Boolean) : [],
  };
}

/**
 * Split an ingress-IP setting into individual addresses.
 *
 * The setting is comma/whitespace separated so a multi-node cluster can
 * publish every ingress-enabled address and have apex records round-robin
 * across them.
 *
 * Loopback is dropped deliberately: `getIngressSettings()` falls back to
 * `127.0.0.1` when nothing is configured (a convenience for local DinD), and
 * without this filter that fallback gets written verbatim into a customer's
 * public zone — an apex A record pointing at the visitor's own machine.
 */
export function parseIngressIps(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const parts = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((ip) => !/^127\./.test(ip) && ip !== '::1' && ip !== '0.0.0.0' && ip !== '::');
  return Array.from(new Set(parts));
}

export async function updateIngressSettings(
  db: Database,
  input: { ingressBaseDomain?: string; ingressDefaultIpv4?: string; ingressDefaultIpv6?: string | null },
) {
  if (input.ingressBaseDomain !== undefined) {
    await setSetting(db, 'ingress_base_domain', input.ingressBaseDomain);
  }
  // An empty value CLEARS the override and hands the field back to node
  // discovery. Without this there is no way back to automatic once a value has
  // been saved once — and because the settings form is pre-filled with the
  // EFFECTIVE address, saving an unrelated field would otherwise silently
  // freeze whatever was discovered at that moment into a permanent override.
  if (input.ingressDefaultIpv4 !== undefined) {
    const v = input.ingressDefaultIpv4.trim();
    if (v) await setSetting(db, 'ingress_default_ipv4', v);
    else await clearSetting(db, 'ingress_default_ipv4');
  }
  if (input.ingressDefaultIpv6 !== undefined) {
    const v = (input.ingressDefaultIpv6 ?? '').trim();
    if (v) await setSetting(db, 'ingress_default_ipv6', v);
    else await clearSetting(db, 'ingress_default_ipv6');
  }
  return getIngressSettings(db);
}

// ─── CNAME Slug Generation ──────────────────────────────────────────────────

/**
 * Generate a DNS-safe CNAME slug from a hostname.
 * e.g., "blog.example.com" → "blog-example-com"
 */
export function hostnameToSlug(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63); // DNS label max length
}

/**
 * Detect if a hostname is the zone apex (same as domain name).
 */
export function isApexHostname(hostname: string, domainName: string): boolean {
  return hostname.toLowerCase() === domainName.toLowerCase();
}

// ─── www Companion Hostname ──────────────────────────────────────────────────

/**
 * Compute the companion hostname for a www redirect, if any.
 * Returns null when no companion is needed.
 */
export function getWwwCompanionHostname(
  hostname: string,
  wwwRedirect: string | null | undefined,
): string | null {
  if (wwwRedirect === 'add-www' && !hostname.startsWith('www.')) {
    return `www.${hostname}`;
  }
  if (wwwRedirect === 'remove-www' && !hostname.startsWith('www.')) {
    // The route is test-ingress.local with remove-www
    // Need www.test-ingress.local to resolve so the redirect can happen
    return `www.${hostname}`;
  }
  if (wwwRedirect === 'remove-www' && hostname.startsWith('www.')) {
    return hostname.replace(/^www\./, '');
  }
  return null;
}

// ─── Route CRUD ─────────────────────────────────────────────────────────────

export async function createRoute(
  db: Database,
  domainId: string,
  tenantId: string,
  hostname: string,
  deploymentId?: string | null,
  path?: string,
  privateWorkerId?: string | null,
  servicePort?: number | null,
) {
  // Polymorphic target validation (migration 0076 + 0085).
  //
  // Routes may be created in a "draft" state with NEITHER target bound
  // (operator wires up hostname / TLS / WAF first, then assigns a
  // deployment or private worker later via PATCH). The DB constraint
  // `ingress_routes_target_xor` (relaxed in migration 0085) enforces
  // that AT MOST ONE of (deployment_id, private_worker_id) is set —
  // both-null is allowed, both-set is forbidden. The Ingress reconciler
  // skips routes whose target doesn't resolve yet (k8s-ingress.ts:306).
  if (deploymentId && privateWorkerId) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'A route can target a deployment or a private_worker, not both',
      400,
    );
  }
  // Normalize path — default to "/", ensure leading and trailing slashes
  let routePath = path && path.trim() !== '' ? path.trim() : '/';
  if (!routePath.startsWith('/')) routePath = `/${routePath}`;
  if (routePath !== '/' && !routePath.endsWith('/')) routePath = `${routePath}/`;
  if (routePath.length > 255) {
    throw new ApiError('VALIDATION_ERROR', 'Path must be 255 characters or less', 400);
  }
  if (routePath.includes('..')) {
    throw new ApiError('VALIDATION_ERROR', 'Path must not contain ".."', 400);
  }
  if (routePath.length > 255) {
    throw new ApiError('VALIDATION_ERROR', 'Path must be 255 characters or fewer', 400);
  }

  // Verify domain ownership
  const [domain] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.tenantId, tenantId)));

  if (!domain) {
    throw new ApiError('DOMAIN_NOT_FOUND', `Domain '${domainId}' not found`, 404);
  }

  // Validate hostname belongs to domain
  // hostname must be either:
  // - the domain name itself (apex): "example.com"
  // - a subdomain: "*.example.com" where * is non-empty
  if (hostname !== domain.domainName && !hostname.endsWith(`.${domain.domainName}`)) {
    throw new ApiError(
      'INVALID_HOSTNAME',
      `Hostname '${hostname}' must be '${domain.domainName}' or a subdomain of it (e.g., www.${domain.domainName})`,
      400,
    );
  }

  // Guard: if routing to a deployment, the deployment's catalog entry must
  // be ingressable. DB/service tiers (mariadb, redis, etc.) and apps with
  // no ingress port would produce a broken Ingress rule that never
  // resolves — catch it at creation time with a clear error.
  if (deploymentId) {
    const [dep] = await db.select().from(deployments).where(
      and(eq(deployments.id, deploymentId), eq(deployments.tenantId, tenantId)),
    );
    if (!dep) {
      throw new ApiError('DEPLOYMENT_NOT_FOUND', `Deployment '${deploymentId}' not found`, 404);
    }
    // Custom deployments have catalogEntryId=null; the existing
    // `if (entry)` branch below skips them. PR-2 wires custom
    // deployments to ingress routes through a non-catalog-entry path.
    const [entry] = await db.select().from(catalogEntries).where(eq(catalogEntries.id, dep.catalogEntryId ?? ''));
    if (entry) {
      try {
        resolveIngressBackend(entry, dep.name);
      } catch (err) {
        if (err instanceof NotIngressableError) {
          throw new ApiError(
            'CANNOT_EXPOSE_DEPLOYMENT',
            err.message,
            400,
            { deploymentId, catalogType: entry.type },
          );
        }
        throw err;
      }
    }
  }

  // Validate private_worker target (must exist + belong to this tenant + active).
  if (privateWorkerId) {
    const [pw] = await db
      .select()
      .from(privateWorkers)
      .where(and(eq(privateWorkers.id, privateWorkerId), eq(privateWorkers.tenantId, tenantId)));
    if (!pw) {
      throw new ApiError(
        'PRIVATE_WORKER_NOT_FOUND',
        `Private worker '${privateWorkerId}' not found for this tenant`,
        404,
      );
    }
    if (pw.status === 'revoked') {
      throw new ApiError(
        'PRIVATE_WORKER_REVOKED',
        `Private worker '${pw.name}' has been revoked; rotate or recreate before routing traffic to it`,
        400,
      );
    }
  }

  // Check for duplicate hostname+path combination
  const [existing] = await db
    .select({ id: ingressRoutes.id })
    .from(ingressRoutes)
    .where(and(
      eq(ingressRoutes.hostname, hostname),
      eq(ingressRoutes.path, routePath),
      eq(ingressRoutes.domainId, domainId),
    ));

  if (existing) {
    throw new ApiError(
      'DUPLICATE_ROUTE',
      `Route for '${hostname}${routePath === '/' ? '' : routePath}' already exists`,
      409,
    );
  }

  const settings = await getIngressSettings(db);
  const slug = hostnameToSlug(hostname);
  const ingressCname = `${slug}.${settings.ingressBaseDomain}`;
  const apex = isApexHostname(hostname, domain.domainName);

  const id = crypto.randomUUID();
  const targetType: 'deployment' | 'private_worker' = privateWorkerId ? 'private_worker' : 'deployment';
  await db.insert(ingressRoutes).values({
    id,
    domainId,
    hostname,
    path: routePath,
    targetType,
    deploymentId: privateWorkerId ? null : (deploymentId ?? null),
    privateWorkerId: privateWorkerId ?? null,
    ingressCname,
    nodeHostname: null, // uses default node
    isApex: apex ? 1 : 0,
    tlsMode: 'auto',
    status: 'active',
    servicePort: servicePort ?? null,
  });

  // Auto-create DNS records for PRIMARY domains
  if (domain.dnsMode === 'primary') {
    const recordName = apex ? '@' : hostname.replace(`.${domain.domainName}`, '');
    try {
      if (apex) {
        // A zone apex cannot hold a CNAME (RFC 1034), so it must carry
        // address records. Emit one per configured ingress IP: a multi-node
        // cluster round-robins across all ingress-enabled addresses instead
        // of pinning every tenant apex to whichever single IP happened to be
        // in the setting.
        const v4 = parseIngressIps(settings.ingressDefaultIpv4);
        const v6 = parseIngressIps(await getSetting(db, 'ingress_default_ipv6'));
        if (v4.length === 0 && v6.length === 0) {
          console.warn(
            `[ingress-dns] No usable ingress IP configured (ingress_default_ipv4/ipv6) — ` +
              `apex records for '${hostname}' were NOT created. Set them in Settings → Ingress.`,
          );
        }
        for (const ip of v4) {
          await syncRecordToProviders(db, domain.domainName, 'create', {
            type: 'A', name: recordName, content: ip, ttl: 300,
          });
        }
        for (const ip of v6) {
          await syncRecordToProviders(db, domain.domainName, 'create', {
            type: 'AAAA', name: recordName, content: ip, ttl: 300,
          });
        }
      } else {
        // Subdomain → CNAME into the platform's ingress chain. This is the
        // entire point of `<slug>.ingress.<apex>`: when ingress node
        // membership changes, ONE centrally-owned RRset changes, instead of
        // rewriting an A record inside every tenant zone. The previous code
        // wrote an A record here ("simpler, no CNAME limitations"), which is
        // what made adding a node a manual per-domain migration.
        await syncRecordToProviders(db, domain.domainName, 'create', {
          type: 'CNAME',
          name: recordName,
          content: ingressCname.endsWith('.') ? ingressCname : `${ingressCname}.`,
          ttl: 300,
        });
      }
    } catch (err) {
      // Non-blocking (a DNS outage must not fail route creation) but never
      // silent — the previous bare `catch {}` is why primary-mode zones sat
      // there with no address records and nothing said a word.
      console.warn(
        `[ingress-dns] Failed to create DNS records for '${hostname}':`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Auto-resolve .local domains: create A record pointing to ingress IP
  // This enables local DinD testing without external DNS
  if (hostname.endsWith('.local') && domain.dnsMode !== 'primary') {
    try {
      const recordName = apex ? '@' : hostname.replace(`.${domain.domainName}`, '');
      await syncRecordToProviders(db, domain.domainName, 'create', {
        type: 'A',
        name: recordName,
        content: settings.ingressDefaultIpv4,
        ttl: 300,
      });
    } catch {
      // Non-blocking
    }
  }

  const [created] = await db.select().from(ingressRoutes).where(eq(ingressRoutes.id, id));
  return created;
}

export async function updateRoute(
  db: Database,
  routeId: string,
  input: {
    deploymentId?: string | null;
    privateWorkerId?: string | null;
    tlsMode?: string;
    nodeHostname?: string | null;
    servicePort?: number | null;
  },
  // Required when privateWorkerId is being set — we re-verify the worker
  // belongs to this tenant to defend against route-id enumeration that
  // would otherwise let tenant A repoint tenant B's route at A's worker.
  tenantId?: string,
) {
  const [route] = await db.select().from(ingressRoutes).where(eq(ingressRoutes.id, routeId));
  if (!route) {
    throw new ApiError('ROUTE_NOT_FOUND', `Ingress route '${routeId}' not found`, 404);
  }

  // Polymorphic target swap (migration 0076). If either deploymentId or
  // privateWorkerId is set, clear the other side and flip target_type.
  // Both undefined means "don't touch the target."
  if (input.deploymentId && input.privateWorkerId) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'A route can target a deployment or a private_worker, not both',
      400,
    );
  }

  // Cross-tenant guard for the new private-worker target. Without this,
  // a caller authenticated as tenant A could PATCH tenant B's route to
  // target a worker in A's namespace. We re-verify ownership here using
  // the same shape as createRoute.
  if (input.privateWorkerId) {
    if (!tenantId) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'tenantId is required when setting private_worker_id on an ingress route',
        400,
      );
    }
    const [pw] = await db
      .select({ id: privateWorkers.id, status: privateWorkers.status })
      .from(privateWorkers)
      .where(and(eq(privateWorkers.id, input.privateWorkerId), eq(privateWorkers.tenantId, tenantId)));
    if (!pw) {
      throw new ApiError(
        'PRIVATE_WORKER_NOT_FOUND',
        `Private worker '${input.privateWorkerId}' not found for this tenant`,
        404,
      );
    }
    if (pw.status === 'revoked') {
      throw new ApiError(
        'PRIVATE_WORKER_REVOKED',
        'Cannot point an ingress route at a revoked private worker',
        400,
      );
    }
  }

  const updateValues: Record<string, unknown> = {};
  if (input.deploymentId !== undefined) {
    updateValues.deploymentId = input.deploymentId;
    if (input.deploymentId) {
      updateValues.targetType = 'deployment';
      updateValues.privateWorkerId = null;
    }
  }
  if (input.privateWorkerId !== undefined) {
    updateValues.privateWorkerId = input.privateWorkerId;
    if (input.privateWorkerId) {
      updateValues.targetType = 'private_worker';
      updateValues.deploymentId = null;
    }
  }
  if (input.tlsMode !== undefined) updateValues.tlsMode = input.tlsMode;
  if (input.nodeHostname !== undefined) updateValues.nodeHostname = input.nodeHostname;
  if (input.servicePort !== undefined) updateValues.servicePort = input.servicePort;

  if (Object.keys(updateValues).length > 0) {
    await db.update(ingressRoutes).set(updateValues).where(eq(ingressRoutes.id, routeId));
  }

  const [updated] = await db.select().from(ingressRoutes).where(eq(ingressRoutes.id, routeId));
  return updated;
}

export async function deleteRoute(db: Database, routeId: string) {
  const [route] = await db.select().from(ingressRoutes).where(eq(ingressRoutes.id, routeId));
  if (!route) {
    throw new ApiError('ROUTE_NOT_FOUND', `Ingress route '${routeId}' not found`, 404);
  }
  await db.delete(ingressRoutes).where(eq(ingressRoutes.id, routeId));

  // Auto-delete DNS records that were provisioned for this route
  try {
    await autoDeleteRouteDns(db, route.domainId, route.hostname);
  } catch {
    // Non-blocking — DNS cleanup failure shouldn't block route deletion
  }

  // Also delete the companion DNS record if www redirect was active
  const companionHostname = getWwwCompanionHostname(route.hostname, route.wwwRedirect);
  if (companionHostname) {
    try {
      await autoDeleteRouteDns(db, route.domainId, companionHostname);
    } catch {
      // Non-blocking
    }
  }
}

export async function listRoutesForDomain(db: Database, domainId: string) {
  return db.select().from(ingressRoutes).where(eq(ingressRoutes.domainId, domainId));
}

export async function listRoutesForTenant(db: Database, tenantId: string) {
  // Join routes with domains to filter by tenant
  const tenantDomains = await db.select({ id: domains.id }).from(domains).where(eq(domains.tenantId, tenantId));
  const domainIds = tenantDomains.map(d => d.id);
  if (domainIds.length === 0) return [];

  const allRoutes = await db.select().from(ingressRoutes);
  return allRoutes.filter(r => domainIds.includes(r.domainId));
}

// ─── Auto-DNS Provisioning ───────────────────────────────────────────────────

/**
 * Auto-provision DNS records for a hostname under a domain.
 *
 * For primary-mode domains this creates A/AAAA records (both apex and
 * subdomain) via the configured DNS providers. Non-blocking — failures
 * are swallowed so callers are never disrupted.
 */
export async function autoProvisionRouteDns(
  db: Database,
  domainId: string,
  hostname: string,
): Promise<void> {
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domain || domain.dnsMode !== 'primary') return;

  const settings = await getIngressSettings(db);
  const apex = isApexHostname(hostname, domain.domainName);

  const recordName = apex ? '@' : hostname.replace(`.${domain.domainName}`, '');

  try {
    // Always create A record (simpler, no CNAME limitations at apex or subdomain)
    await syncRecordToProviders(db, domain.domainName, 'create', {
      type: 'A',
      name: recordName,
      content: settings.ingressDefaultIpv4,
      ttl: 300,
    });
    const ipv6 = await getSetting(db, 'ingress_default_ipv6');
    if (ipv6) {
      await syncRecordToProviders(db, domain.domainName, 'create', {
        type: 'AAAA',
        name: recordName,
        content: ipv6,
        ttl: 300,
      });
    }
  } catch {
    // Non-blocking — DNS provisioning failure should not break callers
  }
}

// ─── Auto-DNS Cleanup ───────────────────────────────────────────────────────

/**
 * Remove DNS records that were auto-provisioned when the route was created.
 *
 * For primary-mode domains this deletes the A/AAAA records from both the
 * external DNS provider and the local dns_records table.
 */
export async function autoDeleteRouteDns(
  db: Database,
  domainId: string,
  hostname: string,
): Promise<void> {
  // 1. Check if domain is primary mode
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domain || domain.dnsMode !== 'primary') return;

  // 2. Determine the record name relative to the domain
  //    hostname: "app.example.com", domainName: "example.com" → "app"
  //    hostname: "example.com",     domainName: "example.com" → "@" (apex)
  const apex = hostname.toLowerCase() === domain.domainName.toLowerCase();
  const recordName = apex
    ? '@'
    : hostname.replace(`.${domain.domainName}`, '');

  // 3. Delete from external DNS provider(s)
  const settings = await getIngressSettings(db);

  // All routes (apex and subdomain) now use A records
  await syncRecordToProviders(db, domain.domainName, 'delete', {
    type: 'A',
    name: recordName,
    content: settings.ingressDefaultIpv4,
    id: 'auto', // provider uses name|type|content composite key
  }, domainId);

  const ipv6 = await getSetting(db, 'ingress_default_ipv6');
  if (ipv6) {
    await syncRecordToProviders(db, domain.domainName, 'delete', {
      type: 'AAAA',
      name: recordName,
      content: ipv6,
      id: 'auto',
    }, domainId);
  }

  // 4. Remove matching records from local dns_records table
  const localRecords = await db
    .select()
    .from(dnsRecords)
    .where(and(eq(dnsRecords.domainId, domainId), eq(dnsRecords.recordName, recordName)));

  for (const rec of localRecords) {
    // Only delete records that match what auto-provisioning would have created (A/AAAA)
    if (rec.recordType === 'A' || rec.recordType === 'AAAA') {
      await db.delete(dnsRecords).where(eq(dnsRecords.id, rec.id));
    }
  }
}
