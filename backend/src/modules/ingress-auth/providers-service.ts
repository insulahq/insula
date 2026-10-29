/**
 * Per-tenant OIDC provider CRUD.
 *
 * Providers are reusable across a tenant's routes. Secrets are encrypted with
 * PLATFORM_ENCRYPTION_KEY and NEVER returned; only `secretSet` exposes
 * presence. Every enabled route of a tenant must use the same provider (one
 * oauth2-proxy per tenant namespace), so changing a provider changes the sign-in
 * of every route that uses it — the caller reconciles the tenant afterwards.
 *
 * Delete: refused with 409 PROVIDER_IN_USE while any route config references
 * the provider (the FK itself is ON DELETE CASCADE so tenant deletion passes).
 */

import { eq, and, count, inArray } from 'drizzle-orm';
import {
  tenantOidcProviders,
  ingressAuthConfigs,
  ingressRoutes,
} from '../../db/schema.js';
import { encrypt, decrypt } from '../oidc/crypto.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type { TenantOidcProvider } from '../../db/schema.js';
import { buildCallbackUrl, servedHost } from './hosts.js';

export interface ProviderInput {
  readonly name: string;
  readonly issuerUrl: string;
  readonly oauthClientId: string;
  /** Plaintext. Required on create; optional on update (omitted = keep). */
  readonly oauthClientSecret?: string;
  readonly usePkce?: boolean;
  readonly defaultScopes?: string;
}

export interface ProviderResponse {
  readonly id: string;
  readonly name: string;
  readonly issuerUrl: string;
  readonly oauthClientId: string;
  readonly secretSet: boolean;
  readonly usePkce: boolean;
  readonly defaultScopes: string;
  readonly consumerCount: number;
  readonly callbackUrls: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface Ctx {
  readonly encryptionKey: string;
}

interface Consumers {
  readonly count: number;
  readonly callbackUrls: ReadonlyArray<string>;
}

function toResponse(row: TenantOidcProvider, consumers: Consumers): ProviderResponse {
  return {
    id: row.id,
    name: row.name,
    issuerUrl: row.issuerUrl,
    oauthClientId: row.oauthClientId,
    secretSet: row.oauthClientSecretEncrypted.length > 0,
    usePkce: row.usePkce,
    defaultScopes: row.defaultScopes,
    consumerCount: consumers.count,
    callbackUrls: consumers.callbackUrls,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Route configs per provider, with the redirect URI each one needs at the IdP. */
async function consumersOf(db: Database, providerIds: ReadonlyArray<string>): Promise<Map<string, Consumers>> {
  const out = new Map<string, { count: number; urls: Set<string> }>();
  if (providerIds.length === 0) return new Map();
  const rows = await db
    .select({ providerId: ingressAuthConfigs.providerId, hostname: ingressRoutes.hostname, wwwRedirect: ingressRoutes.wwwRedirect })
    .from(ingressAuthConfigs)
    .innerJoin(ingressRoutes, eq(ingressRoutes.id, ingressAuthConfigs.ingressRouteId))
    .where(inArray(ingressAuthConfigs.providerId, [...providerIds]));
  for (const r of rows) {
    const entry = out.get(r.providerId) ?? { count: 0, urls: new Set<string>() };
    entry.count += 1;
    entry.urls.add(buildCallbackUrl(servedHost(r.hostname, r.wwwRedirect)));
    out.set(r.providerId, entry);
  }
  return new Map([...out].map(([id, e]) => [id, { count: e.count, callbackUrls: [...e.urls].sort() }]));
}

const NO_CONSUMERS: Consumers = { count: 0, callbackUrls: [] };

export async function listProviders(
  db: Database,
  tenantId: string,
): Promise<ReadonlyArray<ProviderResponse>> {
  const rows = await db
    .select()
    .from(tenantOidcProviders)
    .where(eq(tenantOidcProviders.tenantId, tenantId));
  const consumers = await consumersOf(db, rows.map((r) => r.id));
  return rows.map((r) => toResponse(r, consumers.get(r.id) ?? NO_CONSUMERS));
}

export async function getProvider(
  db: Database,
  tenantId: string,
  id: string,
): Promise<ProviderResponse | null> {
  const [row] = await db
    .select()
    .from(tenantOidcProviders)
    .where(and(eq(tenantOidcProviders.id, id), eq(tenantOidcProviders.tenantId, tenantId)));
  if (!row) return null;
  const consumers = await consumersOf(db, [id]);
  return toResponse(row, consumers.get(id) ?? NO_CONSUMERS);
}

export async function createProvider(
  db: Database,
  ctx: Ctx,
  tenantId: string,
  input: ProviderInput,
): Promise<ProviderResponse> {
  if (!input.oauthClientSecret) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'oauthClientSecret is required when creating a provider',
      400,
    );
  }
  const id = crypto.randomUUID();
  await db.insert(tenantOidcProviders).values({
    id,
    tenantId,
    name: input.name,
    issuerUrl: input.issuerUrl,
    oauthClientId: input.oauthClientId,
    oauthClientSecretEncrypted: encrypt(input.oauthClientSecret, ctx.encryptionKey),
    usePkce: input.usePkce ?? true,
    defaultScopes: input.defaultScopes ?? 'openid profile email',
  });
  const result = await getProvider(db, tenantId, id);
  if (!result) throw new ApiError('INTERNAL', 'Provider missing after insert', 500);
  return result;
}

export async function updateProvider(
  db: Database,
  ctx: Ctx,
  tenantId: string,
  id: string,
  input: Partial<ProviderInput>,
): Promise<ProviderResponse> {
  const existing = await getProvider(db, tenantId, id);
  if (!existing) {
    throw new ApiError('NOT_FOUND', `Provider ${id} not found`, 404);
  }
  const set: Partial<typeof tenantOidcProviders.$inferInsert> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.issuerUrl !== undefined) set.issuerUrl = input.issuerUrl;
  if (input.oauthClientId !== undefined) set.oauthClientId = input.oauthClientId;
  if (input.oauthClientSecret) {
    set.oauthClientSecretEncrypted = encrypt(input.oauthClientSecret, ctx.encryptionKey);
  }
  if (input.usePkce !== undefined) set.usePkce = input.usePkce;
  if (input.defaultScopes !== undefined) set.defaultScopes = input.defaultScopes;
  if (Object.keys(set).length > 0) {
    await db
      .update(tenantOidcProviders)
      .set(set)
      .where(and(eq(tenantOidcProviders.id, id), eq(tenantOidcProviders.tenantId, tenantId)));
  }
  const updated = await getProvider(db, tenantId, id);
  if (!updated) throw new ApiError('INTERNAL', 'Provider missing after update', 500);
  return updated;
}

export async function deleteProvider(
  db: Database,
  tenantId: string,
  id: string,
): Promise<void> {
  const [row] = await db
    .select({ n: count() })
    .from(ingressAuthConfigs)
    .where(eq(ingressAuthConfigs.providerId, id));
  const consumers = Number(row?.n ?? 0);
  if (consumers > 0) {
    throw new ApiError(
      'PROVIDER_IN_USE',
      `Provider is used by ${consumers} route${consumers === 1 ? '' : 's'}; ` +
        'turn sign-in off on those routes, or point them at another provider, before deleting it.',
      409,
      { consumers },
    );
  }
  await db
    .delete(tenantOidcProviders)
    .where(and(eq(tenantOidcProviders.id, id), eq(tenantOidcProviders.tenantId, tenantId)));
}

/** The provider's client secret, decrypted for the reconciler. */
export function decryptProviderSecret(
  row: TenantOidcProvider,
  encryptionKey: string,
): string {
  if (!row.oauthClientSecretEncrypted) return '';
  return decrypt(row.oauthClientSecretEncrypted, encryptionKey);
}
