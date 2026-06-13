/**
 * Plesk migration provisioning orchestrator (R1 PR 2).
 *
 * Given a `plesk_migration` row (a frozen subscription snapshot + a
 * target plan), provisions the PLATFORM side of the migration as a
 * sequence of resumable legs:
 *
 *   tenant  → create the tenant (mapped to the operator-chosen plan)
 *   domains → create each Plesk domain as a platform domain
 *   email   → enable email (Stalwart x:Domain + DKIM) for the domains
 *             that host mailboxes
 *
 * Content/DB sync and mail-data import land in later PRs as additional
 * legs. Every leg is idempotent: a re-run (Retry) skips an
 * already-created tenant, skips domains that already exist, and relies
 * on enableEmailForDomain's own idempotency. Progress is persisted to
 * the row's `legs` jsonb after every step so the UI can poll and a
 * backend restart resumes cleanly.
 *
 * NOTHING here touches the Plesk source — this is platform-side
 * provisioning driven by the read-only discovery snapshot.
 */

import { eq, and } from 'drizzle-orm';
import { pleskMigrations, domains as domainsTable, users, hostingPlans } from '../../db/schema.js';
import { createTenant } from '../tenants/service.js';
import { createDomain } from '../domains/service.js';
import { enableEmailForDomain } from '../email-domains/service.js';
import { ApiError } from '../../shared/errors.js';
import { pleskSubscriptionSchema, createDomainSchema } from '@insula/api-contracts';
import type { PleskSubscription } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { MigrationRow } from './migrations.js';

function encryptionKey(): string {
  // Dev-only fallback — production requires PLATFORM_ENCRYPTION_KEY (same
  // convention as email-domains/routes.ts).
  return process.env.PLATFORM_ENCRYPTION_KEY ?? '0'.repeat(64);
}

export interface MigrationLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

type ItemStatus = 'completed' | 'failed' | 'skipped';
interface LegItem { name: string; status: ItemStatus; message?: string }
interface LegState {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'partial';
  startedAt?: string;
  completedAt?: string;
  detail?: string;
  error?: string;
  items?: LegItem[];
}
type Legs = Record<string, LegState>;

function nowIso(): string { return new Date().toISOString(); }

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

async function persistLegs(db: Database, id: string, legs: Legs): Promise<void> {
  await db.update(pleskMigrations)
    .set({ legs: legs as unknown as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(pleskMigrations.id, id));
}

/**
 * Kick off provisioning in the background (fire-and-forget), mirroring
 * startDiscovery. Returns immediately; the UI polls the row.
 */
export async function startMigration(
  db: Database,
  k8s: K8sClients | undefined,
  migrationId: string,
  logger: MigrationLogger,
): Promise<void> {
  void runMigration(db, k8s, migrationId, logger).catch(async (err) => {
    logger.error({ err, migrationId }, 'plesk migration: unhandled failure');
    await db.update(pleskMigrations)
      .set({ status: 'failed', error: errMessage(err), updatedAt: new Date() })
      .where(eq(pleskMigrations.id, migrationId))
      .catch(() => {});
  });
}

async function runMigration(
  db: Database,
  k8s: K8sClients | undefined,
  migrationId: string,
  logger: MigrationLogger,
): Promise<void> {
  const [row] = await db.select().from(pleskMigrations).where(eq(pleskMigrations.id, migrationId));
  if (!row) throw new Error(`migration ${migrationId} vanished`);

  const parsed = pleskSubscriptionSchema.safeParse(row.subscriptionSnapshot);
  if (!parsed.success) {
    await db.update(pleskMigrations)
      .set({ status: 'failed', error: 'frozen subscription snapshot is unreadable', updatedAt: new Date() })
      .where(eq(pleskMigrations.id, migrationId));
    return;
  }
  const snapshot = parsed.data;
  const legs: Legs = { ...((row.legs as Legs | null) ?? {}) };

  // Pre-flight: the target plan can be deleted between create and a later
  // Retry. Fail fast with a clear error instead of surfacing a confusing
  // INVALID_PLAN_ID from deep inside createTenant.
  const [plan] = await db.select({ id: hostingPlans.id }).from(hostingPlans).where(eq(hostingPlans.id, row.targetPlanId)).limit(1);
  if (!plan) {
    await db.update(pleskMigrations)
      .set({ status: 'failed', error: `target plan '${row.targetPlanId}' no longer exists — pick a new plan and create a fresh migration`, updatedAt: new Date() })
      .where(eq(pleskMigrations.id, migrationId));
    return;
  }

  await db.update(pleskMigrations).set({ status: 'running', error: null, updatedAt: new Date() }).where(eq(pleskMigrations.id, migrationId));

  // ── Leg 1: tenant ──
  let tenantId = row.targetTenantId;
  if (!tenantId) {
    legs.tenant = { status: 'running', startedAt: nowIso() };
    await persistLegs(db, migrationId, legs);
    try {
      tenantId = await provisionTenant(db, row);
      await db.update(pleskMigrations).set({ targetTenantId: tenantId, updatedAt: new Date() }).where(eq(pleskMigrations.id, migrationId));
      legs.tenant = { ...legs.tenant, status: 'completed', completedAt: nowIso(), detail: `tenant ${tenantId}` };
      await persistLegs(db, migrationId, legs);
    } catch (err) {
      logger.error({ err, migrationId }, 'plesk migration: tenant leg failed');
      legs.tenant = { ...legs.tenant, status: 'failed', completedAt: nowIso(), error: errMessage(err) };
      await persistLegs(db, migrationId, legs);
      await db.update(pleskMigrations)
        .set({ status: 'failed', error: `tenant provisioning failed: ${errMessage(err)}`, updatedAt: new Date() })
        .where(eq(pleskMigrations.id, migrationId));
      return; // nothing downstream can run without a tenant
    }
  } else if (legs.tenant?.status !== 'completed') {
    legs.tenant = { status: 'completed', detail: `existing tenant ${tenantId}` };
    await persistLegs(db, migrationId, legs);
  }

  // ── Leg 2: domains ──
  legs.domains = { status: 'running', startedAt: nowIso() };
  await persistLegs(db, migrationId, legs);
  const domainItems = await provisionDomains(db, k8s, tenantId, snapshot, logger);
  legs.domains = finalizeItemLeg(legs.domains, domainItems, 'domains');
  await persistLegs(db, migrationId, legs);

  // ── Leg 3: email ──
  legs.email = { status: 'running', startedAt: nowIso() };
  await persistLegs(db, migrationId, legs);
  const emailItems = await provisionEmail(db, tenantId, snapshot, logger);
  legs.email = finalizeItemLeg(legs.email, emailItems, 'mailbox domains');
  await persistLegs(db, migrationId, legs);

  // ── Overall status ──
  const anyLegFailed = Object.values(legs).some((l) => l.status === 'failed' || l.status === 'partial');
  const overall = anyLegFailed ? 'partial' : 'completed';
  await db.update(pleskMigrations)
    .set({ status: overall, error: null, updatedAt: new Date() })
    .where(eq(pleskMigrations.id, migrationId));
  logger.info({ migrationId, status: overall, tenantId }, 'plesk migration: provisioning finished');
}

/** Roll an item list into a leg state (skipped if empty, partial on any failure). */
export function finalizeItemLeg(prev: LegState, items: LegItem[], unit: string): LegState {
  if (items.length === 0) {
    return { ...prev, status: 'skipped', completedAt: nowIso(), detail: `no ${unit}` };
  }
  const ok = items.filter((i) => i.status !== 'failed').length;
  const failed = items.some((i) => i.status === 'failed');
  return {
    ...prev,
    status: failed ? 'partial' : 'completed',
    completedAt: nowIso(),
    detail: `${ok}/${items.length} ${unit}`,
    items,
  };
}

/** Default admin email for a subscription with no explicit contact. */
function defaultContactEmail(subscriptionName: string): string {
  // subscriptionName is the Plesk main-domain name (normally a clean
  // FQDN), but sanitize defensively so an odd Plesk account name can't
  // produce an invalid email that breaks createTenant downstream.
  const slug = subscriptionName.toLowerCase().replace(/[^a-z0-9.-]/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return `admin@${slug || 'tenant.example'}`;
}

/**
 * Create the tenant for this subscription. Idempotent: if a prior
 * attempt already created the tenant_admin user (but crashed before
 * persisting targetTenantId), adopt that tenant instead of colliding on
 * EMAIL_IN_USE. Adoption is gated on roleName==='tenant_admin' so a
 * shared email belonging to an admin/support user (or another tenant's
 * non-tenant_admin user) can never silently bolt this migration onto an
 * unrelated tenant — in that case createTenant raises EMAIL_IN_USE and
 * the operator must pick a different contact_email.
 */
async function provisionTenant(db: Database, row: MigrationRow): Promise<string> {
  const email = row.contactEmail ?? defaultContactEmail(row.subscriptionName);
  const [existingUser] = await db
    .select({ tenantId: users.tenantId, roleName: users.roleName })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existingUser?.tenantId && existingUser.roleName === 'tenant_admin') {
    return existingUser.tenantId;
  }

  const tenant = await createTenant(
    db,
    { name: row.subscriptionName, primary_email: email, plan_id: row.targetPlanId },
    row.createdBy ?? 'plesk-migration',
  );
  return tenant.id;
}

/** Create each Plesk domain as a platform domain (dns_mode=cname). */
async function provisionDomains(
  db: Database,
  k8s: K8sClients | undefined,
  tenantId: string,
  snapshot: PleskSubscription,
  logger: MigrationLogger,
): Promise<LegItem[]> {
  const items: LegItem[] = [];
  for (const d of snapshot.domains) {
    try {
      const [existing] = await db
        .select({ id: domainsTable.id })
        .from(domainsTable)
        .where(and(eq(domainsTable.tenantId, tenantId), eq(domainsTable.domainName, d.name)))
        .limit(1);
      if (existing) {
        items.push({ name: d.name, status: 'skipped', message: 'already exists' });
        continue;
      }
      // Validate the name through the same contract the HTTP route uses
      // (FQDN, alpha-only TLD) so a malformed Plesk domain fails cleanly
      // per-item instead of poisoning the K8s reconcile downstream.
      const parsed = createDomainSchema.safeParse({ domain_name: d.name, dns_mode: 'cname' });
      if (!parsed.success) {
        items.push({ name: d.name, status: 'failed', message: `invalid domain name: ${parsed.error.issues[0]?.message ?? 'format'}` });
        continue;
      }
      await createDomain(db, tenantId, parsed.data, k8s);
      items.push({ name: d.name, status: 'completed' });
    } catch (err) {
      logger.warn({ err, domain: d.name, tenantId }, 'plesk migration: domain provisioning failed');
      items.push({ name: d.name, status: 'failed', message: errMessage(err) });
    }
  }
  return items;
}

/**
 * Enable email for the domains that host mailboxes (provisions the
 * Stalwart x:Domain + DKIM + DNS). Individual mailbox accounts and
 * maildir import land in the mail-data leg (later PR).
 *
 * On Retry this re-attempts every mail domain, not just failed ones —
 * that's safe because enableEmailForDomain is itself idempotent (returns
 * the existing row when stalwartDomainId is already set, retries the JMAP
 * step only when it's null). Any future call added to this leg MUST keep
 * that idempotency or guard on per-item leg state.
 */
/** Distinct lower-cased domains that host ≥1 mailbox in the snapshot. */
export function mailDomainsOf(snapshot: PleskSubscription): string[] {
  const set = new Set<string>();
  for (const m of snapshot.mailboxes) {
    const dn = m.address.split('@')[1]?.toLowerCase();
    if (dn) set.add(dn);
  }
  return [...set];
}

async function provisionEmail(
  db: Database,
  tenantId: string,
  snapshot: PleskSubscription,
  logger: MigrationLogger,
): Promise<LegItem[]> {
  const mailDomains = mailDomainsOf(snapshot);
  const items: LegItem[] = [];
  for (const dn of mailDomains) {
    try {
      const [domainRow] = await db
        .select({ id: domainsTable.id })
        .from(domainsTable)
        .where(and(eq(domainsTable.tenantId, tenantId), eq(domainsTable.domainName, dn)))
        .limit(1);
      if (!domainRow) {
        items.push({ name: dn, status: 'skipped', message: 'domain not provisioned' });
        continue;
      }
      await enableEmailForDomain(db, tenantId, domainRow.id, { webmail_enabled: false }, encryptionKey());
      items.push({ name: dn, status: 'completed' });
    } catch (err) {
      logger.warn({ err, domain: dn, tenantId }, 'plesk migration: email enable failed');
      items.push({ name: dn, status: 'failed', message: errMessage(err) });
    }
  }
  return items;
}
