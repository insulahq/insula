/**
 * Plesk migration provisioning orchestrator (R1 PR 2, tenant-first).
 *
 * Given a `plesk_migration` row (a frozen subscription snapshot mapped onto
 * an EXISTING, operator-sized tenant), provisions the PLATFORM side of the
 * migration as a sequence of resumable legs:
 *
 *   preflight → validate the target tenant + capacity-check the subscription
 *               against the tenant's plan (mailbox count, storage) and FAIL
 *               VISIBLY if the tenant is under-sized — the operator resizes
 *               the tenant and retries, rather than failing mid-migration
 *   domains   → create each Plesk domain as a platform domain
 *   email     → enable email (Stalwart x:Domain + DKIM) for the domains
 *               that host mailboxes
 *
 * The migration does NOT create the tenant: the operator creates and sizes it
 * first (plan / PVC / CPU / memory / mailbox limits) via the normal tenant
 * flow, sidestepping the many sizing pitfalls. Content/DB sync and mail-data
 * import land in later PRs as additional legs. Every leg is idempotent: a
 * re-run (Retry) re-validates, skips domains that already exist, and relies on
 * enableEmailForDomain's own idempotency. Progress is persisted to the row's
 * `legs` jsonb after every step so the UI can poll and a restart resumes.
 *
 * NOTHING here touches the Plesk source — this is platform-side provisioning
 * driven by the read-only discovery snapshot.
 */

import { eq, and } from 'drizzle-orm';
import { pleskMigrations, domains as domainsTable, tenants, hostingPlans } from '../../db/schema.js';
import { createDomain } from '../domains/service.js';
import { enableEmailForDomain } from '../email-domains/service.js';
import { getTenantMailboxLimit, getTenantMailboxCount } from '../mailboxes/limit.js';
import { ApiError } from '../../shared/errors.js';
import { pleskSubscriptionSchema, createDomainSchema } from '@insula/api-contracts';
import type { PleskSubscription } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

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

  await db.update(pleskMigrations).set({ status: 'running', error: null, updatedAt: new Date() }).where(eq(pleskMigrations.id, migrationId));

  const tenantId = row.targetTenantId;
  if (!tenantId) {
    // Set at create under tenant-first mapping; defensive guard only.
    legs.preflight = { status: 'failed', startedAt: nowIso(), completedAt: nowIso(), error: 'migration has no target tenant' };
    await persistLegs(db, migrationId, legs);
    await db.update(pleskMigrations).set({ status: 'failed', error: 'migration has no target tenant', updatedAt: new Date() }).where(eq(pleskMigrations.id, migrationId));
    return;
  }

  // ── Leg 1: preflight (validate the mapped tenant + capacity-check) ──
  legs.preflight = { status: 'running', startedAt: nowIso() };
  await persistLegs(db, migrationId, legs);
  try {
    const pf = await preflightTenant(db, tenantId, snapshot);
    if (pf.problems.length > 0) {
      const msg = pf.problems.map((p) => p.message).join('; ');
      legs.preflight = {
        ...legs.preflight, status: 'failed', completedAt: nowIso(), detail: pf.detail,
        error: `the target tenant is under-sized for this subscription — ${msg}. Resize the tenant's plan (or set a per-tenant override) and retry.`,
      };
      await persistLegs(db, migrationId, legs);
      await db.update(pleskMigrations).set({ status: 'failed', error: `capacity preflight failed: ${msg}`, updatedAt: new Date() }).where(eq(pleskMigrations.id, migrationId));
      return; // under-sized tenant — fail visibly, nothing downstream
    }
    legs.preflight = { ...legs.preflight, status: 'completed', completedAt: nowIso(), detail: pf.detail };
    await persistLegs(db, migrationId, legs);
  } catch (err) {
    logger.error({ err, migrationId }, 'plesk migration: preflight leg failed');
    legs.preflight = { ...legs.preflight, status: 'failed', completedAt: nowIso(), error: errMessage(err) };
    await persistLegs(db, migrationId, legs);
    await db.update(pleskMigrations).set({ status: 'failed', error: `preflight failed: ${errMessage(err)}`, updatedAt: new Date() }).where(eq(pleskMigrations.id, migrationId));
    return;
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

// The platform sizes storage in GiB (plan/override numeric → k8s `<n>Gi`),
// so capacity math uses binary units, not decimal GB. Using decimal GB here
// would undercount a 50 GiB plan by ~7% and falsely reject correctly-sized
// tenants.
const MIB = 1_048_576;
const GIB = 1_073_741_824;

function fmtBytesBin(bytes: number): string {
  if (bytes <= 0) return '0 MiB';
  const gib = bytes / GIB;
  if (gib >= 1) return `${gib.toFixed(gib < 10 ? 1 : 0)} GiB`;
  return `${Math.max(1, Math.round(bytes / MIB))} MiB`;
}

export interface CapacityProblem {
  resource: 'mailboxes' | 'storage';
  needed: number;
  available: number;
  message: string;
}

/**
 * Pure capacity check: does the subscription fit the tenant's plan? Returns
 * one problem per under-sized resource (empty = fits). This is the heart of
 * the preflight — the operator-facing pitfalls (too many mailboxes, not
 * enough storage) surface here BEFORE any platform resource is created.
 */
export function checkCapacity(input: {
  mailboxesNeeded: number;
  mailboxesExisting: number;
  mailboxLimit: number;
  bytesNeeded: number;
  storageBytesAvailable: number;
}): CapacityProblem[] {
  const problems: CapacityProblem[] = [];
  const totalMailboxes = input.mailboxesExisting + input.mailboxesNeeded;
  if (totalMailboxes > input.mailboxLimit) {
    problems.push({
      resource: 'mailboxes',
      needed: totalMailboxes,
      available: input.mailboxLimit,
      message: `needs ${input.mailboxesNeeded} mailbox(es)${input.mailboxesExisting > 0 ? ` (plus ${input.mailboxesExisting} already on the tenant)` : ''} but the plan allows ${input.mailboxLimit}`,
    });
  }
  if (input.bytesNeeded > input.storageBytesAvailable) {
    problems.push({
      resource: 'storage',
      needed: input.bytesNeeded,
      available: input.storageBytesAvailable,
      message: `needs ~${fmtBytesBin(input.bytesNeeded)} of storage (mail + databases) but the plan allows ${fmtBytesBin(input.storageBytesAvailable)}`,
    });
  }
  return problems;
}

/**
 * Validate the mapped tenant and capacity-check the subscription against its
 * plan. Throws (caught by the orchestrator) if the tenant is gone / system /
 * unavailable; returns the capacity problems otherwise.
 */
async function preflightTenant(
  db: Database,
  tenantId: string,
  snapshot: PleskSubscription,
): Promise<{ problems: CapacityProblem[]; detail: string }> {
  const [tenant] = await db
    .select({ id: tenants.id, isSystem: tenants.isSystem, status: tenants.status, planId: tenants.planId, storageLimitOverride: tenants.storageLimitOverride })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) throw new ApiError('TENANT_NOT_FOUND', `target tenant '${tenantId}' no longer exists`, 404);
  if (tenant.isSystem) throw new ApiError('TENANT_IS_SYSTEM', 'the SYSTEM tenant cannot be a migration target', 400);
  // Only an ACTIVE (provisioned) tenant is a valid target: a 'pending' tenant
  // has no namespace yet (domains/email legs would fail downstream), and
  // 'suspended'/'archived' tenants must not receive new resources.
  if (tenant.status !== 'active') {
    throw new ApiError('TENANT_NOT_AVAILABLE', `target tenant is '${tenant.status}' — only an active, provisioned tenant can be a migration target`, 400);
  }

  const { limit: mailboxLimit } = await getTenantMailboxLimit(db, tenantId);
  const mailboxesExisting = await getTenantMailboxCount(db, tenantId);

  const [plan] = await db.select({ storageLimit: hostingPlans.storageLimit }).from(hostingPlans).where(eq(hostingPlans.id, tenant.planId));
  // storageLimit / override are GiB (numeric → k8s `<n>Gi`).
  const storageGib = Number(tenant.storageLimitOverride ?? plan?.storageLimit ?? 0);
  const storageBytesAvailable = storageGib * GIB;

  const mailboxesNeeded = snapshot.mailboxes.length;
  const dbBytes = snapshot.databases.reduce((sum, d) => sum + (d.sizeBytes ?? 0), 0);
  // Best-effort: covers mail + DB bytes (the discovery captures those). Vhost
  // content size and the tenant's already-used bytes are NOT counted — this is
  // a floor sanity-check, not the full picture; the operator owns final sizing.
  const bytesNeeded = (snapshot.mailBytes ?? 0) + dbBytes;

  const problems = checkCapacity({ mailboxesNeeded, mailboxesExisting, mailboxLimit, bytesNeeded, storageBytesAvailable });
  const detail = `${mailboxesNeeded} mailbox(es) (limit ${mailboxLimit}${mailboxesExisting > 0 ? `, ${mailboxesExisting} existing` : ''}), ~${fmtBytesBin(bytesNeeded)} mail+DB (storage ${storageGib} GiB)`;
  return { problems, detail };
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
      // enableEmailForDomain now THROWS (MAIL_SERVER_ERROR) when Stalwart
      // is configured but unreachable — the catch below surfaces that as a
      // failed item. A null stalwartDomainId can therefore only mean the
      // cluster is genuinely mail-less; migrating a subscription's
      // mailboxes onto a mail-less cluster is a real failure the operator
      // must see, so we fail the item rather than silently "completing" it.
      const ed = await enableEmailForDomain(db, tenantId, domainRow.id, { webmail_enabled: false }, encryptionKey());
      if (ed?.stalwartDomainId) {
        items.push({ name: dn, status: 'completed' });
      } else {
        items.push({ name: dn, status: 'failed', message: 'no Stalwart domain created — is a mail stack installed on this cluster?' });
      }
    } catch (err) {
      logger.warn({ err, domain: dn, tenantId }, 'plesk migration: email enable failed');
      items.push({ name: dn, status: 'failed', message: errMessage(err) });
    }
  }
  return items;
}
