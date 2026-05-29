import { eq } from 'drizzle-orm';
import { tenants, hostingPlans } from '../../db/schema.js';
import { tenantNotFound } from '../../shared/errors.js';
import {
  notifyTenantSubscriptionChanged,
  notifyTenantSubscriptionRenewed,
} from '../notifications/events.js';
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

  if (Object.keys(updateValues).length === 0) {
    return getSubscription(db, tenantId);
  }

  await db.update(tenants).set(updateValues).where(eq(tenants.id, tenantId));

  // Phase 4: fire subscription events. We compute the diff vs the
  // pre-update snapshot we already loaded above.
  //   - plan_id change                                  → subscription.changed
  //   - expires_at advances past the previous value     → subscription.renewed
  // Both fire if both changed (different templates / audiences). Fire
  // AFTER the UPDATE so the worker (re-renders from variables) sees
  // the new state when it dequeues the email.
  await fireSubscriptionEvents(db, tenantId, tenant, updateValues);

  return getSubscription(db, tenantId);
}

interface PreUpdateTenant {
  readonly id: string;
  readonly name: string | null;
  readonly planId: string;
  readonly subscriptionExpiresAt: Date | null;
}

async function fireSubscriptionEvents(
  db: Database,
  tenantId: string,
  before: PreUpdateTenant,
  patch: Record<string, unknown>,
): Promise<void> {
  const planChanged = typeof patch.planId === 'string' && patch.planId !== before.planId;
  const newExpiry = patch.subscriptionExpiresAt instanceof Date ? patch.subscriptionExpiresAt : null;
  const expiryAdvanced = newExpiry != null
    && (before.subscriptionExpiresAt == null
      || newExpiry.getTime() > before.subscriptionExpiresAt.getTime());

  if (planChanged) {
    const [oldPlan] = await db.select({ name: hostingPlans.name }).from(hostingPlans).where(eq(hostingPlans.id, before.planId));
    const [newPlan] = await db.select({ name: hostingPlans.name }).from(hostingPlans).where(eq(hostingPlans.id, patch.planId as string));
    await notifyTenantSubscriptionChanged(db, tenantId, {
      tenantName: before.name ?? undefined,
      oldPlanName: oldPlan?.name,
      newPlanName: newPlan?.name,
    });
  }
  if (expiryAdvanced && newExpiry != null) {
    await notifyTenantSubscriptionRenewed(db, tenantId, {
      tenantName: before.name ?? undefined,
      newExpiresAt: newExpiry.toISOString(),
    });
  }
}
