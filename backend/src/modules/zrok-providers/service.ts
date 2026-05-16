/**
 * Zrok provider service — per-tenant zrok controller registry.
 *
 * Used by the deployment-level Network Access feature (mode C: zrok
 * private share). Stores controller URL (BYO — defaults to public
 * https://api.zrok.io but supports self-hosted) + account email +
 * token (encrypted at rest).
 */

import { randomUUID } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import {
  tenantZrokAccounts,
  deploymentNetworkAccessConfigs,
} from '../../db/schema.js';
import { encrypt } from '../oidc/crypto.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type {
  ZrokProviderInput,
  ZrokProviderResponse,
} from '@k8s-hosting/api-contracts';

export async function listProviders(
  db: Database,
  tenantId: string,
): Promise<ReadonlyArray<ZrokProviderResponse>> {
  const rows = await db
    .select({
      id: tenantZrokAccounts.id,
      name: tenantZrokAccounts.name,
      controllerUrl: tenantZrokAccounts.controllerUrl,
      accountEmail: tenantZrokAccounts.accountEmail,
      accountTokenEncrypted: tenantZrokAccounts.accountTokenEncrypted,
      createdAt: tenantZrokAccounts.createdAt,
      updatedAt: tenantZrokAccounts.updatedAt,
      consumerCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${deploymentNetworkAccessConfigs}
        WHERE ${deploymentNetworkAccessConfigs.zrokProviderId} = ${tenantZrokAccounts.id}
      )`,
    })
    .from(tenantZrokAccounts)
    .where(eq(tenantZrokAccounts.tenantId, tenantId));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    controllerUrl: r.controllerUrl,
    accountEmail: r.accountEmail,
    tokenSet: Boolean(r.accountTokenEncrypted),
    consumerCount: r.consumerCount,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function createProvider(
  db: Database,
  encryptionKey: string,
  tenantId: string,
  input: ZrokProviderInput,
): Promise<ZrokProviderResponse> {
  if (!input.accountToken) {
    throw new ApiError(
      'ACCOUNT_TOKEN_REQUIRED',
      'accountToken is required when creating a provider',
      422,
    );
  }
  const id = randomUUID();
  await db.insert(tenantZrokAccounts).values({
    id,
    tenantId,
    name: input.name,
    controllerUrl: input.controllerUrl,
    accountEmail: input.accountEmail,
    accountTokenEncrypted: encrypt(input.accountToken, encryptionKey),
  });
  const all = await listProviders(db, tenantId);
  const created = all.find((p) => p.id === id);
  if (!created) {
    throw new ApiError('INTERNAL_ERROR', 'provider disappeared after insert', 500);
  }
  return created;
}

export async function updateProvider(
  db: Database,
  encryptionKey: string,
  tenantId: string,
  providerId: string,
  input: Partial<ZrokProviderInput>,
): Promise<ZrokProviderResponse> {
  const [existing] = await db
    .select()
    .from(tenantZrokAccounts)
    .where(and(eq(tenantZrokAccounts.id, providerId), eq(tenantZrokAccounts.tenantId, tenantId)));
  if (!existing) {
    throw new ApiError('NOT_FOUND', 'Zrok provider not found', 404);
  }
  await db
    .update(tenantZrokAccounts)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.controllerUrl !== undefined ? { controllerUrl: input.controllerUrl } : {}),
      ...(input.accountEmail !== undefined ? { accountEmail: input.accountEmail } : {}),
      ...(input.accountToken !== undefined && input.accountToken
        ? { accountTokenEncrypted: encrypt(input.accountToken, encryptionKey) }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(tenantZrokAccounts.id, providerId));
  const all = await listProviders(db, tenantId);
  const updated = all.find((p) => p.id === providerId);
  if (!updated) {
    throw new ApiError('INTERNAL_ERROR', 'provider disappeared after update', 500);
  }
  return updated;
}

export async function deleteProvider(
  db: Database,
  tenantId: string,
  providerId: string,
): Promise<void> {
  const consumers = await db
    .select()
    .from(deploymentNetworkAccessConfigs)
    .where(eq(deploymentNetworkAccessConfigs.zrokProviderId, providerId));
  if (consumers.length > 0) {
    throw new ApiError(
      'PROVIDER_IN_USE',
      `Provider is referenced by ${consumers.length} deployment(s); detach them first`,
      409,
    );
  }
  await db
    .delete(tenantZrokAccounts)
    .where(and(eq(tenantZrokAccounts.id, providerId), eq(tenantZrokAccounts.tenantId, tenantId)));
}
