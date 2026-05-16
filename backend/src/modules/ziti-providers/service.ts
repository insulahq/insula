/**
 * Ziti provider service — per-tenant OpenZiti controller registry.
 *
 * Used by the deployment-level Network Access feature (mode A:
 * tunneler). Stores controller URL + enrollment JWT (encrypted at
 * rest using PLATFORM_ENCRYPTION_KEY for v1) per tenant. The reconciler
 * (Milestone A) consumes these rows when provisioning per-tenant
 * ziti-edge-tunnel pods.
 */

import { randomUUID } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import {
  tenantZitiProviders,
  deploymentNetworkAccessConfigs,
} from '../../db/schema.js';
import { encrypt } from '../oidc/crypto.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type {
  ZitiProviderInput,
  ZitiProviderResponse,
} from '@k8s-hosting/api-contracts';

export async function listProviders(
  db: Database,
  tenantId: string,
): Promise<ReadonlyArray<ZitiProviderResponse>> {
  const rows = await db
    .select({
      id: tenantZitiProviders.id,
      name: tenantZitiProviders.name,
      controllerUrl: tenantZitiProviders.controllerUrl,
      enrollmentJwt: tenantZitiProviders.enrollmentJwtEncrypted,
      certExpiresAt: tenantZitiProviders.certExpiresAt,
      createdAt: tenantZitiProviders.createdAt,
      updatedAt: tenantZitiProviders.updatedAt,
      consumerCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${deploymentNetworkAccessConfigs}
        WHERE ${deploymentNetworkAccessConfigs.zitiProviderId} = ${tenantZitiProviders.id}
      )`,
    })
    .from(tenantZitiProviders)
    .where(eq(tenantZitiProviders.tenantId, tenantId));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    controllerUrl: r.controllerUrl,
    enrolled: r.enrollmentJwt !== null,
    certExpiresAt: r.certExpiresAt?.toISOString() ?? null,
    consumerCount: r.consumerCount,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function createProvider(
  db: Database,
  encryptionKey: string,
  tenantId: string,
  input: ZitiProviderInput,
): Promise<ZitiProviderResponse> {
  if (!input.enrollmentJwt) {
    throw new ApiError(
      'ENROLLMENT_JWT_REQUIRED',
      'enrollmentJwt is required when creating a provider',
      422,
    );
  }
  const id = randomUUID();
  await db.insert(tenantZitiProviders).values({
    id,
    tenantId,
    name: input.name,
    controllerUrl: input.controllerUrl,
    enrollmentJwtEncrypted: encrypt(input.enrollmentJwt, encryptionKey),
  });
  const [created] = await listProvidersById(db, [id]);
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
  input: Partial<ZitiProviderInput>,
): Promise<ZitiProviderResponse> {
  const [existing] = await db
    .select()
    .from(tenantZitiProviders)
    .where(and(eq(tenantZitiProviders.id, providerId), eq(tenantZitiProviders.tenantId, tenantId)));
  if (!existing) {
    throw new ApiError('NOT_FOUND', 'Ziti provider not found', 404);
  }
  await db
    .update(tenantZitiProviders)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.controllerUrl !== undefined ? { controllerUrl: input.controllerUrl } : {}),
      ...(input.enrollmentJwt !== undefined && input.enrollmentJwt
        ? { enrollmentJwtEncrypted: encrypt(input.enrollmentJwt, encryptionKey) }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(tenantZitiProviders.id, providerId));
  const [updated] = await listProvidersById(db, [providerId]);
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
  // FK ON DELETE RESTRICT will reject this when consumers exist; we
  // pre-check so we can return a 409 with a clear message rather than
  // a 500 from a raw FK violation.
  const consumers = await db
    .select()
    .from(deploymentNetworkAccessConfigs)
    .where(eq(deploymentNetworkAccessConfigs.zitiProviderId, providerId));
  if (consumers.length > 0) {
    throw new ApiError(
      'PROVIDER_IN_USE',
      `Provider is referenced by ${consumers.length} deployment(s); detach them first`,
      409,
    );
  }
  await db
    .delete(tenantZitiProviders)
    .where(and(eq(tenantZitiProviders.id, providerId), eq(tenantZitiProviders.tenantId, tenantId)));
}

async function listProvidersById(
  db: Database,
  ids: ReadonlyArray<string>,
): Promise<ReadonlyArray<ZitiProviderResponse>> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: tenantZitiProviders.id,
      name: tenantZitiProviders.name,
      controllerUrl: tenantZitiProviders.controllerUrl,
      enrollmentJwt: tenantZitiProviders.enrollmentJwtEncrypted,
      certExpiresAt: tenantZitiProviders.certExpiresAt,
      createdAt: tenantZitiProviders.createdAt,
      updatedAt: tenantZitiProviders.updatedAt,
      consumerCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${deploymentNetworkAccessConfigs}
        WHERE ${deploymentNetworkAccessConfigs.zitiProviderId} = ${tenantZitiProviders.id}
      )`,
    })
    .from(tenantZitiProviders)
    .where(eq(tenantZitiProviders.id, ids[0]!));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    controllerUrl: r.controllerUrl,
    enrolled: r.enrollmentJwt !== null,
    certExpiresAt: r.certExpiresAt?.toISOString() ?? null,
    consumerCount: r.consumerCount,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}
