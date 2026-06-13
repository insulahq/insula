/**
 * Plesk migration records (R1 PR 2).
 *
 * CRUD + lookup for `plesk_migrations` — each row provisions ONE Plesk
 * subscription (a frozen snapshot of the discovery inventory) into a
 * platform tenant. The orchestration that actually creates tenant /
 * domains / email lives in provision.ts; this file is the data layer.
 */

import { randomUUID } from 'node:crypto';
import { eq, and, desc, inArray, lt, sql } from 'drizzle-orm';
import {
  pleskMigrations,
  pleskSources,
  pleskDiscoveries,
  tenants,
} from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { pleskInventorySchema } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import type {
  CreatePleskMigrationInput,
  PleskMigrationResponse,
  PleskMigrationLegs,
} from '@insula/api-contracts';

export type MigrationRow = typeof pleskMigrations.$inferSelect;

/** Shape a raw row for the API (legs jsonb passes through as-is). */
export function toMigrationResponse(row: MigrationRow): PleskMigrationResponse {
  return {
    id: row.id,
    sourceId: row.sourceId,
    discoveryId: row.discoveryId,
    subscriptionName: row.subscriptionName,
    targetPlanId: row.targetPlanId,
    targetTenantId: row.targetTenantId,
    status: row.status as PleskMigrationResponse['status'],
    legs: (row.legs as PleskMigrationLegs | null) ?? null,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * Create a migration record (status=pending) from a discovered
 * subscription. Validates the source, the discovery, the subscription's
 * presence in the inventory, and the target plan — then freezes the
 * subscription snapshot so a later re-discovery can't change what we
 * provision. Returns the new id; the caller kicks off provisioning.
 */
export async function createMigration(
  db: Database,
  input: CreatePleskMigrationInput,
  createdBy: string | null,
): Promise<{ id: string }> {
  const [source] = await db.select().from(pleskSources).where(eq(pleskSources.id, input.source_id));
  if (!source) throw new ApiError('PLESK_SOURCE_NOT_FOUND', `Plesk source '${input.source_id}' not found`, 404);

  // Resolve the discovery: an explicit id (scoped to this source) or the
  // source's most recent COMPLETED discovery.
  let discoveryRow;
  if (input.discovery_id) {
    [discoveryRow] = await db
      .select()
      .from(pleskDiscoveries)
      .where(and(eq(pleskDiscoveries.id, input.discovery_id), eq(pleskDiscoveries.sourceId, source.id)));
    if (!discoveryRow) throw new ApiError('PLESK_DISCOVERY_NOT_FOUND', `Discovery '${input.discovery_id}' not found for this source`, 404);
  } else {
    [discoveryRow] = await db
      .select()
      .from(pleskDiscoveries)
      .where(and(eq(pleskDiscoveries.sourceId, source.id), eq(pleskDiscoveries.status, 'completed')))
      .orderBy(desc(pleskDiscoveries.completedAt))
      .limit(1);
    if (!discoveryRow) throw new ApiError('NO_COMPLETED_DISCOVERY', 'No completed discovery for this source — run a discovery first', 409);
  }
  if (discoveryRow.status !== 'completed' || !discoveryRow.inventory) {
    throw new ApiError('DISCOVERY_NOT_COMPLETED', `Discovery '${discoveryRow.id}' has not completed`, 409);
  }

  // Find the subscription in the frozen inventory.
  const inv = pleskInventorySchema.safeParse(discoveryRow.inventory);
  if (!inv.success) throw new ApiError('INVALID_INVENTORY', 'Stored discovery inventory is unreadable', 500);
  const sub = inv.data.subscriptions.find((s) => s.name === input.subscription_name);
  if (!sub) throw new ApiError('SUBSCRIPTION_NOT_FOUND', `Subscription '${input.subscription_name}' is not in the discovery inventory`, 404);

  // Map onto an EXISTING tenant the operator already created and sized.
  const [tenant] = await db
    .select({ id: tenants.id, isSystem: tenants.isSystem, status: tenants.status, planId: tenants.planId })
    .from(tenants)
    .where(eq(tenants.id, input.target_tenant_id));
  if (!tenant) throw new ApiError('TENANT_NOT_FOUND', `Target tenant '${input.target_tenant_id}' not found`, 404);
  if (tenant.isSystem) throw new ApiError('TENANT_IS_SYSTEM', 'The SYSTEM tenant cannot be a migration target', 400);
  // Only an active, provisioned tenant is a valid target (a 'pending' tenant
  // has no namespace yet; 'suspended'/'archived' must not receive resources).
  if (tenant.status !== 'active') {
    throw new ApiError('TENANT_NOT_AVAILABLE', `Target tenant is '${tenant.status}' — pick an active, provisioned tenant`, 400);
  }

  const id = randomUUID();
  try {
    await db.insert(pleskMigrations).values({
      id,
      sourceId: source.id,
      discoveryId: discoveryRow.id,
      subscriptionName: sub.name,
      subscriptionSnapshot: sub as unknown as Record<string, unknown>,
      targetTenantId: tenant.id,
      // Audit: the plan the tenant had at migration time.
      targetPlanId: tenant.planId,
      status: 'pending',
      legs: {},
      createdBy,
    });
  } catch (err) {
    // Partial unique index (source, subscription) WHERE status IN
    // (pending, running) — a concurrent submit lost the race.
    if (isUniqueViolation(err)) {
      throw new ApiError('MIGRATION_ALREADY_RUNNING', `A migration for subscription '${sub.name}' is already in progress`, 409);
    }
    throw err;
  }
  return { id };
}

/**
 * Atomically claim a terminal migration for a retry: flip it back to
 * pending ONLY if it is currently in a terminal state. Returns the row
 * if this caller won the claim, or null if another request already
 * re-started it (or it's still in flight). This closes the TOCTOU window
 * where two concurrent Retry clicks both read 'failed' and both spawn a
 * runner that would race on the legs jsonb.
 */
export async function claimMigrationForRetry(db: Database, id: string): Promise<MigrationRow | null> {
  const [claimed] = await db
    .update(pleskMigrations)
    .set({ status: 'pending', error: null, updatedAt: new Date() })
    .where(and(
      eq(pleskMigrations.id, id),
      inArray(pleskMigrations.status, ['failed', 'partial', 'completed']),
    ))
    .returning();
  return claimed ?? null;
}

export async function getMigration(db: Database, id: string): Promise<MigrationRow> {
  const [row] = await db.select().from(pleskMigrations).where(eq(pleskMigrations.id, id));
  if (!row) throw new ApiError('PLESK_MIGRATION_NOT_FOUND', `Migration '${id}' not found`, 404);
  return row;
}

export async function listMigrations(db: Database, sourceId?: string): Promise<MigrationRow[]> {
  const base = db.select().from(pleskMigrations);
  const rows = sourceId
    ? await base.where(eq(pleskMigrations.sourceId, sourceId)).orderBy(desc(pleskMigrations.createdAt))
    : await base.orderBy(desc(pleskMigrations.createdAt));
  return rows;
}

/**
 * Startup sweep: a backend restart mid-provision orphans the
 * fire-and-forget runner, leaving migrations stuck in pending/running.
 * Fail any older than a generous window so the UI resolves; the tenant
 * (if any) survives and the operator can Retry the same row (the
 * orchestrator is idempotent). Idempotent; safe on every boot.
 */
export async function failStaleMigrations(db: Database): Promise<number> {
  const rows = await db
    .update(pleskMigrations)
    .set({
      status: 'failed',
      error: 'backend restarted while the migration was in flight — retry to resume',
      updatedAt: new Date(),
    })
    .where(and(
      inArray(pleskMigrations.status, ['pending', 'running']),
      lt(pleskMigrations.updatedAt, sql`NOW() - INTERVAL '30 minutes'`),
    ))
    .returning({ id: pleskMigrations.id });
  return rows.length;
}
