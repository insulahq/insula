import { eq } from 'drizzle-orm';
import { tenants, hostingPlans } from '../../db/schema.js';
import { tenantNotFound } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type { UpdateSubscriptionInput } from './schema.js';

export async function getSubscription(db: Database, tenantId: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) throw tenantNotFound(tenantId);

  const [plan] = await db.select().from(hostingPlans).where(eq(hostingPlans.id, tenant.planId));

  return {
    tenant_id: tenant.id,
    plan: plan ?? null,
    status: tenant.status,
    subscription_expires_at: tenant.subscriptionExpiresAt,
    created_at: tenant.createdAt,
  };
}

export async function updateSubscription(db: Database, tenantId: string, input: UpdateSubscriptionInput) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) throw tenantNotFound(tenantId);

  const updateValues: Record<string, unknown> = {};
  if (input.plan_id !== undefined) updateValues.planId = input.plan_id;
  if (input.status !== undefined) updateValues.status = input.status;
  if (input.subscription_expires_at !== undefined) {
    updateValues.subscriptionExpiresAt = new Date(input.subscription_expires_at);
  }

  if (Object.keys(updateValues).length > 0) {
    await db.update(tenants).set(updateValues).where(eq(tenants.id, tenantId));
  }

  return getSubscription(db, tenantId);
}
