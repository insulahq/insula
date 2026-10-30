/**
 * Per-route sign-in policy (ingress_auth_configs).
 *
 * A route config references one of the tenant's providers. Writes take either
 * `providerId` (an existing provider) or inline issuer + client credentials,
 * which CREATE a provider — they never edit one, since other routes may share
 * it. One oauth2-proxy serves every route of a tenant and holds one provider,
 * so all enabled routes of a tenant must use the same provider; a second one is
 * refused (OIDC_PROVIDER_CONFLICT) instead of silently signing in against the
 * first.
 */

import { eq, and, ne, inArray, sql } from 'drizzle-orm';
import {
  ingressAuthConfigs,
  ingressRoutes,
  domains,
  tenants,
  tenantOauth2ProxyState,
  tenantOidcProviders,
} from '../../db/schema.js';
import { encrypt, decrypt } from '../oidc/crypto.js';
import { ApiError } from '../../shared/errors.js';
import { createProvider } from './providers-service.js';
import { buildCallbackUrl, canProtectHost, servedHost } from './hosts.js';
import type { Database } from '../../db/index.js';
import type {
  TenantOidcProvider,
  IngressAuthConfig,
  IngressClaimRule,
} from '../../db/schema.js';
import {
  ingressAuthConfigSchema,
  type IngressAuthConfigInput,
  type IngressAuthConfigPatch,
  type IngressAuthConfigResponse,
} from '@insula/api-contracts';

export type { IngressAuthConfigInput, IngressAuthConfigPatch, IngressAuthConfigResponse };

export interface IngressAuthServiceContext {
  readonly encryptionKey: string;
}

export { buildCallbackUrl };

function buildResponse(
  cfg: IngressAuthConfig,
  provider: TenantOidcProvider,
  hostname: string,
  wwwRedirect: string | null,
): IngressAuthConfigResponse {
  return {
    enabled: cfg.enabled,
    providerId: provider.id,
    providerName: provider.name,
    issuerUrl: provider.issuerUrl,
    clientId: provider.oauthClientId,
    clientSecretSet: provider.oauthClientSecretEncrypted.length > 0,
    usePkce: provider.usePkce,
    scopes: provider.defaultScopes,
    postLoginRedirectUrl: cfg.postLoginRedirectUrl ?? null,
    allowedEmails: cfg.allowedEmails ?? null,
    allowedEmailDomains: cfg.allowedEmailDomains ?? null,
    allowedGroups: cfg.allowedGroups ?? null,
    claimRules: (cfg.claimRules as IngressAuthConfigResponse['claimRules']) ?? null,
    passAuthorizationHeader: cfg.passAuthorizationHeader,
    passAccessToken: cfg.passAccessToken,
    passIdToken: cfg.passIdToken,
    passUserHeaders: cfg.passUserHeaders,
    setXauthrequest: cfg.setXauthrequest,
    cookieDomain: cfg.cookieDomain ?? null,
    cookieRefreshSeconds: cfg.cookieRefreshSeconds,
    cookieExpireSeconds: cfg.cookieExpireSeconds,
    callbackUrl: buildCallbackUrl(servedHost(hostname, wwwRedirect)),
    lastError: cfg.lastError ?? null,
    lastReconciledAt: cfg.lastReconciledAt ? cfg.lastReconciledAt.toISOString() : null,
  };
}

export async function getAuthConfig(
  db: Database,
  ingressRouteId: string,
): Promise<IngressAuthConfigResponse | null> {
  const rows = await db
    .select({
      cfg: ingressAuthConfigs,
      provider: tenantOidcProviders,
      hostname: ingressRoutes.hostname,
      wwwRedirect: ingressRoutes.wwwRedirect,
    })
    .from(ingressAuthConfigs)
    .innerJoin(tenantOidcProviders, eq(tenantOidcProviders.id, ingressAuthConfigs.providerId))
    .innerJoin(ingressRoutes, eq(ingressRoutes.id, ingressAuthConfigs.ingressRouteId))
    .where(eq(ingressAuthConfigs.ingressRouteId, ingressRouteId));
  const row = rows[0];
  if (!row) return null;
  return buildResponse(row.cfg, row.provider, row.hostname, row.wwwRedirect);
}

/** Comma/newline-separated list → trimmed, non-empty entries. Pure. */
export function splitList(value: string | null | undefined): string[] {
  return (value ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

function validationError(code: string, message: string, status = 422): ApiError {
  return new ApiError(code, message, status);
}

/** The saved policy as an input, so a PATCH can be applied on top of it. */
function inputFromRow(cfg: IngressAuthConfig): Omit<IngressAuthConfigInput, 'providerId'> {
  return {
    enabled: cfg.enabled,
    postLoginRedirectUrl: cfg.postLoginRedirectUrl ?? null,
    allowedEmails: cfg.allowedEmails ?? null,
    allowedEmailDomains: cfg.allowedEmailDomains ?? null,
    allowedGroups: cfg.allowedGroups ?? null,
    claimRules: (cfg.claimRules as IngressAuthConfigInput['claimRules']) ?? null,
    passAuthorizationHeader: cfg.passAuthorizationHeader,
    passAccessToken: cfg.passAccessToken,
    passIdToken: cfg.passIdToken,
    passUserHeaders: cfg.passUserHeaders,
    setXauthrequest: cfg.setXauthrequest,
    cookieDomain: cfg.cookieDomain ?? null,
    cookieRefreshSeconds: cfg.cookieRefreshSeconds,
    cookieExpireSeconds: cfg.cookieExpireSeconds,
  };
}

/**
 * PATCH semantics: an omitted field keeps its saved value; a new config gets
 * the defaults. Then the whole result is validated as one policy.
 */
export function mergePatch(existing: IngressAuthConfig | undefined, patch: IngressAuthConfigPatch): IngressAuthConfigInput {
  const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const parsed = ingressAuthConfigSchema.safeParse(existing ? { ...inputFromRow(existing), ...given } : given);
  if (!parsed.success) {
    throw new ApiError(
      'VALIDATION_ERROR',
      parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
      400,
    );
  }
  return parsed.data;
}

/** The tenant's domain names and the hosts its routes serve — what its policy may name. */
async function tenantHosts(db: Database, tenantId: string): Promise<{ domains: string[]; hosts: string[] }> {
  const rows = await db
    .select({ domainName: domains.domainName, hostname: ingressRoutes.hostname, wwwRedirect: ingressRoutes.wwwRedirect })
    .from(domains)
    .leftJoin(ingressRoutes, eq(ingressRoutes.domainId, domains.id))
    .where(eq(domains.tenantId, tenantId));
  const domainNames = [...new Set(rows.map((r) => r.domainName.toLowerCase()))];
  const hosts = [...new Set(rows.filter((r) => r.hostname).flatMap((r) => [r.hostname!.toLowerCase(), servedHost(r.hostname!, r.wwwRedirect)]))];
  return { domains: domainNames, hosts };
}

const within = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** Refuse settings that cannot work, with the reason, before anything is saved. */
function assertUsable(input: IngressAuthConfigInput, host: string, owned: { domains: string[]; hosts: string[] }): void {
  for (const email of splitList(input.allowedEmails)) {
    if (email.split('@').length !== 2 || email.startsWith('@') || email.endsWith('@')) {
      throw validationError('VALIDATION_ERROR', `"${email}" in Allowed emails is not an email address.`);
    }
  }
  for (const domain of splitList(input.allowedEmailDomains)) {
    if (!/^@?([a-z0-9-]+\.)+[a-z0-9-]{2,}$/i.test(domain)) {
      throw validationError('VALIDATION_ERROR', `"${domain}" in Allowed email domains is not a domain.`);
    }
  }
  if (input.cookieDomain) {
    const cd = input.cookieDomain.replace(/^\./, '');
    if (!within(host, cd)) {
      throw validationError(
        'VALIDATION_ERROR',
        `Cookie domain ${input.cookieDomain} does not cover ${host}; the browser would refuse the sign-in cookie.`,
      );
    }
    // A parent shared with other tenants would let their sites set and read
    // this sign-in's cookie.
    if (!owned.domains.some((d) => within(cd, d))) {
      throw validationError('VALIDATION_ERROR', `Cookie domain ${input.cookieDomain} is not within one of this tenant's domains.`);
    }
  }
  if (input.postLoginRedirectUrl) {
    const target = new URL(input.postLoginRedirectUrl).hostname.toLowerCase();
    if (!owned.hosts.includes(target)) {
      throw validationError(
        'VALIDATION_ERROR',
        `After signing in, visitors can only be sent to one of this tenant's own sites, not ${target}.`,
      );
    }
  }
}

/**
 * The provider this write uses: the given one (owned by the tenant), a new one
 * from inline credentials, or the route's current one.
 */
async function resolveProvider(
  db: Database,
  tenantId: string,
  existing: IngressAuthConfig | undefined,
  input: IngressAuthConfigInput,
): Promise<{ id: string; name: string } | { inline: true }> {
  if (input.providerId) {
    const [p] = await db
      .select({ id: tenantOidcProviders.id, name: tenantOidcProviders.name })
      .from(tenantOidcProviders)
      .where(and(eq(tenantOidcProviders.id, input.providerId), eq(tenantOidcProviders.tenantId, tenantId)));
    if (!p) throw new ApiError('NOT_FOUND', 'That provider does not exist for this tenant.', 404);
    return p;
  }
  if (input.issuerUrl || input.clientId || input.clientSecret) {
    if (!input.issuerUrl || !input.clientId || !input.clientSecret) {
      throw validationError(
        'VALIDATION_ERROR',
        'A new provider needs the issuer URL, the client ID and the client secret.',
        400,
      );
    }
    return { inline: true };
  }
  if (existing) {
    const [p] = await db
      .select({ id: tenantOidcProviders.id, name: tenantOidcProviders.name })
      .from(tenantOidcProviders)
      .where(eq(tenantOidcProviders.id, existing.providerId));
    if (p) return p;
  }
  throw validationError('VALIDATION_ERROR', 'Choose a provider, or enter a new one.', 400);
}

/**
 * Every enabled route of a tenant shares one oauth2-proxy and so one provider.
 * Refuse a write that would put a second provider in use.
 */
async function assertSingleProvider(
  db: Database,
  tenantId: string,
  routeId: string,
  providerId: string | null,
): Promise<void> {
  const others = await db
    .select({ providerId: ingressAuthConfigs.providerId, providerName: tenantOidcProviders.name, hostname: ingressRoutes.hostname })
    .from(ingressAuthConfigs)
    .innerJoin(ingressRoutes, eq(ingressRoutes.id, ingressAuthConfigs.ingressRouteId))
    .innerJoin(domains, eq(domains.id, ingressRoutes.domainId))
    .innerJoin(tenantOidcProviders, eq(tenantOidcProviders.id, ingressAuthConfigs.providerId))
    .where(and(
      eq(domains.tenantId, tenantId),
      eq(ingressAuthConfigs.enabled, true),
      ne(ingressAuthConfigs.ingressRouteId, routeId),
    ));
  const clash = others.find((o) => o.providerId !== providerId);
  if (clash) {
    throw new ApiError(
      'OIDC_PROVIDER_CONFLICT',
      `${clash.hostname} already signs in with "${clash.providerName}". All of a tenant's protected routes use ` +
        'the same provider: choose that one here, or switch the other route first.',
      409,
    );
  }
}

export async function upsertAuthConfig(
  db: Database,
  ctx: IngressAuthServiceContext,
  tenantId: string,
  ingressRouteId: string,
  patch: IngressAuthConfigPatch,
): Promise<IngressAuthConfigResponse> {
  const [route] = await db
    .select({ hostname: ingressRoutes.hostname, wwwRedirect: ingressRoutes.wwwRedirect })
    .from(ingressRoutes)
    .innerJoin(domains, eq(domains.id, ingressRoutes.domainId))
    .where(and(eq(ingressRoutes.id, ingressRouteId), eq(domains.tenantId, tenantId)));
  if (!route) {
    throw new ApiError('NOT_FOUND', `Ingress route ${ingressRouteId} not found`, 404);
  }
  const host = servedHost(route.hostname, route.wwwRedirect);

  // One write per tenant at a time: the single-provider check and the write
  // must not interleave with another route's (two enables with different
  // providers would both pass the check).
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ingress-auth:${tenantId}`}))`);
    await writeConfig(tx as unknown as Database, ctx, tenantId, ingressRouteId, route.hostname, host, patch);
  });

  const updated = await getAuthConfig(db, ingressRouteId);
  if (!updated) {
    throw new ApiError('INTERNAL', 'Auth config disappeared after write', 500);
  }
  return updated;
}

async function writeConfig(
  db: Database,
  ctx: IngressAuthServiceContext,
  tenantId: string,
  ingressRouteId: string,
  hostname: string,
  host: string,
  patch: IngressAuthConfigPatch,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(ingressAuthConfigs)
    .where(eq(ingressAuthConfigs.ingressRouteId, ingressRouteId));
  const input = { ...mergePatch(existing, patch), providerId: patch.providerId };
  if (input.enabled && !canProtectHost(hostname)) {
    throw validationError(
      'OIDC_WILDCARD_ROUTE',
      `Sign-in cannot protect the wildcard route ${hostname}: the identity provider needs one redirect URI per host. ` +
        'Add a route for each host you want to protect.',
    );
  }
  assertUsable(input, host, await tenantHosts(db, tenantId));

  const chosen = await resolveProvider(db, tenantId, existing, input);
  if (input.enabled) await assertSingleProvider(db, tenantId, ingressRouteId, 'inline' in chosen ? null : chosen.id);

  const providerId = 'inline' in chosen
    ? (await createProvider(db, ctx, tenantId, {
      name: `Created for ${host}`,
      issuerUrl: input.issuerUrl!,
      oauthClientId: input.clientId!,
      oauthClientSecret: input.clientSecret!,
      usePkce: input.usePkce,
      defaultScopes: input.scopes,
    })).id
    : chosen.id;

  const values = {
    enabled: input.enabled,
    providerId,
    postLoginRedirectUrl: input.postLoginRedirectUrl ?? null,
    allowedEmails: input.allowedEmails?.trim() || null,
    allowedEmailDomains: input.allowedEmailDomains?.trim() || null,
    allowedGroups: input.allowedGroups?.trim() || null,
    claimRules: input.claimRules && input.claimRules.length > 0 ? (input.claimRules as IngressClaimRule[]) : null,
    passAuthorizationHeader: input.passAuthorizationHeader,
    passAccessToken: input.passAccessToken,
    passIdToken: input.passIdToken,
    passUserHeaders: input.passUserHeaders,
    setXauthrequest: input.setXauthrequest,
    cookieDomain: input.cookieDomain ?? null,
    cookieRefreshSeconds: input.cookieRefreshSeconds,
    cookieExpireSeconds: input.cookieExpireSeconds,
    lastError: null,
  };
  if (existing) {
    await db.update(ingressAuthConfigs).set(values).where(eq(ingressAuthConfigs.ingressRouteId, ingressRouteId));
  } else {
    await db.insert(ingressAuthConfigs).values({ id: crypto.randomUUID(), ingressRouteId, ...values });
  }
}

export async function deleteAuthConfig(
  db: Database,
  ingressRouteId: string,
): Promise<void> {
  await db
    .delete(ingressAuthConfigs)
    .where(eq(ingressAuthConfigs.ingressRouteId, ingressRouteId));
}

/**
 * Per-tenant-namespace cookie secret used by oauth2-proxy. Generated and
 * encrypted on first call; returns plaintext for the reconciler.
 */
export async function getOrCreateTenantCookieSecret(
  db: Database,
  encryptionKey: string,
  tenantId: string,
): Promise<string> {
  const [existing] = await db
    .select()
    .from(tenantOauth2ProxyState)
    .where(eq(tenantOauth2ProxyState.tenantId, tenantId));
  if (existing) {
    return decrypt(existing.cookieSecretEncrypted, encryptionKey);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const cookieSecret = Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  await db
    .insert(tenantOauth2ProxyState)
    .values({
      tenantId,
      cookieSecretEncrypted: encrypt(cookieSecret, encryptionKey),
      provisioned: false,
    })
    .onConflictDoNothing();
  // A concurrent first call may have won the insert: use the stored secret.
  const [stored] = await db
    .select()
    .from(tenantOauth2ProxyState)
    .where(eq(tenantOauth2ProxyState.tenantId, tenantId));
  return stored ? decrypt(stored.cookieSecretEncrypted, encryptionKey) : cookieSecret;
}

/** An enabled route config of a tenant, with its provider and the host it serves. */
export interface EnabledIngressAuthRow {
  readonly cfg: IngressAuthConfig;
  readonly provider: TenantOidcProvider;
  readonly hostname: string;
  /** The host the route serves — where its sign-in lives. */
  readonly host: string;
}

/** Statuses whose routes are served — an archived or deleted tenant has no sign-in to run. */
const SERVING_TENANT = ['active', 'suspended'] as const;

/**
 * The tenant's enabled route configs: active routes of a tenant that is not
 * archived or pending, oldest first (the first one's provider is the gate's).
 */
export async function listEnabledForTenant(
  db: Database,
  tenantId: string,
): Promise<ReadonlyArray<EnabledIngressAuthRow>> {
  const rows = await db
    .select({
      cfg: ingressAuthConfigs,
      provider: tenantOidcProviders,
      hostname: ingressRoutes.hostname,
      wwwRedirect: ingressRoutes.wwwRedirect,
    })
    .from(ingressAuthConfigs)
    .innerJoin(tenantOidcProviders, eq(tenantOidcProviders.id, ingressAuthConfigs.providerId))
    .innerJoin(ingressRoutes, eq(ingressRoutes.id, ingressAuthConfigs.ingressRouteId))
    .innerJoin(domains, eq(domains.id, ingressRoutes.domainId))
    .innerJoin(tenants, eq(tenants.id, domains.tenantId))
    .where(and(
      eq(ingressAuthConfigs.enabled, true),
      eq(domains.tenantId, tenantId),
      eq(ingressRoutes.status, 'active'),
      inArray(tenants.status, [...SERVING_TENANT]),
    ))
    .orderBy(ingressAuthConfigs.createdAt);
  // Wildcard hosts and a second provider are kept here and refused, with a
  // reason, by the reconciler (partitionServable) — never silently dropped.
  return rows.map((r) => ({ cfg: r.cfg, provider: r.provider, hostname: r.hostname, host: servedHost(r.hostname, r.wwwRedirect) }));
}
